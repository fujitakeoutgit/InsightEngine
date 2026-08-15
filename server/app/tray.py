"""The notification-area icon an installed copy runs behind.

Distinct from `tray/insight_tray.py`, which supervises the two *dev* servers
and knows about npm and port adoption. None of that applies here: a packaged
copy is one process serving one port, and the tray's whole job is to be the
window the app does not otherwise have — somewhere to click Open, reach the
data folder, ask for fresh cards, and quit.

The packaged build has no console at all, and this is what replaces it.

An earlier version shipped a console and hid it once the server answered. That
cannot work on Windows 11: the window the process owns is a
`PseudoConsoleWindow`, a ConPTY stub that is already invisible, while the
window you actually see belongs to conhost.exe or WindowsTerminal.exe — a
different process. `ShowWindow` on our own handle hides the stub and leaves the
terminal exactly where it was. So the executable is built windowed instead, and
everything the console used to carry moved here: progress into the icon's
tooltip, the account of what happened into a log file, and failures into a
message box, because a windowed process that dies quietly looks like one that
never started.
"""

from __future__ import annotations

import ctypes
import os
import subprocess
import sys
import threading
import webbrowser
from pathlib import Path
from typing import Any, Callable

from .config import settings

#: Set once the tray is running, so the launcher knows whether there is an icon
#: to reach the app by.
_running = threading.Event()

#: The live icon, for status updates.
_icon: Any = None


def alert(title: str, message: str) -> None:
    """A message box, for a failure with no console to print it to.

    The packaged build is windowed, so a fatal error that only printed would
    be a process that appeared to do nothing at all.
    """
    if not sys.platform.startswith("win"):
        return
    try:
        ctypes.windll.user32.MessageBoxW(0, message, title, 0x10)
    except Exception:  # noqa: BLE001 - the failure is already the message
        pass


def set_status(text: str) -> None:
    """What the icon says on hover. The only progress a windowed build has."""
    icon = _icon
    if icon is not None:
        try:
            icon.title = f"Insight Engine - {text}" if text else "Insight Engine"
        except Exception:  # noqa: BLE001 - a stale tooltip is not worth raising
            pass


def _open_folder(path: Path) -> None:
    """Show a folder in Explorer, creating it if the first run has not yet.

    `os.startfile` is Windows-only and the fallbacks are there so this module
    can be imported and reasoned about on a machine that is not — not because
    a packaged build runs anywhere else.
    """
    path.mkdir(parents=True, exist_ok=True)
    try:
        os.startfile(path)  # type: ignore[attr-defined]
    except AttributeError:
        opener = "open" if sys.platform == "darwin" else "xdg-open"
        subprocess.Popen([opener, str(path)])


def _open_file(path: Path) -> None:
    """Show a file in its default application, creating it if absent.

    An empty log is a better answer than an error box saying there is no log:
    "nothing has been written" is itself the information.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    path.touch(exist_ok=True)
    try:
        os.startfile(path)  # type: ignore[attr-defined]
    except AttributeError:
        opener = "open" if sys.platform == "darwin" else "xdg-open"
        subprocess.Popen([opener, str(path)])


def _rebuild_cards(url: str) -> None:
    """Ask the running server for fresh card data.

    Through the API rather than by calling the ingest directly: the server
    owns the mirror, and its refresh builds the new copy beside the old one
    and swaps it in only when it finishes. A second thread in this process
    doing its own ingest would be two writers and a half-written database.
    """
    try:
        import httpx

        httpx.post(f"{url}/api/sync/refresh", timeout=10.0)
    except Exception:  # noqa: BLE001 - the notification is the whole feature
        pass


def log_path() -> Path:
    return settings.data_dir / "insight-engine.log"


def start(url: str, on_quit: Callable[[], None], status: str = "") -> bool:
    """Put the icon in the notification area. False if it could not be done.

    Returns rather than raises: a missing tray is a smaller problem than no
    app. The launcher opens a browser in that case, so there is still a way in.
    """
    try:
        import pystray
        from pystray import MenuItem as Item

        from .icon import make_icon
    except Exception:  # noqa: BLE001 - no tray is a degraded mode, not a crash
        return False

    def quit_app(icon: Any) -> None:
        icon.stop()
        _running.clear()
        on_quit()

    try:
        icon = pystray.Icon(
            "insight-engine",
            icon=make_icon(),
            title="Insight Engine",
            menu=pystray.Menu(
                # Default: a plain left-click opens the app, which is what
                # clicking the icon of a thing you cannot see should do.
                Item("Open", lambda: webbrowser.open(url), default=True),
                Item("Open data folder", lambda: _open_folder(settings.data_dir)),
                Item("Rebuild card data", lambda: _rebuild_cards(url)),
                pystray.Menu.SEPARATOR,
                # There is no console in a packaged build, so the log is the
                # only account of what happened. It is one click away rather
                # than somewhere the reader has to be told to look.
                Item("Open log", lambda: _open_file(log_path())),
                Item("Quit", quit_app),
            ),
        )
    except Exception:  # noqa: BLE001
        return False

    global _icon
    _icon = icon
    thread = threading.Thread(target=icon.run, name="tray", daemon=True)
    thread.start()
    _running.set()
    if status:
        set_status(status)
    return True
