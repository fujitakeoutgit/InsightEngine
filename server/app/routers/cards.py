"""Card detail: oracle text, rulings, legality, printings and vendor prices."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException

from ..scryfall import ScryfallError, client as scryfall, normalize_card
from ..search_local import get_card, get_rulings
from ..state import state
from ..tags import tags_for_card

router = APIRouter(prefix="/api/cards", tags=["cards"])


def _vendor_links(card: dict) -> dict[str, str | None]:
    """Purchase links are built from the card's own identifiers only."""
    name = card.get("name") or ""
    return {
        "tcgplayer": f"https://www.tcgplayer.com/search/magic/product?q={name}",
        "cardmarket": f"https://www.cardmarket.com/en/Magic/Products/Search?searchString={name}",
        "cardhoarder": f"https://www.cardhoarder.com/cards?data%5Bsearch%5D={name}",
        "scryfall": card.get("scryfall_uri"),
    }


@router.get("/{oracle_id}")
async def card_detail(oracle_id: str, printings: bool = True):
    if not state.ready:
        raise HTTPException(503, "Local mirror is empty. Run: python -m app.bulk")

    conn = state.require_conn()
    card = get_card(conn, oracle_id)
    if card is None:
        raise HTTPException(404, "Card not found")

    local_rulings = get_rulings(conn, oracle_id)
    tags = tags_for_card(conn, oracle_id)

    versions: list[dict] = []
    if printings:
        try:
            raw = await scryfall.printings(card["name"])
            versions = [normalize_card(c) for c in raw]
        except ScryfallError:
            versions = []

    return {
        "card": card,
        "rulings": local_rulings,
        "tags": tags,
        "printings": versions,
        "vendors": _vendor_links(card),
    }


@router.get("/{oracle_id}/printings")
async def card_printings(oracle_id: str):
    if not state.ready:
        raise HTTPException(503, "Local mirror is empty.")
    card = get_card(state.require_conn(), oracle_id)
    if card is None:
        raise HTTPException(404, "Card not found")
    try:
        raw = await scryfall.printings(card["name"])
    except ScryfallError as exc:
        raise HTTPException(exc.status, exc.detail) from exc
    return {"printings": [normalize_card(c) for c in raw]}


@router.get("/named/{name}")
async def card_by_name(name: str):
    """Resolve a name through the local ladder, then return the full record."""
    if not state.resolver:
        raise HTTPException(503, "Local mirror is empty.")
    resolution = state.resolver.resolve(name, 1, "main")
    if not resolution.resolved:
        raise HTTPException(404, f"No card matching '{name}'")
    return {"card": resolution.card, "match": resolution.match,
            "score": resolution.score, "alternatives": resolution.alternatives}
