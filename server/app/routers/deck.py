"""Decklist import, name resolution, format analysis, recommendations and saving."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from ..deck import storage
from ..deck.analysis import FORMATS, analyse
from ..deck.parser import parse_decklist
from ..deck.recommend import recommend
from ..deck.resolver import Resolution
from ..state import state

router = APIRouter(prefix="/api/deck", tags=["deck"])

MAX_LINES = 2000


def _resolve(text: str, commander: str | None) -> list[Resolution]:
    if not state.resolver:
        raise HTTPException(503, "Local mirror is empty. Run: python -m app.bulk")
    if text.count("\n") > MAX_LINES:
        raise HTTPException(413, f"Decklist exceeds {MAX_LINES} lines")

    parsed = parse_decklist(text)
    resolver = state.resolver
    resolutions = [
        resolver.resolve(e.raw_name, e.quantity, e.section, e.line_number)
        for e in parsed.entries
    ]

    # An explicit commander override wins over section/flag detection.
    if commander:
        target = commander.strip().lower()
        for res in resolutions:
            if res.card and res.card["name"].lower() == target:
                res.section = "commander"

    return resolutions


class DecklistRequest(BaseModel):
    text: str = Field(..., description="Raw decklist text")
    commander: str | None = Field(None, description="Override the commander by name")


@router.post("/analyze")
async def analyze(request: DecklistRequest):
    resolutions = _resolve(request.text, request.commander)
    parsed = parse_decklist(request.text)

    report = analyse(resolutions)
    report["ignored_lines"] = parsed.ignored_lines
    report["unresolved"] = [
        {"raw_name": r.raw_name, "line_number": r.line_number, "alternatives": r.alternatives}
        for r in resolutions if not r.resolved
    ]
    return report


class RecommendRequest(DecklistRequest):
    format: str | None = Field(None, description="Restrict to cards legal in this format")
    limit: int = Field(40, ge=1, le=120)


@router.post("/recommend")
async def recommendations(request: RecommendRequest):
    """Suggest cards that fit the deck's themes, colours and format.

    No model is involved: suggestions are drawn from the deck's own oracle tags,
    so every one is a real card and the same deck always yields the same advice.
    """
    if request.format and request.format not in FORMATS:
        raise HTTPException(400, f"Unknown format '{request.format}'")

    resolutions = _resolve(request.text, request.commander)
    return recommend(
        state.require_conn(), resolutions,
        format_key=request.format, limit=request.limit,
    )


class SaveRequest(BaseModel):
    name: str
    text: str
    id: int | None = None
    commander: str | None = None
    format: str | None = None


@router.get("/saved")
async def saved_decks():
    return {"decks": storage.listing(state.require_conn())}


@router.post("/saved")
async def save_deck(request: SaveRequest):
    try:
        deck = storage.save(
            state.require_conn(), request.name, request.text,
            deck_id=request.id, commander=request.commander, format_key=request.format,
        )
    except storage.DeckError as exc:
        raise HTTPException(400, str(exc)) from exc
    return {"deck": deck}


@router.get("/saved/{deck_id}")
async def load_deck(deck_id: int):
    try:
        return {"deck": storage.load(state.require_conn(), deck_id)}
    except storage.DeckError as exc:
        raise HTTPException(404, str(exc)) from exc


@router.delete("/saved/{deck_id}")
async def delete_deck(deck_id: int):
    try:
        storage.delete(state.require_conn(), deck_id)
    except storage.DeckError as exc:
        raise HTTPException(404, str(exc)) from exc
    return {"deleted": deck_id}


class ResolveRequest(BaseModel):
    names: list[str]


@router.post("/resolve")
async def resolve_names(request: ResolveRequest):
    """Resolve a batch of names; used by the live editor as the user types."""
    if not state.resolver:
        raise HTTPException(503, "Local mirror is empty.")
    resolver = state.resolver
    return {
        "results": [resolver.resolve(name, 1, "main").as_dict() for name in request.names[:200]]
    }
