"""User-chosen settings. Only the model so far.

A thin HTTP layer over `model_choice`, which owns the ladder and the storage.
"""

from __future__ import annotations

from dataclasses import asdict

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ..config import settings
from ..model_choice import MODEL_TIERS, choose_model, current_model, is_tier

router = APIRouter(prefix="/api/settings", tags=["settings"])


class SettingsPayload(BaseModel):
    model: str


@router.get("")
async def read_settings():
    chosen = current_model()
    return {
        "model": chosen,
        "default_model": settings.ollama_model,
        # A model set by hand in .env is honoured and reported; it just is not
        # on the ladder, and the interface says so rather than silently
        # showing the wrong row as selected.
        "is_custom": not is_tier(chosen),
        "tiers": [asdict(tier) for tier in MODEL_TIERS],
    }


@router.put("")
async def write_settings(payload: SettingsPayload):
    chosen = payload.model.strip()
    if not chosen:
        raise HTTPException(400, "A model is required.")
    # Only the ladder is settable from the interface. A free-text field would
    # let one typo quietly stop the semantic engine answering at all.
    if not is_tier(chosen):
        raise HTTPException(400, f"'{chosen}' is not one of the available models.")
    choose_model(chosen)
    return {"model": chosen}
