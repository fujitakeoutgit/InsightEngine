"""Spell-check endpoints for the search bar."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from ..state import state

router = APIRouter(prefix="/api/spell", tags=["spell"])


class CheckRequest(BaseModel):
    words: list[str]


@router.post("/check")
async def check(request: CheckRequest):
    """Return which of the supplied words are not in Magic's vocabulary."""
    if state.spell is None:
        return {"unknown": [], "ready": False}
    return {
        "unknown": state.spell.check(request.words[:200]),
        "ready": True,
    }


@router.get("/suggest")
async def suggest(word: str = Query(..., min_length=1), limit: int = Query(6, ge=1, le=12)):
    if state.spell is None:
        raise HTTPException(503, "Dictionary unavailable; the mirror is empty.")
    return {"word": word, "suggestions": state.spell.suggest(word, limit=limit)}


@router.get("/stats")
async def stats():
    return {"words": len(state.spell) if state.spell else 0}
