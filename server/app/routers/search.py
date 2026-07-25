"""Search endpoints.

Routing policy:

* A query using only standard syntax goes to Scryfall, because they implement
  the full operator set and their prices are live. Responses are cached.
* A query using Insight Enigma extensions (`q:`, `_` wildcards, `otag:`) runs on the
  local mirror, because those have no server-side equivalent.
* `engine=local` or `engine=scryfall` overrides the choice.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query

from ..query.parser import extract_semantic, is_empty, parse, requires_local_engine
from ..query.sql import QueryCompileError
from ..scryfall import ScryfallError, client as scryfall, normalize_card
from ..search_local import search_ast
from ..state import state

router = APIRouter(prefix="/api", tags=["search"])

SCRYFALL_ORDERS = {
    "name", "set", "released", "rarity", "color", "usd", "tix", "eur", "cmc",
    "power", "toughness", "edhrec", "artist", "review",
}


def _with_defaults(query: str, include_funny: bool, include_digital: bool) -> str:
    """Apply the same result hygiene to Scryfall that the local engine applies.

    Without this the two engines disagree: the API returns Alchemy rebalances
    and Un-set cards by default, while the local mirror hides them. A default is
    only added when the user has not mentioned that facet themselves.
    """
    lowered = query.lower()
    extras = []
    if not include_digital and "is:digital" not in lowered and "game:" not in lowered:
        extras.append("-is:digital")
    if not include_funny and "is:funny" not in lowered and "set_type:" not in lowered:
        extras.append("-is:funny")
    return " ".join([query, *extras])


@router.get("/search")
async def search(
    q: str = Query("", description="Insight Enigma/Scryfall query syntax"),
    page: int = Query(1, ge=1),
    per_page: int = Query(60, ge=1, le=175),
    sort: str = Query("name"),
    order: str = Query("asc", pattern="^(asc|desc)$"),
    engine: str = Query("auto", pattern="^(auto|local|scryfall)$"),
    unique: str = Query("cards", pattern="^(cards|prints|art)$"),
    include_funny: bool = Query(False),
    include_digital: bool = Query(False),
):
    query = q.strip()
    if not query:
        return {"cards": [], "total": 0, "page": 1, "per_page": per_page,
                "has_more": False, "engine": "none", "warnings": []}

    node = parse(query)
    prompts, structured = extract_semantic(node)

    # `q:` needs the streaming pipeline; the client should call /semantic.
    if prompts:
        return {
            "cards": [], "total": 0, "page": 1, "per_page": per_page,
            "has_more": False, "engine": "semantic", "needs_semantic": True,
            "prompts": prompts,
            "structured": query,
            "warnings": ["This query uses q: and is handled by the semantic pipeline."],
        }

    use_local = engine == "local" or (engine == "auto" and requires_local_engine(node))

    if use_local:
        if not state.ready:
            raise HTTPException(503, "Local mirror is empty. Run: python -m app.bulk")
        try:
            result = search_ast(
                state.require_conn(), structured, sort=sort, order=order,
                page=page, per_page=per_page, include_funny=include_funny,
                include_digital=include_digital,
            )
        except QueryCompileError as exc:
            raise HTTPException(400, str(exc)) from exc
        return {
            "cards": result.cards, "total": result.total, "page": result.page,
            "per_page": result.per_page, "has_more": result.has_more,
            "engine": "local", "warnings": result.warnings,
        }

    scry_order = sort if sort in SCRYFALL_ORDERS else "name"
    try:
        payload = await scryfall.search(
            _with_defaults(query, include_funny, include_digital),
            page=page, order=scry_order,
            direction="desc" if order == "desc" else "asc", unique=unique,
        )
    except ScryfallError as exc:
        if exc.status == 404:
            return {"cards": [], "total": 0, "page": page, "per_page": per_page,
                    "has_more": False, "engine": "scryfall", "warnings": []}
        raise HTTPException(exc.status, exc.detail) from exc

    cards = [normalize_card(c) for c in payload.get("data", [])]
    return {
        "cards": cards,
        "total": payload.get("total_cards", len(cards)),
        "page": page,
        "per_page": len(cards),
        "has_more": bool(payload.get("has_more")),
        "engine": "scryfall",
        "warnings": [],
    }


@router.get("/autocomplete")
async def autocomplete(q: str = Query("", min_length=0)):
    fragment = q.strip()
    if len(fragment) < 2:
        return {"suggestions": []}
    try:
        return {"suggestions": await scryfall.autocomplete(fragment)}
    except ScryfallError:
        # Fall back to the local mirror so the box still works offline.
        if not state.ready:
            return {"suggestions": []}
        rows = state.require_conn().execute(
            "SELECT name FROM cards WHERE name LIKE ? ORDER BY "
            "(edhrec_rank IS NULL), edhrec_rank LIMIT 20",
            (f"%{fragment}%",),
        ).fetchall()
        return {"suggestions": [r["name"] for r in rows]}
