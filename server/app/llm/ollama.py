"""Thin async client for a local Ollama server.

Every call in this app uses constrained decoding: a JSON Schema is handed to
Ollama's ``format`` parameter so the model is structurally unable to emit prose
where an object is expected. Combined with temperature 0, this removes an
entire class of parsing failures and, more importantly, removes the model's
opportunity to free-associate.
"""

from __future__ import annotations

import json
from typing import Any

import httpx

from ..config import settings


class OllamaError(RuntimeError):
    pass


class OllamaClient:
    def __init__(self) -> None:
        self._client: httpx.AsyncClient | None = None

    async def start(self) -> None:
        self._client = httpx.AsyncClient(
            base_url=settings.ollama_base, timeout=settings.ollama_timeout
        )

    async def close(self) -> None:
        if self._client:
            await self._client.aclose()
            self._client = None

    async def _post(self, path: str, payload: dict[str, Any]) -> dict[str, Any]:
        if self._client is None:
            await self.start()
        assert self._client is not None
        try:
            resp = await self._client.post(path, json=payload)
        except httpx.RequestError as exc:
            raise OllamaError(
                f"Cannot reach Ollama at {settings.ollama_base}. Is `ollama serve` running? ({exc})"
            ) from exc
        if resp.status_code != 200:
            raise OllamaError(f"Ollama returned {resp.status_code}: {resp.text[:400]}")
        return resp.json()

    async def available(self) -> bool:
        try:
            if self._client is None:
                await self.start()
            assert self._client is not None
            resp = await self._client.get("/api/tags", timeout=5.0)
            return resp.status_code == 200
        except (httpx.RequestError, OllamaError):
            return False

    async def installed_models(self) -> list[str]:
        try:
            if self._client is None:
                await self.start()
            assert self._client is not None
            resp = await self._client.get("/api/tags", timeout=10.0)
            return [m["name"] for m in resp.json().get("models", [])]
        except (httpx.RequestError, KeyError, ValueError):
            return []

    async def chat_json(
        self,
        system: str,
        user: str,
        schema: dict[str, Any],
        *,
        num_predict: int = 2048,
    ) -> dict[str, Any]:
        """One constrained turn. Returns the parsed object."""
        payload = {
            "model": settings.ollama_model,
            "stream": False,
            "format": schema,
            "options": {
                "temperature": settings.ollama_temperature,
                "num_ctx": settings.ollama_num_ctx,
                "num_predict": num_predict,
            },
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
        }
        data = await self._post("/api/chat", payload)
        content = (data.get("message") or {}).get("content", "").strip()
        if not content:
            raise OllamaError("Ollama returned an empty response")
        try:
            return json.loads(content)
        except json.JSONDecodeError as exc:
            raise OllamaError(f"Model did not return valid JSON: {content[:300]}") from exc


client = OllamaClient()
