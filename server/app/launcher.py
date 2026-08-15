"""The entry point an installed copy runs.

A source checkout starts two processes from `start.ps1` and expects you to
have already built the mirror. An installed copy cannot expect anything: it is
one executable, launched from a Start Menu shortcut by somebody who has never
seen this repository.

So this does the three things that script and that knowledge used to cover --
make sure there is card data, serve the interface and the API from one port,
and open a browser at it -- and it says what it is doing while it does them,
because the first run downloads about 180MB and silence for four minutes reads
as a hang.
"""

from __future__ import annotations

import sys
import threading
import time
import webbrowser

from . import tray
from .config import settings


def _say(line: str = "") -> None:
    print(line, flush=True)


def _hold() -> None:
    """Keep a failure on screen when there is someone to read it.

    A shortcut-launched copy owns its console window, and that window closes
    the instant this returns -- taking the explanation with it. But there is
    not always a console: redirect the output and `input` raises EOFError,
    which is a traceback on top of whatever went wrong, and was the first
    thing the packaged build did.
    """
    _say()
    try:
        input("  Press Enter to close. ")
    except (EOFError, OSError):
        pass


def _mirror_present() -> bool:
    """Whether there is a usable mirror already.

    Checked by opening it rather than by looking for the file: an interrupted
    first run leaves a database that exists and has no cards in it, and
    treating that as done is how someone ends up with an app that starts
    cleanly and finds nothing.
    """
    if not settings.db_path.exists():
        return False
    try:
        from .db import connect

        conn = connect()
        try:
            row = conn.execute("SELECT 1 FROM cards LIMIT 1").fetchone()
            return bool(row)
        finally:
            conn.close()
    except Exception:
        return False


def ensure_mirror() -> bool:
    """Build the card mirror if it is missing. Returns False if it failed."""
    if _mirror_present():
        return True

    _say()
    _say("  First run: downloading the card database from Scryfall.")
    # Roughly 35MB over the wire now that Scryfall serves gzipped JSONL; the
    # minutes go on parsing and indexing it, not on the download.
    _say("  About 35MB, and a few minutes to index. This happens once.")
    _say()

    try:
        from .bulk import main as build_mirror

        code = build_mirror()
    except KeyboardInterrupt:
        _say()
        _say("  Cancelled. Run Insight Engine again to resume -- the parts already")
        _say("  downloaded are kept.")
        return False
    except Exception as exc:  # noqa: BLE001 - last line before a blank window
        _say()
        _say(f"  Could not build the card database: {exc}")
        _say("  Check your internet connection and start Insight Engine again.")
        return False

    if code != 0 or not _mirror_present():
        _say()
        _say("  The card database did not finish building.")
        _say("  Start Insight Engine again to resume.")
        return False

    _say()
    _say("  Card database ready.")
    return True


def _await_server(url: str, timeout: float = 30.0) -> bool:
    """Wait until the server answers. False if it never did.

    Polling rather than a fixed sleep: the port opens only after the ingest on
    a first run, and anything that waits a fixed time either races that or
    wastes the wait on every launch afterwards.
    """
    import httpx

    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            httpx.get(f"{url}/api/health", timeout=1.0)
            return True
        except Exception:  # noqa: BLE001 - not up yet is the expected case
            time.sleep(0.4)
    return False


def _settle(url: str, opened_tray: bool) -> None:
    """Once the server answers, get out of the way.

    The console has done its two jobs by now -- showing the first run was not
    hung, and being somewhere to read an error -- and from here it is a black
    rectangle that cannot be closed without stopping the app. The tray takes
    over both, so the console goes.

    Nothing is opened automatically. A launch is not a request to be shown
    something; the icon is there and Open is one click away. Without a tray
    there would be no way to reach the app at all, so that case still opens a
    browser rather than leaving a running server nobody can find.
    """
    if not _await_server(url):
        return
    if opened_tray:
        tray.hide_console()
    else:
        webbrowser.open(url)


def main() -> int:
    _say()
    _say("  INSIGHT ENGINE")
    _say("  Magic: The Gathering search. Card data from Scryfall.")
    _say()
    _say(f"  Data folder: {settings.data_dir}")

    if not ensure_mirror():
        _hold()
        return 1

    url = f"http://{settings.host}:{settings.port}"
    _say()
    _say(f"  Serving {url}")
    _say()

    import uvicorn

    from .main import app

    # The app object rather than an import string: a frozen build has no
    # module path for uvicorn to re-import, and reload/workers are meaningless
    # here anyway.
    #
    # A Server rather than uvicorn.run(), because Quit has to be able to stop
    # it: run() owns the signal handlers and returns only when the process is
    # already on its way out, which is too late to be a menu item.
    config = uvicorn.Config(app, host=settings.host, port=settings.port, log_level="warning")
    server = uvicorn.Server(config)

    opened_tray = tray.start(url, on_quit=lambda: setattr(server, "should_exit", True))
    if opened_tray:
        _say("  Insight Engine is in the notification area. This window will close.")
    threading.Thread(target=_settle, args=(url, opened_tray), daemon=True).start()

    server.run()
    return 0


if __name__ == "__main__":
    sys.exit(main())
