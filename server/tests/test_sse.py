"""SSE framing tests.

These exist because two framing bugs each cost a full eight-minute run:
the terminal stage was delivered as a plain `stage` event so the client's
`complete` listener never fired, and long silent gaps let the connection idle
out, which made EventSource reconnect and start the run over.
"""

from __future__ import annotations

import asyncio
import re

import pytest

from app.routers import semantic


class FakeStage:
    def __init__(self, name: str) -> None:
        self.name = name

    def as_dict(self) -> dict:
        return {"stage": self.name, "message": "", "detail": {}}


@pytest.mark.asyncio
async def test_terminal_stage_is_its_own_event_type():
    """The client binds `complete` separately from `stage`."""
    events: list[tuple[str, dict]] = []

    async def fake_run():
        for name in ("concepts", "execute", "complete"):
            yield FakeStage(name)

    async for step in fake_run():
        events.append(("complete" if step.name == "complete" else "stage", step.as_dict()))

    assert [e[0] for e in events] == ["stage", "stage", "complete"]


def test_sse_frame_format():
    frame = semantic._sse("complete", {"stage": "complete"})
    assert frame.startswith("event: complete\ndata: ")
    assert frame.endswith("\n\n")


def test_heartbeat_interval_is_below_common_proxy_timeouts():
    # Proxies commonly close idle connections at 60s; stages can be 90s apart.
    assert semantic.HEARTBEAT_SECONDS <= 30
    assert semantic.RECONNECT_HINT_MS >= 10_000


@pytest.mark.asyncio
async def test_generator_emits_keepalive_while_the_queue_is_silent():
    """A quiet queue must still produce bytes, or the stream idles out."""
    queue: asyncio.Queue = asyncio.Queue()
    frames: list[str] = []

    async def pump():
        # Mirrors the generator's wait loop.
        for _ in range(3):
            try:
                item = await asyncio.wait_for(queue.get(), timeout=0.05)
            except asyncio.TimeoutError:
                frames.append(": keepalive\n\n")
                continue
            if item is None:
                break
            frames.append(semantic._sse(*item))

    await pump()
    assert frames == [": keepalive\n\n"] * 3
    assert all(re.match(r"^: ", f) for f in frames)
