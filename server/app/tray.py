"""The notification-area icon an installed copy runs behind.

Distinct from `tray/insight_tray.py`, which supervises the two *dev* servers
and knows about npm and port adoption. None of that applies here: a packaged
copy is one process serving one port, and the tray's whole job is to be the
window the app does not otherwise have — somewhere to click Open, reach the
data folder, ask for fresh cards, and quit.

The console is the reason this exists. A frozen build launched from the Start
Menu owns a console window, and that window is the only evidence the app is
running — so closing it is how people stop the app, and looking at it is how
they know the first run has not hung. Both are true only until the server is
up. After that the console is a black rectangle in the taskbar that says
nothing and cannot be minimised out of the way without also being the thing
you need to find again. So it is hidden once the server answers, and the tray
takes over the two jobs it was doing.

If anything fails before that point the console stays exactly where it is,
with the error still on it.
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

#: Set once the tray is running, so the launcher knows whether hiding the
#: console would leave the app with no way to be reached.
_running = threading.Event()

SW_HIDE = 0
SW_SHOW = 5


def _console_window() -> int:
    """The handle of our own console, or 0 when there is not one.

    Zero is the normal answer for a build compiled without a console or a
    process whose output has been redirected — both of which are cases where
    there is nothing to hide and nothing to worry about.
    """
    if not sys.platform.startswith("win"):
        return 0
    try:
        return int(ctypes.windll.kernel32.GetConsoleWindow())
    except Exception:  # noqa: BLE001 - absence of a console is not an error
        return 0


def hide_console() -> bool:
    """Hide our console window. False when there was nothing to hide.

    Deliberately refuses while the tray is not running. Hiding the only window
    of a process with no icon anywhere leaves something that can be stopped
    solely through Task Manager, which is worse than a stray console.
    """
    if not _running.is_set():
        return False
    hwnd = _console_window()
    if not hwnd:
        return False
    ctypes.windll.user32.ShowWindow(hwnd, SW_HIDE)
    return True


def show_console() -> None:
    hwnd = _console_window()
    if hwnd:
        ctypes.windll.user32.ShowWindow(hwnd, SW_SHOW)
        ctypes.windll.user32.SetForegroundWindow(hwnd)


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


def start(url: str, on_quit: Callable[[], None]) -> bool:
    """Put the icon in the notification area. False if it could not be done.

    Returns rather than raises: a missing tray is a smaller problem than no
    app, so the launcher carries on with a visible console instead.
    """
    try:
        import pystray
        from pystray import MenuItem as Item

        from .icon import make_icon
    except Exception:  # noqa: BLE001 - no tray is a degraded mode, not a crash
        return False

    def quit_app(icon: Any) -> None:
        # The console comes back before the process ends. Otherwise a build
        # that fails to exit cleanly leaves nothing on screen at all.
        show_console()
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
                Item("Show console", show_console),
                Item("Quit", quit_app),
            ),
        )
    except Exception:  # noqa: BLE001
        return False

    thread = threading.Thread(target=icon.run, name="tray", daemon=True)
    thread.start()
    _running.set()
    return True
