"""The entry point an installed copy runs.

A source checkout starts two processes from `start.ps1` and expects you to
have already built the mirror. An installed copy cannot expect anything: it is
one executable, launched from a Start Menu shortcut by somebody who has never
seen this repository.

So this does what that script and that knowledge used to cover: make sure
there is card data, and serve the interface and the API from one port.

It is windowed, with no console. Everything the console used to carry goes
somewhere it can still be found -- the running account into a log file beside
the database, progress onto the tray icon's tooltip, and a fatal error into a
message box. The first run downloads and indexes for a few minutes, and a
windowed process doing that silently is indistinguishable from one that has
died, so the tray comes up first and says what is happening.
"""

from __future__ import annotations

import os
import sys
import threading
import time
import webbrowser

from . import tray
from .config import settings


#: True when this build was started with a real console, so `_say` can echo
#: there as well as to the log. Captured before the streams are redirected.
_CONSOLE = sys.stdout is not None


def _attach_streams() -> None:
    """Give a windowed build the stdout and stderr other libraries assume.

    A `--noconsole` executable has `sys.stdout is None`, and anything reaching
    for it fails. uvicorn is the one that matters: its default logging config
    declares a StreamHandler on stdout, and configuring that against None
    raises "Unable to configure formatter 'default'" before the server ever
    starts. The packaged build died exactly there, in a message box, with the
    log stopping four lines in.

    Pointing both at the log file fixes every such caller at once, and puts
    their output somewhere a person can actually read it.
    """
    if sys.stdout is not None and sys.stderr is not None:
        return
    try:
        path = tray.log_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        handle = path.open("a", encoding="utf-8", buffering=1)
    except Exception:  # noqa: BLE001 - discard rather than die
        handle = open(os.devnull, "w", encoding="utf-8")  # noqa: SIM115
    if sys.stdout is None:
        sys.stdout = handle
    if sys.stderr is None:
        sys.stderr = handle


def _say(line: str = "") -> None:
    """Write to the log, and echo to a console if this build has a real one."""
    if _CONSOLE:
        try:
            print(line, flush=True)
        except Exception:  # noqa: BLE001
            pass
    try:
        path = tray.log_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a", encoding="utf-8") as handle:
            handle.write(time.strftime("%Y-%m-%d %H:%M:%S") + "  " + line + "\n")
    except Exception:  # noqa: BLE001 - logging is not worth failing over
        pass


def _fail(message: str) -> None:
    """Report a failure that ends the run.

    A windowed process that exits quietly is indistinguishable from one that
    never started, so this is a message box rather than a line nobody sees.
    The log keeps the detail.
    """
    _say(f"  {message}")
    tray.alert("Insight Engine", message + "\n\nThe log is in:\n" + str(tray.log_path()))


def _mirror_present() -> bool:
    """Whether there are cards to search.

    Checked by opening the mirror rather than by looking for the file: an
    interrupted first run leaves a database that exists and has no cards in
    it, and treating that as done is how someone ends up with an app that
    starts cleanly and finds nothing.

    The *mirror*, specifically. This used to test `db_path` -- the user
    database, which holds decks and is created when the server first starts.
    On a fresh install that file does not exist yet: the ingest writes only the
    mirror. So the guard returned False on its first line however well the
    download had gone, and a first run that had just indexed 38,626 cards
    reported "The card database did not finish building" and gave up. It was
    invisible on any machine that had run the app before, because the user
    database was already there.
    """
    if not settings.mirror_path.exists():
        return False
    try:
        from .db import connect_mirror

        conn = connect_mirror()
        try:
            return bool(conn.execute("SELECT 1 FROM cards LIMIT 1").fetchone())
        finally:
            conn.close()
    except Exception:  # noqa: BLE001 - unreadable is indistinguishable from absent
        return False


def _seed_source() -> "Path | None":
    """The starter mirror shipped inside the build, if there is one."""
    from pathlib import Path

    roots = []
    bundled = getattr(sys, "_MEIPASS", None)
    if bundled:
        roots.append(Path(bundled))
    # A source checkout, so the same path can be exercised without freezing.
    roots.append(Path(__file__).resolve().parent.parent.parent / "packaging")
    for root in roots:
        candidate = root / "seed-mirror.sqlite3"
        if candidate.exists():
            return candidate
    return None


def _plant_seed() -> bool:
    """Put the shipped starter mirror in place. False if there is none.

    A fresh install used to be unusable until 175MB had been downloaded and
    indexed, and if that failed for any reason -- a flaky connection, a proxy,
    an antivirus holding the file -- the app opened on "the card database did
    not finish building" and offered nothing else. A few thousand cards ship
    with the build so that the first launch is a working app, and the full
    mirror becomes something that happens in the background.

    Copied rather than opened in place: the bundle is read-only, and the
    mirror is written to constantly.
    """
    import shutil

    source = _seed_source()
    if source is None:
        return False
    try:
        settings.mirror_path.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, settings.mirror_path)
    except Exception as exc:  # noqa: BLE001 - fall through to the full build
        _say(f"  Could not place the starter card data: {exc}")
        return False
    _say("  Starter card data in place.")
    return True


def mirror_is_seed() -> bool:
    """Whether what we have is the shipped starter rather than the real thing."""
    try:
        from .db import connect_mirror, get_meta

        conn = connect_mirror()
        try:
            return get_meta(conn, "mirror:seed") == "1"
        finally:
            conn.close()
    except Exception:  # noqa: BLE001
        return False


def ensure_mirror() -> bool:
    """Make sure there are cards to search. Returns False if there are none.

    Three outcomes, in the order they are tried: what is already there, the
    starter mirror shipped with the build, and finally a full download. The
    download only blocks a first run on an install that shipped without a
    seed.
    """
    if _mirror_present():
        return True

    if _plant_seed() and _mirror_present():
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
    """Once the server answers, say so on the icon.

    Nothing is opened automatically. A launch is not a request to be shown
    something; the icon is there and Open is one click away. Without a tray
    there would be no way to reach the app at all, so that case still opens a
    browser rather than leaving a running server nobody can find.
    """
    if not _await_server(url):
        return

    # A seeded install has a few thousand cards, not the pool. Ask the server
    # to fetch the rest, through the same endpoint the tray's Rebuild uses --
    # it builds beside what is there and swaps only when it finishes, so the
    # app stays usable and a failed download costs the starter set nothing.
    if mirror_is_seed():
        tray.set_status("filling in the full card pool")
        _say("  Starter card data in use; fetching the full pool in the background.")
        try:
            import httpx

            httpx.post(f"{url}/api/sync/refresh", timeout=10.0)
        except Exception as exc:  # noqa: BLE001 - the starter set still works
            _say(f"  Could not start the background card download: {exc}")
            tray.set_status("starter cards only - use Rebuild card data")
        return

    tray.set_status("ready")
    if not opened_tray:
        # No icon means no way in, so this is the one case that opens a
        # browser. With a tray, a launch is not a request to be shown
        # something -- the icon is there and Open is one click away.
        webbrowser.open(url)


def main() -> int:
    # Before anything imports uvicorn.
    _attach_streams()
    _say()
    _say("  INSIGHT ENGINE")
    _say("  Magic: The Gathering search. Card data from Scryfall.")
    _say(f"  Data folder: {settings.data_dir}")

    url = f"http://{settings.host}:{settings.port}"

    import uvicorn

    from .main import app

    config = uvicorn.Config(app, host=settings.host, port=settings.port, log_level="warning")
    server = uvicorn.Server(config)

    # The icon comes up before the first-run download, not after it. Indexing
    # takes minutes, and a windowed process doing that with nothing on screen
    # is a process that looks like it failed to start.
    opened_tray = tray.start(
        url,
        on_quit=lambda: setattr(server, "should_exit", True),
        status="starting",
    )

    if not _mirror_present():
        tray.set_status("downloading card data - this happens once")
    if not ensure_mirror():
        _fail("The card database did not finish building. Start Insight Engine again to resume.")
        return 1

    _say(f"  Serving {url}")

    # The app object rather than an import string: a frozen build has no
    # module path for uvicorn to re-import, and reload/workers are meaningless
    # here anyway. A Server rather than uvicorn.run(), because Quit has to be
    # able to stop it: run() owns the signal handlers and returns only when the
    # process is already on its way out, which is too late to be a menu item.
    threading.Thread(target=_settle, args=(url, opened_tray), daemon=True).start()

    if not opened_tray:
        _say("  No tray icon; opening a browser instead.")

    server.run()
    return 0


if __name__ == "__main__":
    sys.exit(main())
