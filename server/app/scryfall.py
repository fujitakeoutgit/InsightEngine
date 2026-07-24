"""Polite, cached async client for api.scryfall.com.

Scryfall ask for a descriptive User-Agent, an Accept header, and no more than
~10 requests per second. This client enforces all three centrally, layers a
two-tier cache (process memory, then SQLite) in front of every GET, and backs
off on 429. Nothing else in the app is permitted to call Scryfall directly.

Data source: Scryfall (https://scryfall.com). Card data and images are provided
by Scryfall under their API terms; Manafold is not affiliated with or endorsed
by Scryfall or Wizards of the Coast.
"""

from __future__ import annotations

import asyncio
import json
import time
from typing import Any

import httpx

from .config import settings
from .db import connect


class ScryfallError(RuntimeError):
    def __init__(self, status: int, detail: str) -> None:
        super().__init__(detail)
        self.status = status
        self.detail = detail


class _RateLimiter:
    """Serialises requests so consecutive calls are >= min_interval apart."""

    def __init__(self, min_interval: float) -> None:
        self._min_interval = min_interval
        self._lock = asyncio.Lock()
        self._last = 0.0

    async def __aenter__(self) -> None:
        await self._lock.acquire()
        delay = self._min_interval - (time.monotonic() - self._last)
        if delay > 0:
            await asyncio.sleep(delay)

    async def __aexit__(self, *exc: object) -> None:
        self._last = time.monotonic()
        self._lock.release()


class ScryfallClient:
    def __init__(self) -> None:
        self._client: httpx.AsyncClient | None = None
        self._limiter = _RateLimiter(settings.scryfall_min_interval)
        self._semaphore = asyncio.Semaphore(settings.scryfall_max_concurrency)
        self._memory: dict[str, tuple[float, Any]] = {}
        self._db = connect()

    async def start(self) -> None:
        self._client = httpx.AsyncClient(
            base_url=settings.scryfall_base,
            timeout=settings.scryfall_timeout,
            headers={
                "User-Agent": settings.scryfall_user_agent,
                "Accept": "application/json;q=0.9,*/*;q=0.8",
            },
            follow_redirects=True,
        )

    async def close(self) -> None:
        if self._client:
            await self._client.aclose()
            self._client = None
        self._db.close()

    # -- caching -----------------------------------------------------------

    @staticmethod
    def _key(path: str, params: dict[str, Any] | None) -> str:
        if not params:
            return path
        ordered = sorted((k, str(v)) for k, v in params.items() if v is not None)
        return path + "?" + "&".join(f"{k}={v}" for k, v in ordered)

    def _read_cache(self, key: str) -> Any | None:
        now = time.time()
        if (hit := self._memory.get(key)) and now - hit[0] < settings.cache_ttl_seconds:
            return hit[1]

        row = self._db.execute(
            "SELECT body, fetched_at FROM http_cache WHERE key = ?", (key,)
        ).fetchone()
        if row and now - row["fetched_at"] < settings.cache_ttl_seconds:
            payload = json.loads(row["body"])
            self._memory[key] = (row["fetched_at"], payload)
            return payload
        return None

    def _write_cache(self, key: str, payload: Any) -> None:
        now = time.time()
        if len(self._memory) >= settings.cache_max_entries:
            oldest = sorted(self._memory.items(), key=lambda kv: kv[1][0])
            for stale_key, _ in oldest[: len(oldest) // 4 or 1]:
                self._memory.pop(stale_key, None)
        self._memory[key] = (now, payload)
        self._db.execute(
            "INSERT INTO http_cache(key, body, fetched_at) VALUES(?, ?, ?) "
            "ON CONFLICT(key) DO UPDATE SET body = excluded.body, "
            "fetched_at = excluded.fetched_at",
            (key, json.dumps(payload), now),
        )
        self._db.commit()

    # -- transport ---------------------------------------------------------

    async def get(
        self, path: str, params: dict[str, Any] | None = None, *, use_cache: bool = True
    ) -> Any:
        key = self._key(path, params)
        if use_cache and (cached := await asyncio.to_thread(self._read_cache, key)):
            return cached

        if self._client is None:
            await self.start()
        assert self._client is not None

        last_error: ScryfallError | None = None
        for attempt in range(3):
            async with self._semaphore:
                async with self._limiter:
                    try:
                        resp = await self._client.get(path, params=params)
                    except httpx.RequestError as exc:
                        last_error = ScryfallError(502, f"Scryfall unreachable: {exc}")
                        continue

            if resp.status_code == 200:
                payload = resp.json()
                if use_cache:
                    await asyncio.to_thread(self._write_cache, key, payload)
                return payload

            if resp.status_code == 404:
                raise ScryfallError(404, "Not found on Scryfall")

            if resp.status_code == 429:
                # Respect the cool-off rather than retrying immediately.
                await asyncio.sleep(2 ** attempt)
                last_error = ScryfallError(429, "Rate limited by Scryfall")
                continue

            detail = "Scryfall error"
            try:
                detail = resp.json().get("details", detail)
            except Exception:  # noqa: BLE001 - error bodies are not guaranteed JSON
                pass
            raise ScryfallError(resp.status_code, detail)

        raise last_error or ScryfallError(502, "Scryfall request failed")

    # -- endpoints ---------------------------------------------------------

    async def search(
        self, query: str, *, page: int = 1, order: str = "name",
        direction: str = "auto", unique: str = "cards", include_extras: bool = False,
    ) -> dict:
        return await self.get("/cards/search", {
            "q": query, "page": page, "order": order, "dir": direction,
            "unique": unique,
            "include_extras": "true" if include_extras else "false",
        })

    async def autocomplete(self, fragment: str) -> list[str]:
        payload = await self.get("/cards/autocomplete", {"q": fragment})
        return payload.get("data", [])

    async def named(self, name: str, *, fuzzy: bool = True) -> dict:
        return await self.get("/cards/named", {"fuzzy" if fuzzy else "exact": name})

    async def card_by_id(self, scryfall_id: str) -> dict:
        return await self.get(f"/cards/{scryfall_id}")

    async def printings(self, card_name: str) -> list[dict]:
        """Every printing of a card, for the versions/prices table."""
        try:
            payload = await self.search(
                f'!"{card_name}"', unique="prints", order="released", direction="desc"
            )
        except ScryfallError as exc:
            if exc.status == 404:
                return []
            raise
        return payload.get("data", [])

    async def rulings(self, scryfall_id: str) -> list[dict]:
        payload = await self.get(f"/cards/{scryfall_id}/rulings")
        return payload.get("data", [])

    async def symbology(self) -> list[dict]:
        payload = await self.get("/symbology")
        return payload.get("data", [])

    async def keyword_catalog(self) -> dict[str, list[str]]:
        names = ("keyword-abilities", "keyword-actions", "ability-words")
        results = await asyncio.gather(
            *(self.get(f"/catalog/{n}") for n in names), return_exceptions=True
        )
        out: dict[str, list[str]] = {}
        for name, payload in zip(names, results):
            out[name.replace("-", "_")] = (
                payload.get("data", []) if isinstance(payload, dict) else []
            )
        return out


def normalize_card(obj: dict[str, Any]) -> dict[str, Any]:
    """Map a raw Scryfall card object onto Manafold's card shape.

    Proxied results and locally-served results must be indistinguishable to the
    frontend, otherwise every component has to know which engine answered.
    """
    images = obj.get("image_uris") or {}
    faces = obj.get("card_faces") or []
    if not images and faces:
        images = faces[0].get("image_uris") or {}

    prices = obj.get("prices") or {}
    try:
        usd = float(prices.get("usd") or prices.get("usd_foil") or 0) or None
    except (TypeError, ValueError):
        usd = None

    oracle_text = obj.get("oracle_text")
    if not oracle_text and faces:
        oracle_text = "\n//\n".join(f.get("oracle_text", "") for f in faces).strip()

    return {
        "oracle_id": obj.get("oracle_id") or (faces[0].get("oracle_id") if faces else None),
        "scryfall_id": obj.get("id"),
        "name": obj.get("name"),
        "mana_cost": obj.get("mana_cost") or (faces[0].get("mana_cost") if faces else None),
        "cmc": obj.get("cmc"),
        "type_line": obj.get("type_line") or (faces[0].get("type_line") if faces else None),
        "oracle_text": oracle_text,
        "power": obj.get("power"),
        "toughness": obj.get("toughness"),
        "loyalty": obj.get("loyalty"),
        "colors": "".join(obj.get("colors") or []),
        "color_identity": "".join(sorted(obj.get("color_identity") or [])),
        "keywords": obj.get("keywords") or [],
        "set_code": obj.get("set"),
        "set_name": obj.get("set_name"),
        "collector_number": obj.get("collector_number"),
        "rarity": obj.get("rarity"),
        "artist": obj.get("artist"),
        "released_at": obj.get("released_at"),
        "edhrec_rank": obj.get("edhrec_rank"),
        "reserved": bool(obj.get("reserved")),
        "game_changer": bool(obj.get("game_changer")),
        "legalities": obj.get("legalities") or {},
        "prices": prices,
        "usd": usd,
        "image_small": images.get("small"),
        "image_normal": images.get("normal"),
        "image_art_crop": images.get("art_crop"),
        "scryfall_uri": obj.get("scryfall_uri"),
        "card_faces": faces or None,
        "layout": obj.get("layout"),
    }


client = ScryfallClient()
