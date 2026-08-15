"""Insight Engine — system-tray controller for the local servers.

Runs on login and sits idle: the default state is *stopped*, so nothing is
listening until you ask for it.

Two Windows details drive the design:

* `npm run dev` reaches Vite through `cmd -> node -> cmd -> node`. Terminating
  the process we spawned orphans the great-grandchild that actually holds port
  5173, so shutdown walks the whole process tree.
* Servers may already be running from `start.ps1`. Rather than refuse to act or
  double-bind the ports, the tray adopts whatever owns 8787/5173 and can stop
  it too.
"""

from __future__ import annotations

import ctypes
import os
import subprocess
import sys
import traceback
from datetime import datetime
import threading
import time
import urllib.error
import urllib.request
import webbrowser
import winreg
from dataclasses import dataclass
from enum import Enum
from pathlib import Path

import psutil
import pystray
from PIL import Image, ImageDraw

APP_NAME = "Insight Engine"
RUN_KEY = r"Software\Microsoft\Windows\CurrentVersion\Run"

ROOT = Path(__file__).resolve().parent.parent
SERVER_DIR = ROOT / "server"
WEB_DIR = ROOT / "web"
VENV_PY = SERVER_DIR / ".venv" / "Scripts" / "python.exe"
LOG_DIR = ROOT / "data" / "logs"

API_PORT = 8787
WEB_PORT = 5173
WEB_URL = f"http://localhost:{WEB_PORT}"
HEALTH_URL = f"http://127.0.0.1:{API_PORT}/api/health"

STARTUP_TIMEOUT = 90        # seconds to wait for both ports before giving up
POLL_INTERVAL = 4.0         # health-check cadence once running

# Keep spawned consoles off the desktop.
CREATE_NO_WINDOW = 0x08000000

# Palette lifted from the web app's design tokens.
SPECTRUM = ((180, 160, 255), (110, 231, 214), (255, 178, 125))
GREY = ((90, 90, 100),)
AMBER = ((255, 207, 110),)
RED = ((255, 122, 133),)


class State(Enum):
    STOPPED = "Stopped"
    STARTING = "Starting…"
    RUNNING = "Running"
    STOPPING = "Stopping…"
    ERROR = "Error"


# --------------------------------------------------------------------------
# Icon
# --------------------------------------------------------------------------

def _lerp(a: tuple, b: tuple, t: float) -> tuple:
    return tuple(round(x + (y - x) * t) for x, y in zip(a, b))


def _sample(stops: tuple, t: float) -> tuple:
    """Color at position t across an arbitrary number of gradient stops."""
    if len(stops) == 1:
        return stops[0]
    span = 1 / (len(stops) - 1)
    index = min(int(t / span), len(stops) - 2)
    return _lerp(stops[index], stops[index + 1], (t - index * span) / span)


def make_icon(stops: tuple, hollow: bool = False, size: int = 64) -> Image.Image:
    """Draw a gradient disc. Supersampled 4x so the edge stays clean at 16px."""
    scale = 4
    big = size * scale
    image = Image.new("RGBA", (big, big), (0, 0, 0, 0))

    gradient = Image.new("RGBA", (big, big))
    pixels = gradient.load()
    for x in range(big):
        color = _sample(stops, x / max(1, big - 1)) + (255,)
        for y in range(big):
            pixels[x, y] = color

    mask = Image.new("L", (big, big), 0)
    draw = ImageDraw.Draw(mask)
    pad = int(big * 0.06)
    draw.ellipse((pad, pad, big - pad, big - pad), fill=255)
    if hollow:
        # A ring reads as "off" at tray size better than a dimmed disc.
        inset = int(big * 0.22)
        draw.ellipse((pad + inset, pad + inset, big - pad - inset, big - pad - inset), fill=0)

    image.paste(gradient, (0, 0), mask)
    return image.resize((size, size), Image.LANCZOS)


ICONS = {
    State.STOPPED: make_icon(GREY, hollow=True),
    State.STARTING: make_icon(AMBER),
    State.RUNNING: make_icon(SPECTRUM),
    State.STOPPING: make_icon(AMBER, hollow=True),
    State.ERROR: make_icon(RED),
}


# --------------------------------------------------------------------------
# Process helpers
# --------------------------------------------------------------------------

def pid_on_port(port: int) -> int | None:
    """PID of whatever is LISTENing on a port, or None."""
    try:
        for conn in psutil.net_connections(kind="tcp"):
            if conn.status == psutil.CONN_LISTEN and conn.laddr and conn.laddr.port == port:
                return conn.pid
    except (psutil.AccessDenied, OSError):
        # Fall back to a plain connect test: we lose the PID but still know
        # whether something is there.
        return None
    return None


def port_busy(port: int) -> bool:
    """True when anything is LISTENing on the port, on any interface.

    Both address families have to be tried. Vite binds ``::1`` on this machine
    while uvicorn binds ``127.0.0.1``, so an IPv4-only probe reports the web
    server as down -- and the tray would cheerfully start a second one.
    """
    if pid_on_port(port) is not None:
        return True

    import socket

    for family, address in ((socket.AF_INET, "127.0.0.1"), (socket.AF_INET6, "::1")):
        try:
            with socket.socket(family, socket.SOCK_STREAM) as sock:
                sock.settimeout(0.35)
                if sock.connect_ex((address, port)) == 0:
                    return True
        except OSError:
            continue
    return False


def kill_tree(pid: int | None, timeout: float = 8.0) -> None:
    """Terminate a process and every descendant, children first."""
    if not pid:
        return
    try:
        parent = psutil.Process(pid)
    except psutil.NoSuchProcess:
        return

    try:
        family = parent.children(recursive=True) + [parent]
    except psutil.NoSuchProcess:
        return

    for proc in family:
        try:
            proc.terminate()
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            pass

    _, alive = psutil.wait_procs(family, timeout=timeout)
    for proc in alive:
        try:
            proc.kill()
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            pass


def wait_for(check, timeout: float, interval: float = 0.5) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if check():
            return True
        time.sleep(interval)
    return False


# --------------------------------------------------------------------------
# Autostart
# --------------------------------------------------------------------------

def _startup_command() -> str:
    pythonw = VENV_PY.with_name("pythonw.exe")
    runtime = pythonw if pythonw.exists() else VENV_PY
    return f'"{runtime}" "{Path(__file__).resolve()}"'


def autostart_enabled() -> bool:
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, RUN_KEY) as key:
            return winreg.QueryValueEx(key, APP_NAME)[0] == _startup_command()
    except FileNotFoundError:
        return False
    except OSError:
        return False


def set_autostart(enabled: bool) -> None:
    with winreg.OpenKey(winreg.HKEY_CURRENT_USER, RUN_KEY, 0, winreg.KEY_SET_VALUE) as key:
        if enabled:
            winreg.SetValueEx(key, APP_NAME, 0, winreg.REG_SZ, _startup_command())
        else:
            try:
                winreg.DeleteValue(key, APP_NAME)
            except FileNotFoundError:
                pass


def notify(title: str, message: str) -> None:
    """Best-effort balloon; never let a notification failure break the app."""
    try:
        TRAY.icon.notify(message, title)
    except Exception:
        pass


# --------------------------------------------------------------------------
# Controller
# --------------------------------------------------------------------------

@dataclass
class Child:
    name: str
    process: subprocess.Popen | None = None
    log: object = None


class TrayApp:
    def __init__(self) -> None:
        self.state = State.STOPPED
        self.detail = ""
        self.api = Child("api")
        self.web = Child("web")
        self.lock = threading.Lock()
        self.icon = pystray.Icon(APP_NAME, ICONS[State.STOPPED], APP_NAME, self._menu())
        self._stop_event = threading.Event()

    # -- state ---------------------------------------------------------

    def set_state(self, state: State, detail: str = "") -> None:
        self.state = state
        self.detail = detail
        self.icon.icon = ICONS[state]
        self.icon.title = f"{APP_NAME} — {state.value}{f' · {detail}' if detail else ''}"
        self.icon.update_menu()

    def _status_line(self, _item=None) -> str:
        if self.detail:
            return f"{self.state.value} · {self.detail}"
        if self.state is State.RUNNING:
            return f"Running · :{API_PORT} + :{WEB_PORT}"
        return self.state.value

    # -- menu ----------------------------------------------------------

    def _menu(self) -> pystray.Menu:
        idle = lambda _: self.state in (State.STOPPED, State.ERROR)
        live = lambda _: self.state in (State.RUNNING, State.STARTING, State.ERROR)
        return pystray.Menu(
            pystray.MenuItem(self._status_line, None, enabled=False),
            pystray.Menu.SEPARATOR,
            pystray.MenuItem(
                "Open Insight Engine", self.on_open,
                default=True, enabled=lambda _: self.state is State.RUNNING,
            ),
            pystray.MenuItem("Start server", self.on_start, enabled=idle),
            pystray.MenuItem("Stop server", self.on_stop, enabled=live),
            pystray.Menu.SEPARATOR,
            pystray.MenuItem(
                "Start with Windows", self.on_toggle_autostart,
                checked=lambda _: autostart_enabled(),
            ),
            pystray.MenuItem("Open logs", self.on_logs),
            pystray.Menu.SEPARATOR,
            pystray.MenuItem("Quit", self.on_quit),
        )

    # -- actions -------------------------------------------------------

    def on_open(self, *_):
        if self.state is State.RUNNING:
            webbrowser.open(WEB_URL)

    def on_start(self, *_):
        threading.Thread(target=self._start, daemon=True).start()

    def on_stop(self, *_):
        threading.Thread(target=self._stop, daemon=True).start()

    def on_logs(self, *_):
        LOG_DIR.mkdir(parents=True, exist_ok=True)
        os.startfile(LOG_DIR)

    def on_toggle_autostart(self, *_):
        set_autostart(not autostart_enabled())
        self.icon.update_menu()

    def on_quit(self, *_):
        # Never leave orphaned node/uvicorn processes behind.
        self._stop_event.set()
        if self.state in (State.RUNNING, State.STARTING, State.ERROR):
            self._stop(announce=False)
        self.icon.stop()

    # -- lifecycle -----------------------------------------------------

    def _spawn(self, child: Child, args: list[str], cwd: Path) -> None:
        LOG_DIR.mkdir(parents=True, exist_ok=True)
        child.log = open(LOG_DIR / f"{child.name}.log", "w", encoding="utf-8", buffering=1)
        child.process = subprocess.Popen(
            args, cwd=str(cwd),
            stdout=child.log, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
            creationflags=CREATE_NO_WINDOW,
        )

    def _start(self) -> None:
        if not self.lock.acquire(blocking=False):
            return
        try:
            if not VENV_PY.exists():
                self.set_state(State.ERROR, "virtualenv missing")
                notify(APP_NAME, "server\\.venv not found. Run the install steps in the README.")
                return
            if not (WEB_DIR / "node_modules").exists():
                self.set_state(State.ERROR, "node_modules missing")
                notify(APP_NAME, "Run: npm --prefix web install")
                return

            self.set_state(State.STARTING)

            if not port_busy(API_PORT):
                self._spawn(self.api, [
                    str(VENV_PY), "-m", "uvicorn", "app.main:app",
                    "--host", "127.0.0.1", "--port", str(API_PORT),
                ], SERVER_DIR)

            if not port_busy(WEB_PORT):
                npm = os.environ.get("COMSPEC", "cmd.exe")
                self._spawn(self.web, [npm, "/c", "npm.cmd", "run", "dev"], WEB_DIR)

            ready = wait_for(
                lambda: port_busy(API_PORT) and port_busy(WEB_PORT), STARTUP_TIMEOUT
            )
            if not ready:
                self.set_state(State.ERROR, "did not start")
                notify(APP_NAME, "Servers did not come up in time. Check the logs.")
                return

            self.set_state(State.RUNNING)
            notify(APP_NAME, f"Running at {WEB_URL}")
        finally:
            self.lock.release()

    def _stop(self, announce: bool = True) -> None:
        if not self.lock.acquire(blocking=False):
            return
        try:
            self.set_state(State.STOPPING)

            for child in (self.api, self.web):
                if child.process and child.process.poll() is None:
                    kill_tree(child.process.pid)
                child.process = None
                if child.log:
                    child.log.close()
                    child.log = None

            # Anything still holding a port was started outside the tray
            # (start.ps1, a terminal) -- clear it too so Start works next time.
            for port in (API_PORT, WEB_PORT):
                if port_busy(port):
                    kill_tree(pid_on_port(port))

            stopped = wait_for(
                lambda: not port_busy(API_PORT) and not port_busy(WEB_PORT), 12
            )
            self.set_state(State.STOPPED if stopped else State.ERROR,
                           "" if stopped else "port still held")
            if announce and stopped:
                notify(APP_NAME, "Servers stopped.")
        finally:
            self.lock.release()

    # -- monitor -------------------------------------------------------

    def _monitor(self) -> None:
        """Keep the icon honest about what is actually listening."""
        while not self._stop_event.wait(POLL_INTERVAL):
            if self.lock.locked():
                continue
            api_up, web_up = port_busy(API_PORT), port_busy(WEB_PORT)

            if self.state is State.RUNNING and not (api_up and web_up):
                which = "api" if not api_up else "web"
                self.set_state(State.ERROR, f"{which} exited")
                notify(APP_NAME, f"The {which} server stopped unexpectedly.")
            elif self.state is State.STOPPED and api_up and web_up:
                # Adopted: something else started the stack.
                self.set_state(State.RUNNING, "started elsewhere")

    def run(self) -> None:
        # Reflect reality at launch rather than assuming a clean machine, but
        # never start anything on our own: stopped is the default.
        if port_busy(API_PORT) and port_busy(WEB_PORT):
            self.set_state(State.RUNNING, "started elsewhere")

        threading.Thread(target=self._monitor, daemon=True).start()
        self.icon.run()


# use_last_error is required: ctypes only captures GetLastError per-call when
# the library is opened this way. Reading windll.kernel32.GetLastError()
# separately returns a value later ctypes calls have already clobbered, which
# silently defeats the check and lets a second icon appear.
_kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
ERROR_ALREADY_EXISTS = 183

# Held for the process lifetime; closing the handle would release the mutex.
_mutex_handle: int | None = None


def single_instance() -> bool:
    """A named mutex keeps login + manual launch from stacking two icons."""
    global _mutex_handle
    _mutex_handle = _kernel32.CreateMutexW(None, False, "InsightEnigmaTray")
    if not _mutex_handle:
        return True  # cannot determine; better to run than to refuse
    return ctypes.get_last_error() != ERROR_ALREADY_EXISTS


TRAY: TrayApp


def _startup_log(message: str) -> None:
    """Record why a launch ended, since under pythonw there is nowhere else.

    A tray app that fails at login fails invisibly: no console, no window, and
    an exit code nobody sees. Without this, "it didn't start" is unfalsifiable
    -- which is exactly the position this got into once.
    """
    try:
        LOG_DIR.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now().isoformat(timespec="seconds")
        with open(LOG_DIR / "tray.log", "a", encoding="utf-8") as fh:
            fh.write(f"{stamp} {message}\n")
    except Exception:
        pass  # logging must never be the reason the app dies


def main() -> int:
    global TRAY
    _startup_log(f"launch pid={os.getpid()} exe={sys.executable}")
    if not single_instance():
        _startup_log("exit: another instance already holds the mutex")
        return 0
    try:
        TRAY = TrayApp()
        TRAY.run()
    except Exception:
        _startup_log("crash:\n" + traceback.format_exc())
        raise
    _startup_log("exit: clean shutdown")
    return 0


if __name__ == "__main__":
    sys.exit(main())
