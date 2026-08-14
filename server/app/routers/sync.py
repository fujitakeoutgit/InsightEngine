"""Card data sync: is the mirror current, and refreshing it if not.

The refresh itself already existed and is already idempotent — `bulk.refresh`
compares Scryfall's per-file `updated_at` against what was ingested and skips
anything unchanged. What was missing was anything that ever called it again
after the first build, and any way to see how old your cards are. A machine
installed today would still be on today's card data in a year.

A refresh never touches the live mirror. It copies it, fills the copy in, and
swaps the finished file into place — so a download that dies halfway costs a
temporary file and nothing else. The copy is what keeps the refresh
*incremental*: the stamps of what was already ingested come with it, so a run
where only one bulk file has moved re-ingests only that one.

**The check is automatic; the download still is not.** Startup asks Scryfall
what the current stamps are — a few KB — so Settings can say there is an update
without you going to look. Fetching several hundred megabytes unbidden is a
different matter, and remains something you press a button for.
"""

from __future__ import annotations

import os
import shutil
import threading
import time
from pathlib import Path
from typing import Any

import httpx
from fastapi import APIRouter

from .. import bulk
from ..config import settings
from ..db import connect_mirror, get_meta, get_mirror_meta, set_meta
from ..state import state

router = APIRouter(prefix="/api/sync", tags=["sync"])

# Set while a refresh runs, so a second request joins the first rather than
# starting a competing download of the same quarter-gigabyte.
_running = threading.Lock()
_progress: dict[str, Any] = {"running": False, "started_at": None, "error": None, "log": []}


def _note(line: str) -> None:
    _progress["log"] = [*_progress["log"][-40:], line]


def _available() -> dict[str, Any]:
    """What Scryfall is offering right now, per wanted file."""
    with httpx.Client(timeout=20.0, follow_redirects=True) as client:
        manifest = bulk.fetch_manifest(client)
    return {
        kind: manifest[kind]["updated_at"]
        for kind in bulk.WANTED_BULK
        if kind in manifest
    }


def _status(remote: dict[str, str] | None) -> dict[str, Any]:
    conn = state.conn
    if conn is None:
        return {"ready": False}

    files = []
    stale = False
    for kind in bulk.WANTED_BULK:
        ingested = get_mirror_meta(conn, f"ingest:{kind}")
        latest = (remote or {}).get(kind)
        behind = bool(latest and ingested and latest != ingested)
        # Never ingested at all counts as behind, but only once we know there
        # is something to ingest.
        if latest and not ingested:
            behind = True
        stale = stale or behind
        files.append({"kind": kind, "ingested": ingested, "available": latest, "behind": behind})

    cards = conn.execute("SELECT COUNT(*) AS n FROM cards").fetchone()["n"]
    return {
        "ready": True,
        "built_at": get_mirror_meta(conn, "built_at"),
        "checked_at": get_meta(conn, "sync:checked_at"),
        "cards": cards,
        "files": files,
        "update_available": stale,
        "running": _progress["running"],
        "error": _progress["error"],
    }


def check_now() -> dict[str, Any]:
    """Ask Scryfall what it has, and remember when we asked.

    Failure here is not an error worth surfacing: being unable to reach
    Scryfall means the answer is unknown, not that anything is wrong with the
    mirror you already have.
    """
    remote: dict[str, str] | None = None
    try:
        remote = _available()
        if state.conn is not None:
            set_meta(state.conn, "sync:checked_at", time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()))
            for kind, stamp in remote.items():
                set_meta(state.conn, f"remote:{kind}", stamp)
    except Exception:  # noqa: BLE001 - offline is a normal state, not a fault
        if state.conn is not None:
            remote = {
                kind: stamp
                for kind in bulk.WANTED_BULK
                if (stamp := get_meta(state.conn, f"remote:{kind}"))
            }
    return _status(remote)


def _build_path() -> Path:
    return settings.mirror_path.with_name(settings.mirror_path.stem + ".build.sqlite3")


def _discard(path: Path) -> None:
    """Remove a database and the WAL sidecars that belong to it."""
    for suffix in ("", "-wal", "-shm"):
        stray = path.with_name(path.name + suffix)
        if stray.exists():
            stray.unlink()


def _replace_with_retry(source: Path, target: Path, attempts: int = 10) -> None:
    """Rename over the target, waiting briefly if Windows says it is in use.

    Every attachment of the mirror is a handle on the file, and a rename cannot
    cross one. The connections that matter are dropped before this runs, but a
    request already in flight can still be holding the database for the few
    milliseconds it takes to finish, and an antivirus scanner can hold it for
    longer than that. Retrying for a second or so turns a race that would
    discard a completed build into a pause nobody notices.
    """
    last: OSError | None = None
    for attempt in range(attempts):
        try:
            os.replace(source, target)
            return
        except OSError as exc:
            last = exc
            time.sleep(0.1 * (attempt + 1))
    raise last if last else OSError("could not replace the mirror")


def _run_refresh() -> None:
    _progress.update({"running": True, "started_at": time.time(), "error": None, "log": []})
    build = _build_path()
    try:
        _discard(build)
        if settings.mirror_path.exists():
            # Copied, not started from empty, so the ingest stamps travel with
            # it: a refresh where one bulk file has moved re-ingests one file
            # rather than all three.
            _note("copying the current mirror")
            shutil.copy2(settings.mirror_path, build)

        _note("building")
        bulk.refresh(db=build)

        _note("swapping in the new mirror")
        conn = connect_mirror(build)
        conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        conn.close()
        _discard(build.with_name(build.name + "-wal"))

        # The live connection has the old file attached, and Windows will not
        # rename over an open handle. Detached and remade around the swap, so
        # the window with no cards is a few milliseconds rather than the length
        # of a download.
        state.detach_for_swap()
        try:
            _discard(settings.mirror_path)
            _replace_with_retry(build, settings.mirror_path)
        finally:
            state.reattach_after_swap()
        _note("done")
    except Exception as exc:  # noqa: BLE001 - reported to the caller, not raised into a thread
        _progress["error"] = str(exc)
        _note(f"failed: {exc}")
        # A failed build is a file. The mirror you had is still the mirror you
        # have, which is the whole point of building beside it.
        try:
            _discard(build)
            _note("discarded the partial build; your existing cards are untouched")
        except OSError:
            pass
    finally:
        _progress["running"] = False
        _running.release()


@router.get("/status")
async def status() -> dict[str, Any]:
    """Cheap: reads what the last check recorded, and touches no network."""
    conn = state.conn
    remembered = None
    if conn is not None:
        remembered = {
            kind: stamp
            for kind in bulk.WANTED_BULK
            if (stamp := get_meta(conn, f"remote:{kind}"))
        }
    return _status(remembered)


@router.post("/check")
async def check() -> dict[str, Any]:
    """Ask Scryfall now rather than waiting for the next start."""
    return check_now()


@router.post("/refresh")
async def start_refresh() -> dict[str, Any]:
    if not _running.acquire(blocking=False):
        return {"started": False, "reason": "already running", **_status(None)}
    threading.Thread(target=_run_refresh, name="card-refresh", daemon=True).start()
    return {"started": True, "running": True}


@router.get("/progress")
async def progress() -> dict[str, Any]:
    return {
        "running": _progress["running"],
        "error": _progress["error"],
        "log": _progress["log"][-12:],
        "data_dir": str(settings.bulk_dir),
    }
