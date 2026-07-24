"""Set browser and the symbol / keyword glossary."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query

from ..scryfall import ScryfallError, client as scryfall
from ..search_local import list_sets
from ..state import state

router = APIRouter(prefix="/api", tags=["reference"])


@router.get("/sets")
async def all_sets(include_digital: bool = Query(True)):
    if not state.ready:
        raise HTTPException(503, "Local mirror is empty. Run: python -m app.bulk")
    sets = list_sets(state.require_conn())
    if not include_digital:
        sets = [s for s in sets if not s["digital"]]
    return {"sets": sets}


@router.get("/sets/{code}")
async def set_detail(code: str):
    if not state.ready:
        raise HTTPException(503, "Local mirror is empty.")
    conn = state.require_conn()
    row = conn.execute("SELECT * FROM sets WHERE code = ?", (code.lower(),)).fetchone()
    if row is None:
        raise HTTPException(404, "Set not found")
    counts = conn.execute(
        "SELECT rarity, COUNT(*) AS n FROM cards WHERE set_code = ? GROUP BY rarity",
        (code.lower(),),
    ).fetchall()
    return {
        "set": dict(row),
        "rarity_counts": {r["rarity"]: r["n"] for r in counts},
    }


@router.get("/glossary")
async def glossary():
    """Mana symbols plus the keyword catalogues, for the reference view."""
    symbols: list[dict] = []
    keywords: dict[str, list[str]] = {}
    warnings: list[str] = []

    try:
        symbols = await scryfall.symbology()
    except ScryfallError as exc:
        warnings.append(f"symbology unavailable: {exc.detail}")

    try:
        keywords = await scryfall.keyword_catalog()
    except ScryfallError as exc:
        warnings.append(f"keyword catalog unavailable: {exc.detail}")

    # Keyword frequency comes from the local mirror, which the catalogue lacks.
    frequency: dict[str, int] = {}
    if state.ready:
        rows = state.require_conn().execute(
            "SELECT json_each.value AS kw, COUNT(*) AS n FROM cards, json_each(cards.keywords) "
            "GROUP BY kw ORDER BY n DESC"
        ).fetchall()
        frequency = {r["kw"]: r["n"] for r in rows}

    return {
        "symbols": symbols,
        "keywords": keywords,
        "frequency": frequency,
        "warnings": warnings,
    }


@router.get("/tags")
async def tag_glossary(q: str = Query("", description="filter tags"), limit: int = 60):
    """Browse the oracle-tag vocabulary the semantic engine draws on."""
    if not state.ready:
        raise HTTPException(503, "Local mirror is empty.")
    conn = state.require_conn()
    if q.strip():
        from ..tags import search_tags
        return {"tags": search_tags(conn, q, limit=limit)}
    rows = conn.execute(
        "SELECT slug, label, description, card_count FROM tags "
        "WHERE card_count > 0 ORDER BY card_count DESC LIMIT ?", (limit,)
    ).fetchall()
    return {"tags": [dict(r) for r in rows]}
