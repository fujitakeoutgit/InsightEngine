"""The AI deck-recommendation pipeline.

Separate from the `q:` search pipeline because the question is different. Search
asks "which cards match this description"; this asks "which cards would make
*this* deck better", which needs the deck's own contents in front of the model
and a much harsher relevance bar — a generically strong card is not a
recommendation.

Five stages, three of them model calls, none of which let the model author card
data:

  1. READ       (model)  decklist + its tags -> strategy, wanted roles, avoids
  2. VOCABULARY (code)   wanted roles -> real oracle-tag slugs
  3. PLAN       (model)  roles + tag menu -> filter sets, colour/format bound
  4. QUERY      (code)   plans -> SQL -> rows, minus what the deck already runs
  5. JUDGE      (model)  numbered batches -> indices worth adding

The deterministic recommender in `deck/recommend.py` stays as the instant path;
this one trades minutes for judgement about the deck as a whole.
"""

from __future__ import annotations

import asyncio
import sqlite3
from typing import Any, AsyncIterator

from ..config import settings
from ..deck.recommend import derive_themes
from ..deck.resolver import Resolution
from ..tags import search_tags
from . import prompts
from .guard import GuardReport, validate_indices
from .ollama import client as ollama
from .pipeline import GENERIC_TAG_CEILING, MAX_TAG_MENU, SELECTION_BATCH, Stage, _tag_menu, run_plans

# A deck is small; showing the model all of it is affordable and far more
# useful than a sample.
MAX_DECK_LINES = 120
ORACLE_SNIPPET = 220


def _deck_listing(resolutions: list[Resolution]) -> str:
    lines: list[str] = []
    for res in resolutions[:MAX_DECK_LINES]:
        card = res.card
        if not card:
            continue
        role = "COMMANDER" if res.section == "commander" else ""
        lines.append(
            f"- {card['name']} | {card.get('mana_cost') or '-'} | "
            f"{card.get('type_line') or '-'} {role}".rstrip()
        )
    return "\n".join(lines)


def _candidate_line(number: int, card: dict[str, Any]) -> str:
    text = (card.get("oracle_text") or "").replace("\n", " ")
    if len(text) > ORACLE_SNIPPET:
        text = text[:ORACLE_SNIPPET] + "..."
    return (
        f"{number}. {card['name']} | {card.get('mana_cost') or '-'} | "
        f"{card.get('type_line') or '-'} | {text or '(no rules text)'}"
    )


class DeckRecommendPipeline:
    def __init__(self, conn: sqlite3.Connection) -> None:
        self.conn = conn

    # -- stage 1 -----------------------------------------------------------

    async def read_deck(
        self, listing: str, themes: list[str], description: str | None = None,
    ) -> dict[str, Any]:
        user = (
            # The builder's own words lead: they state intent that a card list
            # can only imply, and they are the cheapest accuracy win available.
            (f"THE BUILDER DESCRIBES THIS DECK AS:\n{description.strip()}\n\n"
             if description and description.strip() else "")
            + f"DECK:\n{listing}\n\n"
            + f"Oracle tags concentrated in this deck: {', '.join(themes) or 'none'}\n\n"
            + "What is this deck's engine, and what effects would strengthen it?"
        )
        return await ollama.chat_json(
            prompts.DECK_READ_SYSTEM, user, prompts.DECK_READ_SCHEMA, num_predict=1024
        )

    # -- stage 2 (deterministic) ------------------------------------------

    def gather_tags(self, roles: list[str], strategy: str) -> list[dict]:
        seen: dict[str, dict] = {}
        for phrase in [strategy, *roles]:
            for tag in search_tags(self.conn, phrase, limit=10):
                if tag["card_count"] > GENERIC_TAG_CEILING:
                    continue
                seen.setdefault(tag["slug"], tag)
        return list(seen.values())[:MAX_TAG_MENU]

    # -- stage 3 -----------------------------------------------------------

    async def build_plans(
        self, read: dict[str, Any], tags: list[dict], identity: str, format_key: str | None
    ) -> list[dict[str, Any]]:
        user = (
            f"Deck strategy: {read.get('strategy', '')}\n"
            f"Effects wanted: {'; '.join(read.get('wanted_roles', []))}\n"
            f"Effects to avoid: {'; '.join(read.get('avoid', []))}\n\n"
            f"MENU OF REAL ORACLE TAGS (use slugs verbatim, or none):\n{_tag_menu(tags)}\n\n"
            f"Colour identity available: {identity or 'colourless only'}\n"
            f"{f'Format: {format_key}' if format_key else ''}\n\n"
            f"Write up to {settings.semantic_max_plans} complementary plans that find "
            "cards to ADD."
        )
        payload = await ollama.chat_json(
            prompts.DECK_PLAN_SYSTEM, user, prompts.PLAN_SCHEMA, num_predict=3072
        )
        return payload.get("plans", [])[: settings.semantic_max_plans]

    # -- stage 5 -----------------------------------------------------------

    async def judge(
        self, strategy: str, batch: list[dict], report: GuardReport
    ) -> list[dict]:
        listing = "\n".join(_candidate_line(i + 1, c) for i, c in enumerate(batch))
        user = (
            f"Deck strategy: {strategy}\n\n"
            f"CANDIDATE CARDS ({len(batch)}):\n{listing}\n\n"
            f"Reply with the index numbers (1-{len(batch)}) worth adding to this deck."
        )
        payload = await ollama.chat_json(
            prompts.DECK_SELECT_SYSTEM, user, prompts.SELECT_SCHEMA, num_predict=1024
        )
        valid, invalid = validate_indices(payload.get("relevant"), len(batch))
        report.invalid_indices.extend(invalid)
        return [batch[i] for i in valid]

    # -- orchestration -----------------------------------------------------

    async def run(
        self,
        resolutions: list[Resolution],
        *,
        format_key: str | None = None,
        description: str | None = None,
    ) -> AsyncIterator[Stage]:
        report = GuardReport()

        owned = {r.card["oracle_id"] for r in resolutions if r.card}
        if not owned:
            yield Stage("complete", "No resolved cards to work from", {
                "recommendations": [], "guard": report.as_dict(),
            })
            return

        # Colour ceiling: the commander's identity, else the deck's union.
        commanders = [r.card for r in resolutions if r.card and r.section == "commander"]
        source = commanders or [r.card for r in resolutions if r.card]
        allowed = set()
        for card in source:
            allowed |= set(card.get("color_identity") or "")
        identity = "".join(sorted(allowed))

        listing = _deck_listing(resolutions)
        themes = await asyncio.to_thread(derive_themes, self.conn, sorted(owned))
        theme_slugs = [t.slug for t in themes if t.signature]

        yield Stage("read", "Reading the deck")
        read = await self.read_deck(listing, theme_slugs, description)
        yield Stage("read", read.get("strategy", "Read"), {
            "strategy": read.get("strategy", ""),
            "wanted_roles": read.get("wanted_roles", []),
            "avoid": read.get("avoid", []),
            "themes": theme_slugs,
            "identity": identity,
        })

        yield Stage("vocabulary", "Retrieving oracle tags")
        tags = await asyncio.to_thread(
            self.gather_tags, read.get("wanted_roles", []), read.get("strategy", "")
        )
        yield Stage("vocabulary", f"{len(tags)} real tags retrieved", {
            "tags": [{"slug": t["slug"], "count": t["card_count"]} for t in tags],
        })

        yield Stage("plans", "Writing query plans")
        plans = await self.build_plans(read, tags, identity, format_key)
        yield Stage("plans", f"{len(plans)} plans written", {
            "rationales": [p.get("rationale", "") for p in plans],
        })

        yield Stage("execute", "Querying the database")
        constraints: dict[str, Any] = {}
        if identity:
            constraints = {"color_identity": identity, "color_identity_mode": "subset"}
        base_filters = {"legal_in": format_key} if format_key else {}
        for plan in plans:
            plan["filters"] = {**base_filters, **(plan.get("filters") or {})}

        candidates, stats, warnings = await asyncio.to_thread(
            run_plans, self.conn, plans, None, tags, constraints
        )
        # Never suggest what the deck already runs.
        candidates = [c for c in candidates if c["oracle_id"] not in owned]
        yield Stage("execute", f"{len(candidates)} candidates the deck does not run", {
            "plans": stats, "warnings": warnings,
        })

        if not candidates:
            yield Stage("complete", "Nothing to suggest", {
                "recommendations": [], "guard": report.as_dict(),
                "plans": stats, "warnings": warnings, "candidate_count": 0,
                "strategy": read.get("strategy", ""),
            })
            return

        batches = [
            candidates[i:i + SELECTION_BATCH]
            for i in range(0, len(candidates), SELECTION_BATCH)
        ]
        picked: list[dict] = []
        for number, batch in enumerate(batches, start=1):
            yield Stage("judge", f"Judging batch {number} of {len(batches)}", {
                "batch": number, "batches": len(batches), "size": len(batch),
            })
            picked.extend(await self.judge(read.get("strategy", ""), batch, report))

        picked.sort(key=lambda c: (c.get("edhrec_rank") is None, c.get("edhrec_rank") or 0))

        yield Stage("complete", f"{len(picked)} cards suggested", {
            "recommendations": [{"card": c, "because": [], "score": 0} for c in picked],
            "guard": report.as_dict(),
            "plans": stats,
            "warnings": warnings,
            "candidate_count": len(candidates),
            "strategy": read.get("strategy", ""),
            "wanted_roles": read.get("wanted_roles", []),
            "identity": identity,
        })
