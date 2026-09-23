"""Decklist import, name resolution, format analysis, recommendations and saving."""

from __future__ import annotations

import asyncio
import time
import uuid

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from ..config import settings
from ..deck import storage
from ..deck.analysis import FORMATS, analyse
from ..deck import printings as printing_store
from ..scryfall import ScryfallError, client as scryfall
from ..deck.parser import parse_decklist
from ..deck.recommend import CATEGORY_TAGS, recommend, recommend_category
from ..deck.stats import compute as compute_stats
from ..deck.resolver import Resolution
from ..deck.simulate import MAX_ITERATIONS, MAX_TURNS, simulate
from ..llm.deck_pipeline import DeckRecommendPipeline
from ..state import state
from .semantic import HEARTBEAT_SECONDS, RECONNECT_HINT_MS, _RUNS, _sse

router = APIRouter(prefix="/api/deck", tags=["deck"])

MAX_LINES = 2000
MAX_PREPARED = 8

# Decks staged between /recommend/prepare and /recommend/stream.
_PREPARED: dict[str, tuple[list[Resolution], str | None, str | None]] = {}


#: Coordinates Scryfall has already told us it has never heard of. Remembering
#: them stops a typo'd collector number costing a request on every keystroke's
#: worth of re-analysis, for the life of the process.
_NO_SUCH_PRINTING: set[tuple[str, str]] = set()

#: How long to stop asking after a fetch fails for a reason that is not about
#: the cards -- no network, Scryfall down.
#:
#: Measured, not guessed: with Scryfall unreachable an analysis went from about
#: 100ms to 6.4 seconds, and paid it again on every re-analysis, because a
#: failed fetch keeps nothing and so never stops being retried. Editing a deck
#: offline would have become unusable. One refused connection every few minutes
#: is the most this is allowed to cost.
_OFFLINE_BACKOFF_SECONDS = 300.0
_quiet_until = 0.0


async def _ensure_printings(text: str) -> None:
    """Fetch the printings this decklist names but this install has never seen.

    The mirror is one row per *oracle card*, not per printing, so a line saying
    "(TDC) 343" comes back wearing whichever edition that row happens to hold.
    Typing a set and number therefore did nothing on its own: only the printing
    picker ever fetched anything, so a list retyped edition-by-edition showed
    the right art for the cards the mirror happened to agree with and the wrong
    art for the rest -- 20 of 94 lines on the deck that reported this.

    Fetched in batches of 75, the most Scryfall's one batched endpoint takes,
    and kept for good. So this is a cost the first time a deck names an edition
    nobody here has seen, not a cost per analysis.

    Best effort throughout. Being offline, or Scryfall having a bad day, must
    not stop a deck from being read -- anything not fetched simply keeps the
    art the mirror already had, which is exactly today's behaviour.
    """
    global _quiet_until

    if time.monotonic() < _quiet_until:
        return

    try:
        entries = parse_decklist(text).entries
    except Exception:  # noqa: BLE001 - a list too broken to parse needs no printings
        return

    conn = state.require_conn()
    wanted: list[tuple[str, str]] = []
    seen: set[tuple[str, str]] = set()
    for entry in entries:
        if not (entry.set_code and entry.collector_number):
            continue
        key = (entry.set_code.lower(), str(entry.collector_number))
        if key in seen or key in _NO_SUCH_PRINTING:
            continue
        seen.add(key)
        if printing_store.lookup(conn, *key) is None:
            wanted.append(key)

    if not wanted:
        return

    for start in range(0, len(wanted), 75):
        chunk = wanted[start:start + 75]
        try:
            # One attempt: the page is already correct enough to show, so a
            # retry budget spent while offline buys nothing and costs seconds.
            payload = await scryfall.collection(
                [
                    {"set": set_code, "collector_number": number}
                    for set_code, number in chunk
                ],
                attempts=1,
            )
        except ScryfallError:
            _quiet_until = time.monotonic() + _OFFLINE_BACKOFF_SECONDS
            return
        except Exception:  # noqa: BLE001 - never fail an analysis over art
            _quiet_until = time.monotonic() + _OFFLINE_BACKOFF_SECONDS
            return

        for card in payload.get("data") or []:
            try:
                printing_store.keep(conn, card)
            except Exception:  # noqa: BLE001 - one bad row must not lose the rest
                continue

        # What Scryfall says does not exist is not worth asking about again.
        for missing in payload.get("not_found") or []:
            code = (missing.get("set") or "").lower()
            number = str(missing.get("collector_number") or "")
            if code and number:
                _NO_SUCH_PRINTING.add((code, number))


def _resolve(text: str, commander: str | None) -> list[Resolution]:
    if not state.resolver:
        raise HTTPException(503, "Local mirror is empty. Run: python -m app.bulk")
    if text.count("\n") > MAX_LINES:
        raise HTTPException(413, f"Decklist exceeds {MAX_LINES} lines")

    parsed = parse_decklist(text)
    resolver = state.resolver
    resolutions = [
        resolver.resolve(e.raw_name, e.quantity, e.section, e.line_number, e.set_code)
        for e in parsed.entries
    ]

    # Re-apply printings the user has chosen before.
    #
    # The resolver can only answer with the one oracle row the mirror holds, so
    # a line that says "(NEO) 123" comes back wearing whatever art that row
    # happens to carry. If we fetched that printing once, the choice is on
    # record here and goes back on now.
    conn = state.require_conn()
    for res, entry in zip(resolutions, parsed.entries):
        if not (res.card and entry.set_code and entry.collector_number):
            continue
        kept = printing_store.lookup(conn, entry.set_code, entry.collector_number)
        if kept and kept["oracle_id"] == res.card.get("oracle_id"):
            res.card = printing_store.overlay(res.card, kept)

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
    # Only here. Analysis is what the editor and the mat draw their cards
    # from, so this is where the art has to be right; simulation and the
    # recommender read types and costs, which every printing shares.
    await _ensure_printings(request.text)
    resolutions = _resolve(request.text, request.commander)
    parsed = parse_decklist(request.text)

    report = analyse(resolutions)
    report["stats"] = compute_stats(state.require_conn(), resolutions)
    report["ignored_lines"] = parsed.ignored_lines
    report["unresolved"] = [
        {"raw_name": r.raw_name, "line_number": r.line_number, "alternatives": r.alternatives}
        for r in resolutions if not r.resolved
    ]
    return report


class KeepPrintingRequest(BaseModel):
    scryfall_id: str = Field(..., description="The printing to fetch and keep")


@router.post("/printing/keep")
async def keep_printing(request: KeepPrintingRequest):
    """Fetch one printing from Scryfall and keep it locally, for good.

    Called when a printing is chosen. From then on the deck can be reopened,
    the app restarted and the card data rebuilt, and that card still wears the
    art that was picked -- without ever ingesting the full printings file.
    """
    try:
        card = await scryfall.card_by_id(request.scryfall_id)
    except ScryfallError as exc:
        raise HTTPException(502, f"Could not reach Scryfall: {exc}") from exc

    stored = printing_store.keep(state.require_conn(), card)
    if stored is None:
        raise HTTPException(422, "That printing is missing fields we need to keep it")
    return {"printing": stored}


class SimulateRequest(DecklistRequest):
    iterations: int = Field(1000, ge=1, le=MAX_ITERATIONS)
    turns: int = Field(10, ge=1, le=MAX_TURNS)
    seed: int | None = Field(None, description="Fix the shuffle, for a repeatable run")


@router.post("/simulate")
async def simulate_deck(request: SimulateRequest):
    """Shuffle and play the opening turns many times over."""
    resolutions = _resolve(request.text, request.commander)
    # Off the event loop: twenty thousand games is real CPU work, and a request
    # this slow would otherwise stall every other request in the process.
    return await asyncio.to_thread(
        simulate,
        state.require_conn(),
        resolutions,
        request.iterations,
        request.turns,
        request.seed,
    )


class RecommendRequest(DecklistRequest):
    format: str | None = Field(None, description="Restrict to cards legal in this format")
    description: str | None = Field(None, description="How the deck is meant to work")
    limit: int = Field(150, ge=1, le=400)
    category: str | None = Field(None, description="ramp, removal, counterspell or draw")


@router.post("/recommend")
async def recommendations(request: RecommendRequest):
    """Suggest cards that fit the deck's themes, colors and format.

    No model is involved: suggestions are drawn from the deck's own oracle tags,
    so every one is a real card and the same deck always yields the same advice.
    """
    if request.format and request.format not in FORMATS:
        raise HTTPException(400, f"Unknown format '{request.format}'")

    resolutions = _resolve(request.text, request.commander)
    return recommend(
        state.require_conn(), resolutions,
        format_key=request.format, limit=request.limit,
        description=request.description,
    )


@router.post("/recommend/category")
async def recommendations_by_category(request: RecommendRequest):
    """The most-played cards of one functional kind.

    Ramp, removal, counterspells and draw never qualify on theme alone, which
    makes them invisible rather than unwanted. This is how you ask for them.
    """
    if request.format and request.format not in FORMATS:
        raise HTTPException(400, f"Unknown format '{request.format}'")
    if request.category not in CATEGORY_TAGS:
        raise HTTPException(
            400, f"Unknown category '{request.category}'. "
                 f"Expected one of: {', '.join(sorted(CATEGORY_TAGS))}",
        )

    resolutions = _resolve(request.text, request.commander)
    return recommend_category(
        state.require_conn(), resolutions, request.category,
        format_key=request.format, limit=request.limit,
    )


@router.post("/recommend/prepare")
async def prepare_ai_recommendations(request: RecommendRequest):
    """Stage a deck for the AI pipeline and hand back a run id.

    EventSource can only issue GETs, and a decklist is too long for a query
    string, so the deck is posted first and the stream is opened against the
    id this returns.
    """
    if request.format and request.format not in FORMATS:
        raise HTTPException(400, f"Unknown format '{request.format}'")
    resolutions = _resolve(request.text, request.commander)
    if not any(r.resolved for r in resolutions):
        raise HTTPException(400, "No cards in that list could be resolved.")

    run_id = uuid.uuid4().hex
    _PREPARED[run_id] = (resolutions, request.format, request.description)
    # Bound the staging area; these are only alive between prepare and stream.
    while len(_PREPARED) > MAX_PREPARED:
        _PREPARED.pop(next(iter(_PREPARED)))
    return {"run_id": run_id, "cards": sum(1 for r in resolutions if r.resolved)}


@router.get("/recommend/stream")
async def stream_ai_recommendations(run_id: str = Query(...)):
    staged = _PREPARED.pop(run_id, None)
    if staged is None:
        raise HTTPException(404, "No prepared deck for that id; prepare it again.")
    resolutions, format_key, description = staged

    if len(_RUNS) >= settings.semantic_max_concurrent:
        raise HTTPException(429, "A search or recommendation run is already in progress.")

    pipeline = DeckRecommendPipeline(state.require_conn())
    queue: asyncio.Queue = asyncio.Queue()

    async def produce() -> None:
        try:
            async for step in pipeline.run(
                resolutions, format_key=format_key, description=description,
            ):
                event = "complete" if step.name == "complete" else "stage"
                await queue.put((event, step.as_dict()))
        except asyncio.CancelledError:
            queue.put_nowait(("cancelled", {
                "stage": "cancelled", "message": "Run stopped; model released.", "detail": {},
            }))
            raise
        except Exception as exc:  # noqa: BLE001 - surface faults to the UI
            queue.put_nowait(("error", {"message": f"{type(exc).__name__}: {exc}"}))
        finally:
            queue.put_nowait(None)

    task = asyncio.create_task(produce())
    _RUNS[run_id] = task

    async def generate():
        yield f"retry: {RECONNECT_HINT_MS}\n\n"
        yield _sse("stage", {
            "stage": "start",
            "message": f"Starting {settings.ollama_model}",
            "detail": {"run_id": run_id},
        })
        try:
            while True:
                try:
                    item = await asyncio.wait_for(queue.get(), timeout=HEARTBEAT_SECONDS)
                except asyncio.TimeoutError:
                    yield ": keepalive\n\n"
                    continue
                if item is None:
                    break
                yield _sse(*item)
        finally:
            task.cancel()
            _RUNS.pop(run_id, None)

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "Connection": "keep-alive",
                 "X-Accel-Buffering": "no"},
    )


class SaveRequest(BaseModel):
    name: str
    text: str
    id: int | None = None
    commander: str | None = None
    format: str | None = None
    description: str | None = None
    #: 'main' or 'prototype'. Omitted means leave it where it is on an update,
    #: and Main on a new deck — see storage.save.
    group: str | None = None


@router.get("/saved")
async def saved_decks():
    return {"decks": storage.listing(state.require_conn())}


@router.post("/saved")
async def save_deck(request: SaveRequest):
    try:
        deck = storage.save(
            state.require_conn(), request.name, request.text,
            deck_id=request.id, commander=request.commander, format_key=request.format,
            description=request.description, group=request.group,
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
