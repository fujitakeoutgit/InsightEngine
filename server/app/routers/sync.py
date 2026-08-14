"""Card data sync: is the mirror current, and refreshing it if not.

The refresh itself already existed and is already idempotent — `bulk.refresh`
compares Scryfall's per-file `updated_at` against what was ingested and skips
anything unchanged. What was missing was anything that ever called it again
after the first build, and any way to see how old your cards are. A machine
installed today would still be on today's card data in a year.

**The check is automatic; the download is not.** On startup this asks Scryfall
what the current stamps are and records whether they have moved — a few KB, and
it means Settings can say "there is an update" without you going to look. It
deliberately stops short of fetching the data, because ingest truncates `cards`
and refills it in place: a refresh that dies halfway leaves the app with no
cards at all. Doing that unattended, on startup, to someone who did not ask, is
not a trade worth making until that is fixed. See D2 in OPEN-ITEMS.
"""

from __future__ import annotations

import threading
import time
from typing import Any

import httpx
from fastapi import APIRouter

from .. import bulk
from ..config import settings
from ..db import get_meta, set_meta
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
        ingested = get_meta(conn, f"ingest:{kind}")
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
        "built_at": get_meta(conn, "built_at"),
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


def _run_refresh() -> None:
    _progress.update({"running": True, "started_at": time.time(), "error": None, "log": []})
    try:
        _note("starting")
        bulk.refresh()
        _note("done")
    except Exception as exc:  # noqa: BLE001 - reported to the caller, not raised into a thread
        _progress["error"] = str(exc)
        _note(f"failed: {exc}")
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
