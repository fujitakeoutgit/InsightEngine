"""The `q:` semantic search pipeline.

Six stages, of which only three involve the model, and none of those three let
it author card data:

  1. CONCEPTS   (model)  prose -> search concepts + literal rules-text phrases
  2. VOCABULARY (code)   concepts -> real oracle-tag slugs via FTS + hierarchy
  3. PLANS      (model)  concepts + tag menu -> several complementary filter sets
  4. EXECUTE    (code)   plans -> SQL -> union of real rows  [the candidate set]
  5. SELECT     (model)  numbered batches -> indices of relevant candidates
  6. SUMMARISE  (model)  counts and themes -> prose, then name-scanned

Stage 4 is the only source of card data. Stage 5 is batched so that *every*
candidate is examined rather than truncated to fit a context window -- the
thoroughness-over-speed tradeoff the design calls for.
"""

from __future__ import annotations

import asyncio
import sqlite3
from dataclasses import dataclass, field
from typing import Any, AsyncIterator

from ..config import settings
from ..query.filters import FilterError
from ..query.parser import Node, is_empty
from ..query.sql import IS_PREDICATES, QueryCompileError
from ..query.sql import compile_node
from ..search_local import search_mtg_database, search_node_limited, where_for
from ..tags import expand_descendants, known_slugs, search_tags
from . import prompts
from .guard import GuardReport, validate_indices
from .ollama import client as ollama

SELECTION_BATCH = 50
ORACLE_SNIPPET = 320
MAX_TAG_MENU = 40
# A tag carried by this many cards describes a rules mechanism, not a theme,
# and cannot discriminate between candidates.
GENERIC_TAG_CEILING = 2500
# How many of the retrieved tags the unconditional sweep covers.
TAG_SWEEP_WIDTH = 12


@dataclass
class Stage:
    """A progress event, streamed to the browser over SSE."""
    name: str
    message: str
    detail: dict[str, Any] = field(default_factory=dict)

    def as_dict(self) -> dict[str, Any]:
        return {"stage": self.name, "message": self.message, "detail": self.detail}


def _card_line(number: int, card: dict[str, Any]) -> str:
    text = (card.get("oracle_text") or "").replace("\n", " ")
    if len(text) > ORACLE_SNIPPET:
        text = text[:ORACLE_SNIPPET] + "..."
    return (
        f"{number}. {card['name']} | {card.get('mana_cost') or '-'} | "
        f"{card.get('type_line') or '-'} | {text or '(no rules text)'}"
    )


def _relax(filters: dict[str, Any]) -> dict[str, Any] | None:
    """Demote ANDed phrase lists to ORed ones.

    Planners reliably over-constrain: asking for cards whose text contains both
    "sacrifice a creature" AND "when this creature dies" matches nothing, while
    the same phrases ORed match thousands. Rather than lose the plan, it is
    retried in its relaxed form. Returns None when there is nothing to relax.
    """
    relaxed = dict(filters)
    changed = False

    for strict, loose in (("oracle_contains", "oracle_any"), ("type_contains", "type_any")):
        values = relaxed.get(strict)
        if isinstance(values, list) and len(values) > 1:
            merged = list(dict.fromkeys([*relaxed.get(loose, []), *values]))
            relaxed[loose] = merged
            relaxed.pop(strict)
            changed = True

    return relaxed if changed else None


def _global_constraints(concepts: dict[str, Any]) -> dict[str, Any]:
    """Color constraints that apply to the whole request, not to one plan."""
    constraints: dict[str, Any] = {}
    if required := (concepts.get("colors_required") or "").strip():
        constraints["color_identity"] = required
        constraints["color_identity_mode"] = "subset"
    if excluded := (concepts.get("colors_excluded") or "").strip():
        constraints["color_identity_exclude"] = excluded
    return constraints


def _apply_global(filters: dict[str, Any], constraints: dict[str, Any]) -> dict[str, Any]:
    """Force request-wide constraints onto a plan.

    A "nonblack" search previously leaked black cards: the constraint lived
    only in the prompt, so some plans remembered it and some did not, and the
    tag sweep had no idea about it at all. Applying it in code means every
    result honours it regardless of what any individual plan asked for.
    """
    if not constraints:
        return filters

    merged = dict(filters)
    if identity := constraints.get("color_identity"):
        merged["color_identity"] = identity
        merged["color_identity_mode"] = constraints.get("color_identity_mode", "subset")
    if excluded := constraints.get("color_identity_exclude"):
        existing = merged.get("color_identity_exclude", "")
        merged["color_identity_exclude"] = "".join(dict.fromkeys(f"{existing}{excluded}"))
    return merged


def _tag_menu(tags: list[dict]) -> str:
    return "\n".join(
        f"- {t['slug']} ({t['card_count']} cards): {t.get('description') or t.get('label') or ''}"
        for t in tags
    )


def run_plans(
    conn: sqlite3.Connection,
    plans: list[dict[str, Any]],
    structured: Node | None = None,
    tags: list[dict] | None = None,
    constraints: dict[str, Any] | None = None,
) -> tuple[list[dict], list[dict], list[str]]:
    """Plan execution, shared with the deck-recommendation pipeline.

    Both need identical plan sanitising, AND-to-OR rescue and tag sweep. The
    pipeline object holds nothing but a connection, so constructing one here
    is free and keeps a single implementation of that logic.
    """
    return SemanticPipeline(conn).execute_plans(plans, structured, tags, constraints)


class SemanticPipeline:
    def __init__(self, conn: sqlite3.Connection) -> None:
        self.conn = conn

    # -- stage 1 -----------------------------------------------------------

    async def extract_concepts(self, prompt: str) -> dict[str, Any]:
        return await ollama.chat_json(
            prompts.CONCEPT_SYSTEM,
            f"User request: {prompt}",
            prompts.CONCEPT_SCHEMA,
            num_predict=1024,
        )

    # -- stage 2 (deterministic) ------------------------------------------

    def gather_tags(self, concepts: list[str], prompt: str) -> list[dict]:
        """Retrieve real tags for every concept, in relevance order.

        Order matters more than it looks. Sorting by card_count puts the most
        generic tags first ('triggered-ability', 9k cards), which carry almost
        no signal and crowd the menu. FTS relevance order is preserved instead,
        and tags so broad they cannot discriminate are dropped outright.
        """
        seen: dict[str, dict] = {}
        for phrase in [prompt, *concepts]:
            for tag in search_tags(self.conn, phrase, limit=10):
                if tag["card_count"] > GENERIC_TAG_CEILING:
                    continue
                seen.setdefault(tag["slug"], tag)
        return list(seen.values())[:MAX_TAG_MENU]

    # -- stage 3 -----------------------------------------------------------

    async def build_plans(
        self, prompt: str, concepts: dict[str, Any], tags: list[dict]
    ) -> list[dict[str, Any]]:
        user = (
            f"User request: {prompt}\n\n"
            f"Interpretation: {concepts.get('interpretation', '')}\n"
            f"Concepts: {', '.join(concepts.get('concepts', []))}\n"
            f"Likely rules-text phrases: {'; '.join(concepts.get('oracle_phrases', []))}\n\n"
            f"MENU OF REAL ORACLE TAGS (use slugs verbatim, or none):\n{_tag_menu(tags)}\n\n"
            f"Write up to {settings.semantic_max_plans} complementary plans."
        )
        payload = await ollama.chat_json(
            prompts.PLAN_SYSTEM, user, prompts.PLAN_SCHEMA, num_predict=3072
        )
        return payload.get("plans", [])[: settings.semantic_max_plans]

    # -- stage 4 (deterministic) ------------------------------------------

    def execute_plans(
        self,
        plans: list[dict[str, Any]],
        structured: Node | None,
        tags: list[dict] | None = None,
        constraints: dict[str, Any] | None = None,
    ) -> tuple[list[dict], list[dict], list[str]]:
        """Run every plan and union the rows. Returns (cards, plan_stats, warnings)."""
        constraints = constraints or {}
        candidates: dict[str, dict] = {}
        stats: list[dict] = []
        warnings: list[str] = []

        for plan in plans:
            filters = plan.get("filters") or {}
            rationale = plan.get("rationale", "")

            # Invented `is:` values are common ("is: sacrifice outlet"). Drop
            # the unrecognised ones rather than losing the whole plan.
            if raw_flags := filters.get("is"):
                if isinstance(raw_flags, list):
                    real = [f for f in raw_flags
                            if isinstance(f, str) and f.lower() in IS_PREDICATES]
                    if dropped := [f for f in raw_flags if f not in real]:
                        warnings.append(f"ignored unknown is: values: {', '.join(map(str, dropped))}")
                    if real:
                        filters["is"] = real
                    else:
                        filters.pop("is")

            # Drop invented tags before validation so one bad slug does not
            # discard an otherwise good plan.
            if raw_tags := filters.get("oracle_tags"):
                if isinstance(raw_tags, list):
                    real = known_slugs(self.conn, [t for t in raw_tags if isinstance(t, str)])
                    dropped = [t for t in raw_tags if t not in real]
                    if dropped:
                        warnings.append(f"ignored non-existent tags: {', '.join(map(str, dropped))}")
                    expanded = sorted(expand_descendants(self.conn, real)) if real else []
                    if expanded:
                        filters["oracle_tags"] = expanded
                    else:
                        filters.pop("oracle_tags")

            if not filters:
                stats.append({"rationale": rationale, "matched": 0, "error": "empty plan"})
                continue

            extra = structured if structured and not is_empty(structured) else None
            filters = _apply_global(filters, constraints)

            # One malformed plan must never end the run. A planner that emits a
            # regex where a color belongs is a bad plan, not a broken search --
            # it is discarded with a warning and the remaining plans proceed.
            try:
                rows = search_mtg_database(
                    self.conn, filters, limit=settings.semantic_candidate_cap, extra=extra,
                )
            except (FilterError, QueryCompileError) as exc:
                warnings.append(f"discarded plan ({exc})")
                stats.append({"rationale": rationale, "matched": 0, "error": str(exc)})
                continue
            except Exception as exc:  # noqa: BLE001 - never let a plan abort the run
                warnings.append(f"plan failed ({type(exc).__name__}: {exc})")
                stats.append({"rationale": rationale, "matched": 0, "error": str(exc)})
                continue

            # Recall rescue: an empty plan is usually an over-constrained AND.
            relaxed_note = ""
            if not rows and (relaxed := _relax(filters)):
                try:
                    rows = search_mtg_database(
                        self.conn, relaxed, limit=settings.semantic_candidate_cap, extra=extra,
                    )
                except (FilterError, QueryCompileError):
                    rows = []
                if rows:
                    filters = relaxed
                    relaxed_note = " (relaxed AND→OR)"

            for row in rows:
                candidates.setdefault(row["oracle_id"], row)
            stats.append({
                "rationale": rationale + relaxed_note,
                "filters": filters,
                "matched": len(rows),
            })

        # Recall floor: sweep the retrieved tags directly, always. Two runs of
        # the same query produced disjoint gaps -- one missed every sacrifice
        # *land* because its plans were creature-shaped. This costs one SQL
        # query and no model call, so it runs unconditionally rather than as a
        # fallback: recall must not depend on the planner having a good day.
        if tags:
            slugs = [t["slug"] for t in tags[:TAG_SWEEP_WIDTH]]
            expanded = sorted(expand_descendants(self.conn, slugs))
            rows = search_mtg_database(
                self.conn, _apply_global({"oracle_tags": expanded}, constraints),
                limit=settings.semantic_candidate_cap,
                extra=structured if structured and not is_empty(structured) else None,
            )
            added = sum(1 for r in rows if r["oracle_id"] not in candidates)
            for row in rows:
                candidates.setdefault(row["oracle_id"], row)
            stats.append({
                "rationale": f"tag sweep — automatic, {len(expanded)} tags, "
                             f"{added} card(s) no plan found",
                "matched": len(rows),
                "added": added,
            })

        ordered = sorted(
            candidates.values(),
            key=lambda c: (c.get("edhrec_rank") is None, c.get("edhrec_rank") or 0),
        )
        return ordered[: settings.semantic_candidate_cap], stats, warnings

    # -- stage 5 -----------------------------------------------------------

    async def select_batch(
        self, prompt: str, batch: list[dict], report: GuardReport
    ) -> list[dict]:
        listing = "\n".join(_card_line(i + 1, c) for i, c in enumerate(batch))
        user = (
            f"User request: {prompt}\n\n"
            f"CANDIDATE CARDS ({len(batch)} of them):\n{listing}\n\n"
            f"Reply with the index numbers (1-{len(batch)}) of the cards that match."
        )
        payload = await ollama.chat_json(
            prompts.SELECT_SYSTEM, user, prompts.SELECT_SCHEMA, num_predict=1024
        )
        valid, invalid = validate_indices(payload.get("relevant"), len(batch))
        report.invalid_indices.extend(invalid)
        return [batch[i] for i in valid]

    # -- orchestration -----------------------------------------------------

    def prefilter_count(self, structured: Node | None) -> int | None:
        """How many cards the non-`q:` half of the query matches on its own."""
        if structured is None or is_empty(structured):
            return None
        compiled = compile_node(structured)
        where = where_for(compiled)
        return self.conn.execute(
            f"SELECT COUNT(*) AS n FROM cards WHERE {where}", list(compiled.params)
        ).fetchone()["n"]

    async def run(
        self, prompt: str, structured: Node | None = None
    ) -> AsyncIterator[Stage]:
        report = GuardReport()

        # When the structured filters already narrow the corpus below the
        # candidate cap, planning is pure overhead: two model calls -- minutes
        # -- spent generating queries whose results get intersected back down
        # to a set we can simply enumerate. Evaluating that set directly is
        # both faster and strictly more exhaustive, because no plan can miss a
        # card that the filters already selected.
        narrow = self.prefilter_count(structured)
        if narrow is not None and 0 < narrow <= settings.semantic_candidate_cap:
            yield Stage("execute", f"Structured filters match {narrow} cards; planning skipped", {
                "prefiltered": narrow,
            })
            candidates = await asyncio.to_thread(
                search_node_limited, self.conn, structured,
                limit=settings.semantic_candidate_cap,
            )
            async for step in self._evaluate(prompt, candidates, report, stats=[
                {"rationale": "structured pre-filter (exhaustive, no planning needed)",
                 "matched": len(candidates)},
            ], warnings=[]):
                yield step
            return

        yield Stage("concepts", "Interpreting the request")
        concepts = await self.extract_concepts(prompt)
        constraints = _global_constraints(concepts)
        yield Stage("concepts", concepts.get("interpretation", "Interpreted"), {
            "concepts": concepts.get("concepts", []),
            "oracle_phrases": concepts.get("oracle_phrases", []),
            "constraints": constraints,
        })

        yield Stage("vocabulary", "Retrieving oracle tags")
        tags = await asyncio.to_thread(
            self.gather_tags, concepts.get("concepts", []), prompt
        )
        yield Stage("vocabulary", f"{len(tags)} real tags retrieved", {
            "tags": [{"slug": t["slug"], "count": t["card_count"]} for t in tags],
        })

        yield Stage("plans", "Writing query plans")
        plans = await self.build_plans(prompt, concepts, tags)
        yield Stage("plans", f"{len(plans)} plans written", {
            "rationales": [p.get("rationale", "") for p in plans],
        })

        yield Stage("execute", "Querying the database")
        candidates, stats, warnings = await asyncio.to_thread(
            self.execute_plans, plans, structured, tags, constraints
        )
        yield Stage("execute", f"{len(candidates)} candidate cards", {
            "plans": stats, "warnings": warnings,
        })

        async for step in self._evaluate(
            prompt, candidates, report, stats=stats, warnings=warnings,
            extra={
                "interpretation": concepts.get("interpretation", ""),
                "tags": [t["slug"] for t in tags],
            },
        ):
            yield step

    async def _evaluate(
        self,
        prompt: str,
        candidates: list[dict],
        report: GuardReport,
        *,
        stats: list[dict],
        warnings: list[str],
        extra: dict[str, Any] | None = None,
    ) -> AsyncIterator[Stage]:
        """Grade candidates in batches and emit the terminal stage.

        Shared by both entry paths so the planned and pre-filtered routes end
        identically, including the guard report.
        """
        if not candidates:
            yield Stage("complete", "No cards matched", {
                "cards": [], "guard": report.as_dict(), "plans": stats,
                "warnings": warnings, "candidate_count": 0, **(extra or {}),
            })
            return

        batches = [
            candidates[i:i + SELECTION_BATCH]
            for i in range(0, len(candidates), SELECTION_BATCH)
        ]
        selected: list[dict] = []
        for number, batch in enumerate(batches, start=1):
            yield Stage("evaluate", f"Evaluating batch {number} of {len(batches)}", {
                "batch": number, "batches": len(batches), "size": len(batch),
            })
            selected.extend(await self.select_batch(prompt, batch, report))

        selected.sort(key=lambda c: (c.get("edhrec_rank") is None, c.get("edhrec_rank") or 0))
        selected = selected[: settings.semantic_return_cap]

        yield Stage("complete", f"{len(selected)} cards selected", {
            "cards": selected,
            "guard": report.as_dict(),
            "plans": stats,
            "warnings": warnings,
            "candidate_count": len(candidates),
            **(extra or {}),
        })
