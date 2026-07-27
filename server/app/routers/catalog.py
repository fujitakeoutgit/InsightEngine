"""Value catalogues for type-ahead fields.

Advanced search has several fields where only an exact value works — a type
line, a set code, a keyword. Typing those blind is guesswork, so each is backed
by the list of values that actually exist in the mirror. Built from the local
data rather than Scryfall's catalog endpoints so it is instant and works
offline.
"""

from __future__ import annotations

import re
from functools import lru_cache

from fastapi import APIRouter, HTTPException, Query

from ..db import fold_name
from ..search_local import visibility_clause
from ..state import state

router = APIRouter(prefix="/api/catalog", tags=["catalog"])

KINDS = ("types", "keywords", "artists", "sets", "tags", "criteria", "names")

# `is:` predicates are a fixed vocabulary, not data.
CRITERIA = [
    "commander", "permanent", "spell", "vanilla", "dfc", "modal", "transform",
    "split", "flip", "leveler", "meld", "adventure", "saga", "hybrid",
    "phyrexian", "reserved", "gamechanger", "funny", "digital", "paper",
    "arena", "mtgo", "rebalanced", "creature", "land", "artifact", "historic",
]

_WORD = re.compile(r"[A-Za-z][A-Za-z'’-]+")


@lru_cache(maxsize=8)
def _catalog(kind: str) -> list[str]:
    """Distinct values for a field. Cached: the mirror only changes on rebuild."""
    conn = state.require_conn()

    if kind == "criteria":
        return CRITERIA

    if kind == "types":
        # Every word appearing in a type line, which covers supertypes, card
        # types and every subtype without maintaining three separate lists.
        seen: dict[str, int] = {}
        for row in conn.execute(
            "SELECT type_line FROM cards WHERE digital = 0 AND type_line IS NOT NULL"
        ):
            for match in _WORD.finditer(row["type_line"]):
                word = match.group()
                seen[word] = seen.get(word, 0) + 1
        # Frequency order: the common types are what people mean.
        return [w for w, _ in sorted(seen.items(), key=lambda kv: -kv[1])]

    if kind == "keywords":
        rows = conn.execute(
            "SELECT json_each.value AS kw, COUNT(*) AS n FROM cards, json_each(cards.keywords) "
            "WHERE digital = 0 GROUP BY kw ORDER BY n DESC"
        ).fetchall()
        return [r["kw"] for r in rows]

    if kind == "artists":
        rows = conn.execute(
            "SELECT artist, COUNT(*) AS n FROM cards WHERE artist IS NOT NULL AND digital = 0 "
            "GROUP BY artist ORDER BY n DESC"
        ).fetchall()
        return [r["artist"] for r in rows]

    if kind == "sets":
        rows = conn.execute(
            "SELECT code, name FROM sets WHERE digital = 0 ORDER BY released_at DESC"
        ).fetchall()
        return [f"{r['code']} — {r['name']}" for r in rows]

    if kind == "tags":
        rows = conn.execute(
            "SELECT slug FROM tags WHERE card_count > 0 ORDER BY card_count DESC"
        ).fetchall()
        return [r["slug"] for r in rows]

    return []


def _names(needle: str, limit: int) -> dict:
    """Card names matching a prefix, then a substring.

    Queried rather than cached like the other catalogs: there are ~30k names,
    and folded_name is indexed, so SQLite answers a keystroke faster than we
    could scan a Python list -- and without holding the list in memory.
    """
    conn = state.require_conn()
    if not needle:
        return {"kind": "names", "values": [], "total": 0}

    folded = fold_name(needle)
    # Folded on both sides, so "fire//fall", "fire fall" and "firefall" all
    # find the same card. Prefix ranks above substring: "sol" offers Sol Ring
    # before Consulate Dreadnought.
    rows = conn.execute(
        f"SELECT name FROM cards WHERE {visibility_clause(False, False)} "
        "AND name_fold LIKE ? "
        "ORDER BY (name_fold LIKE ?) DESC, length(name), name LIMIT ?",
        (f"%{folded}%", f"{folded}%", limit),
    ).fetchall()
    return {"kind": "names", "values": [r["name"] for r in rows], "total": len(rows)}


@router.get("/{kind}")
async def catalog(
    kind: str,
    q: str = Query("", description="Prefix/substring filter"),
    limit: int = Query(12, ge=1, le=50),
):
    if kind not in KINDS:
        raise HTTPException(404, f"Unknown catalog '{kind}'. Try one of {list(KINDS)}.")
    if not state.ready:
        raise HTTPException(503, "Local mirror is empty. Run: python -m app.bulk")

    if kind == "names":
        return _names(q.strip(), limit)

    values = _catalog(kind)
    needle = q.strip().lower()
    if not needle:
        return {"kind": kind, "values": values[:limit], "total": len(values)}

    # Prefix matches first: typing "gob" should offer Goblin before Hobgoblin.
    prefix = [v for v in values if v.lower().startswith(needle)]
    contains = [v for v in values if needle in v.lower() and not v.lower().startswith(needle)]
    return {
        "kind": kind,
        "values": (prefix + contains)[:limit],
        "total": len(prefix) + len(contains),
    }
