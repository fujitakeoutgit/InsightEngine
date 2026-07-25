"""The `q:` semantic search endpoint.

Streamed over SSE because a thorough run against a 70B model is measured in
minutes, and the user should watch the stages rather than a spinner.

Cancellation matters here more than in a normal request. A run holds the model
for several minutes, so abandoning one must actually free it. The pipeline
therefore runs as its own `asyncio.Task`: cancelling that task interrupts the
`await` on the Ollama HTTP call, which closes the connection, which makes
Ollama abort generation. Both routes into cancellation -- the client closing
the stream, and an explicit request from the Stop button -- end at the same
`task.cancel()`.
"""

from __future__ import annotations

import asyncio
import json
import uuid

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import StreamingResponse

from ..config import settings
from ..llm.ollama import OllamaError, client as ollama
from ..llm.pipeline import SemanticPipeline
from ..query.parser import extract_semantic, parse
from ..state import state

router = APIRouter(prefix="/api/semantic", tags=["semantic"])

# run_id -> the task producing that run's stages.
_RUNS: dict[str, asyncio.Task] = {}


def _sse(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data)}\n\n"


@router.get("/status")
async def status():
    available = await ollama.available()
    models = await ollama.installed_models() if available else []
    return {
        "available": available,
        "model": settings.ollama_model,
        "model_installed": settings.ollama_model in models,
        "models": models,
        "endpoint": settings.ollama_base,
        "active_runs": len(_RUNS),
    }


@router.post("/cancel/{run_id}")
async def cancel(run_id: str):
    """Stop a run and release the model."""
    task = _RUNS.get(run_id)
    if task is None:
        return {"cancelled": False, "reason": "no such run"}
    task.cancel()
    return {"cancelled": True, "run_id": run_id}


@router.post("/cancel")
async def cancel_all():
    for task in list(_RUNS.values()):
        task.cancel()
    return {"cancelled": True, "count": len(_RUNS)}


@router.get("/stream")
async def stream(
    q: str = Query(..., description='Full query including q:"..."'),
    run_id: str = Query("", description="Client-supplied id, used to cancel"),
):
    if not state.ready:
        raise HTTPException(503, "Local mirror is empty. Run: python -m app.bulk")

    prompts, structured = extract_semantic(parse(q))
    if not prompts:
        raise HTTPException(400, 'Query contains no q:"..." prompt')

    prompt = " ".join(prompts)
    run = run_id or uuid.uuid4().hex
    pipeline = SemanticPipeline(state.require_conn())

    # The producer runs independently of the response generator so that closing
    # the response can cancel it, rather than merely stopping consumption.
    queue: asyncio.Queue = asyncio.Queue()

    async def produce() -> None:
        try:
            async for step in pipeline.run(prompt, structured):
                await queue.put(("stage", step.as_dict()))
        except asyncio.CancelledError:
            # put_nowait: awaiting inside a cancelled task is not reliable.
            queue.put_nowait(("cancelled", {
                "stage": "cancelled", "message": "Run stopped; model released.",
                "detail": {},
            }))
            raise
        except OllamaError as exc:
            queue.put_nowait(("error", {"message": str(exc)}))
        except Exception as exc:  # noqa: BLE001 - surface pipeline faults to the UI
            queue.put_nowait(("error", {"message": f"{type(exc).__name__}: {exc}"}))
        finally:
            queue.put_nowait(None)

    task = asyncio.create_task(produce())
    _RUNS[run] = task

    async def generate():
        yield _sse("stage", {
            "stage": "start",
            "message": f"Starting {settings.ollama_model}",
            "detail": {"prompt": prompt, "run_id": run},
        })
        try:
            while True:
                item = await queue.get()
                if item is None:
                    break
                yield _sse(*item)
        finally:
            # Reached on normal completion, on client disconnect, and on
            # cancellation. Cancelling an already-finished task is harmless.
            task.cancel()
            _RUNS.pop(run, None)

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )
