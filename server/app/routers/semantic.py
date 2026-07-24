"""The `q:` semantic search endpoint.

Streamed over SSE because a thorough run against a 70B model is measured in
minutes, and the user should watch the stages rather than a spinner.
"""

from __future__ import annotations

import asyncio
import json

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import StreamingResponse

from ..config import settings
from ..llm.ollama import OllamaError, client as ollama
from ..llm.pipeline import SemanticPipeline
from ..query.parser import extract_semantic, parse
from ..state import state

router = APIRouter(prefix="/api/semantic", tags=["semantic"])


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
    }


@router.get("/stream")
async def stream(q: str = Query(..., description="Full query including q:\"...\"")):
    if not state.ready or state.names is None:
        raise HTTPException(503, "Local mirror is empty. Run: python -m app.bulk")

    prompts, structured = extract_semantic(parse(q))
    if not prompts:
        raise HTTPException(400, 'Query contains no q:"..." prompt')

    prompt = " ".join(prompts)
    pipeline = SemanticPipeline(state.require_conn(), state.names)

    async def generate():
        yield _sse("stage", {
            "stage": "start", "message": f"Starting {settings.ollama_model}",
            "detail": {"prompt": prompt},
        })
        try:
            async for step in pipeline.run(prompt, structured):
                yield _sse(
                    "complete" if step.name == "complete" else "stage", step.as_dict()
                )
        except OllamaError as exc:
            yield _sse("error", {"message": str(exc)})
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 - surface pipeline faults to the UI
            yield _sse("error", {"message": f"{type(exc).__name__}: {exc}"})

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )
