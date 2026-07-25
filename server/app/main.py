"""Insight Enigma API.

A Magic: The Gathering search engine.

Card data and images are provided by Scryfall (https://scryfall.com) under
their API terms. Insight Enigma is unofficial Fan Content permitted under the Wizards
of the Coast Fan Content Policy, and is not affiliated with or endorsed by
Scryfall or Wizards of the Coast.
"""

from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .config import settings
from .llm.ollama import client as ollama
from .routers import cards, deck, search, semantic, sets, spell
from .scryfall import client as scryfall
from .state import state


@asynccontextmanager
async def lifespan(_: FastAPI):
    state.start()
    await scryfall.start()
    await ollama.start()
    try:
        yield
    finally:
        await ollama.close()
        await scryfall.close()
        state.close()


app = FastAPI(
    title="Insight Enigma",
    description="Magic: The Gathering card search. Data source: Scryfall.",
    version="1.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)

app.include_router(search.router)
app.include_router(semantic.router)
app.include_router(cards.router)
app.include_router(sets.router)
app.include_router(deck.router)
app.include_router(spell.router)


@app.get("/api/health")
async def health():
    return {
        "status": "ok" if state.ready else "no-data",
        "cards": state.card_count,
        "paper_cards": state.paper_count,
        "mirror_built_at": state.built_at,
        "model": settings.ollama_model,
        "attribution": "Card data from Scryfall (https://scryfall.com)",
    }
