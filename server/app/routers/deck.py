"""Decklist import, name resolution and format analysis."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from ..deck.analysis import analyse
from ..deck.parser import parse_decklist
from ..deck.resolver import Resolution
from ..state import state

router = APIRouter(prefix="/api/deck", tags=["deck"])

MAX_LINES = 2000


class DecklistRequest(BaseModel):
    text: str = Field(..., description="Raw decklist text")
    commander: str | None = Field(None, description="Override the commander by name")


@router.post("/analyze")
async def analyze(request: DecklistRequest):
    if not state.resolver:
        raise HTTPException(503, "Local mirror is empty. Run: python -m app.bulk")

    if request.text.count("\n") > MAX_LINES:
        raise HTTPException(413, f"Decklist exceeds {MAX_LINES} lines")

    parsed = parse_decklist(request.text)
    resolver = state.resolver

    resolutions: list[Resolution] = [
        resolver.resolve(entry.raw_name, entry.quantity, entry.section, entry.line_number)
        for entry in parsed.entries
    ]

    # An explicit commander override wins over section/flag detection.
    if request.commander:
        target = request.commander.strip().lower()
        for res in resolutions:
            if res.card and res.card["name"].lower() == target:
                res.section = "commander"

    report = analyse(resolutions)
    report["ignored_lines"] = parsed.ignored_lines
    report["unresolved"] = [
        {"raw_name": r.raw_name, "line_number": r.line_number,
         "alternatives": r.alternatives}
        for r in resolutions if not r.resolved
    ]
    return report


class ResolveRequest(BaseModel):
    names: list[str]


@router.post("/resolve")
async def resolve_names(request: ResolveRequest):
    """Resolve a batch of names; used by the live editor as the user types."""
    if not state.resolver:
        raise HTTPException(503, "Local mirror is empty.")
    resolver = state.resolver
    return {
        "results": [
            resolver.resolve(name, 1, "main").as_dict() for name in request.names[:200]
        ]
    }
