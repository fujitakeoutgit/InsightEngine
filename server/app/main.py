"""Insight Engine API.

A Magic: The Gathering search engine.

Card data and images are provided by Scryfall (https://scryfall.com) under
their API terms. Insight Engine is unofficial Fan Content permitted under the Wizards
of the Coast Fan Content Policy, and is not affiliated with or endorsed by
Scryfall or Wizards of the Coast.
"""

from __future__ import annotations

import threading
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from .config import PROJECT_ROOT, settings
from .llm.ollama import client as ollama
from .routers import cards, catalog, deck, search, semantic, sets, settings_api, spell, sync
from .seed import seed_decks
from .scryfall import client as scryfall
from .state import state


@asynccontextmanager
async def lifespan(_: FastAPI):
    state.start()
    # A fresh database gets one real deck, so the Deck Lab, the charts and the
    # playtester have something to be about the first time they are opened.
    # A no-op on every start after the first.
    if state.conn is not None:
        seed_decks(state.conn)
    await scryfall.start()
    await ollama.start()
    # Ask Scryfall whether the card data has moved on, in a thread so a slow or
    # unreachable network cannot hold up the server coming up. It only *asks* --
    # nothing is downloaded without you pressing Refresh. See routers/sync.
    threading.Thread(target=sync.check_now, name="sync-check", daemon=True).start()
    try:
        yield
    finally:
        await ollama.close()
        await scryfall.close()
        state.close()


app = FastAPI(
    title="Insight Engine",
    description="Magic: The Gathering card search. Data source: Scryfall.",
    version="1.0.0",
    lifespan=lifespan,
)

def _allowed_origins() -> list[str] | str:
    origins = ["http://localhost:5173", "http://127.0.0.1:5173"]
    extra = [o.strip() for o in settings.extra_cors_origins.split(",") if o.strip()]
    if "*" in extra:
        return ["*"]
    return origins + extra


app.add_middleware(
    CORSMiddleware,
    allow_origins=_allowed_origins(),
    # Regex covers the private ranges so a LAN peer's own origin works without
    # having to enumerate every device's address.
    allow_origin_regex=r"http://(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)[\d.]+(:\d+)?",
    allow_methods=["GET", "POST", "DELETE"],
    allow_headers=["*"],
)

app.include_router(search.router)
app.include_router(semantic.router)
app.include_router(cards.router)
app.include_router(sets.router)
app.include_router(deck.router)
app.include_router(spell.router)
app.include_router(catalog.router)
app.include_router(settings_api.router)
app.include_router(sync.router)


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


def _mount_web() -> None:
    """Serve the built interface, when there is one.

    Development runs Vite on its own port and proxies `/api` here, so this
    finds nothing and does nothing. An installed copy has no Node at all: the
    interface is a folder of static files and this is what serves it, which is
    what collapses the two ports into one and takes the dev server out of the
    shipped product.

    Registered last, after every router, because the catch-all below would
    otherwise shadow them.
    """
    dist = PROJECT_ROOT / "web" / "dist"
    index = dist / "index.html"
    if not index.exists():
        return

    app.mount("/assets", StaticFiles(directory=dist / "assets"), name="assets")

    @app.get("/{path:path}", include_in_schema=False)
    async def spa(path: str):
        # A real file if there is one -- favicon, card back, manifest.
        candidate = (dist / path).resolve()
        if path and candidate.is_file() and candidate.is_relative_to(dist.resolve()):
            return FileResponse(candidate)
        # Otherwise the app itself. Client-side routes like /deck/36 are not
        # files and must still return the shell rather than a 404; `/api/*`
        # never reaches here because the routers claimed it first.
        return FileResponse(index)


_mount_web()


def main() -> None:
    """Entry point that honours the configured host, for LAN serving."""
    import uvicorn

    uvicorn.run(app, host=settings.host, port=settings.port)


if __name__ == "__main__":
    main()
