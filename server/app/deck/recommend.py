"""Deck recommendations.

Deliberately deterministic: no model is involved, so a recommendation can only
ever be a card that exists, and the same deck always produces the same advice.

The deck's *themes* come from Scryfall Tagger's oracle tags. A tag is
interesting when it is common inside the deck but uncommon across the corpus --
"activated-ability" appears on 9,000 cards and says nothing, while
"sacrifice-outlet-creature" appearing on eight of your cards is the whole point
of the deck. That ratio is what gets ranked, and cards carrying the surviving
tags are then filtered to what is actually playable in this deck: inside the
commander's colour identity, legal in the format, and not already included.
"""

from __future__ import annotations

import math
import sqlite3
from dataclasses import dataclass
from typing import Any

from ..search_local import LIST_COLUMNS
from ..db import row_to_card
from .resolver import Resolution

# Tags on more than this share of the corpus describe a rules mechanism rather
# than a deck theme.
GENERIC_TAG_SHARE = 0.06
MIN_DECK_OCCURRENCES = 2
MAX_THEMES = 14
CANDIDATES_PER_THEME = 60


@dataclass
class Theme:
    slug: str
    in_deck: int
    corpus: int
    score: float

    def as_dict(self) -> dict[str, Any]:
        return {
            "slug": self.slug,
            "in_deck": self.in_deck,
            "corpus": self.corpus,
            "score": round(self.score, 3),
        }


def _deck_cards(resolutions: list[Resolution]) -> list[dict[str, Any]]:
    return [r.card for r in resolutions if r.card and r.section != "maybeboard"]


def derive_themes(conn: sqlite3.Connection, oracle_ids: list[str]) -> list[Theme]:
    """Rank the deck's tags by how much they distinguish it from the corpus."""
    if not oracle_ids:
        return []

    total_cards = conn.execute(
        "SELECT COUNT(*) AS n FROM cards WHERE digital = 0"
    ).fetchone()["n"] or 1
    ceiling = total_cards * GENERIC_TAG_SHARE

    placeholders = ",".join("?" * len(oracle_ids))
    rows = conn.execute(
        f"""
        SELECT tc.slug AS slug, COUNT(*) AS in_deck, t.card_count AS corpus
        FROM tag_cards tc
        JOIN tags t ON t.slug = tc.slug
        WHERE tc.oracle_id IN ({placeholders})
          AND t.card_count > 0
          AND t.card_count <= ?
        GROUP BY tc.slug
        HAVING in_deck >= ?
        """,
        (*oracle_ids, ceiling, MIN_DECK_OCCURRENCES),
    ).fetchall()

    themes = [
        Theme(
            slug=row["slug"],
            in_deck=row["in_deck"],
            corpus=row["corpus"],
            # Frequency in the deck against rarity in the corpus.
            score=(row["in_deck"] / len(oracle_ids)) * math.log(total_cards / row["corpus"]),
        )
        for row in rows
    ]
    themes.sort(key=lambda t: t.score, reverse=True)
    return themes[:MAX_THEMES]


def recommend(
    conn: sqlite3.Connection,
    resolutions: list[Resolution],
    *,
    format_key: str | None = None,
    limit: int = 40,
) -> dict[str, Any]:
    cards = _deck_cards(resolutions)
    if not cards:
        return {"themes": [], "recommendations": [], "note": "No resolved cards to work from."}

    owned = {c["oracle_id"] for c in cards}
    themes = derive_themes(conn, sorted(owned))
    if not themes:
        return {
            "themes": [],
            "recommendations": [],
            "note": "No distinctive themes found — the deck's cards share no uncommon tags.",
        }

    # Colour identity ceiling: the commander's, or the union of the deck's.
    commanders = [r.card for r in resolutions if r.card and r.section == "commander"]
    if commanders:
        allowed = set()
        for card in commanders:
            allowed |= set(card.get("color_identity") or "")
    else:
        allowed = set()
        for card in cards:
            allowed |= set(card.get("color_identity") or "")

    outside = [c for c in "WUBRG" if c not in allowed]

    where = ["c.digital = 0", "c.is_funny = 0"]
    params: list[Any] = []
    for letter in outside:
        where.append("instr(c.color_identity, ?) = 0")
        params.append(letter)
    if format_key:
        where.append("json_extract(c.legalities, ?) = 'legal'")
        params.append(f"$.{format_key}")

    slugs = [t.slug for t in themes]
    theme_weight = {t.slug: t.score for t in themes}

    rows = conn.execute(
        f"""
        SELECT {', '.join('c.' + col.strip() for col in LIST_COLUMNS.split(','))},
               GROUP_CONCAT(tc.slug) AS matched
        FROM cards c
        JOIN tag_cards tc ON tc.oracle_id = c.oracle_id
        WHERE tc.slug IN ({','.join('?' * len(slugs))})
          AND {' AND '.join(where)}
        GROUP BY c.oracle_id
        ORDER BY (c.edhrec_rank IS NULL), c.edhrec_rank ASC
        LIMIT ?
        """,
        (*slugs, *params, CANDIDATES_PER_THEME * len(slugs)),
    ).fetchall()

    scored: list[tuple[float, dict[str, Any], list[str]]] = []
    for row in rows:
        if row["oracle_id"] in owned:
            continue
        matched = sorted(set((row["matched"] or "").split(",")) & set(slugs))
        if not matched:
            continue
        # Sum the themes it hits, nudged by how played the card is.
        relevance = sum(theme_weight[s] for s in matched)
        rank = row["edhrec_rank"] or 500_000
        popularity = 1 / math.log(rank + math.e)
        card = row_to_card(row)
        card.pop("matched", None)  # join artefact, not part of the card shape
        scored.append((relevance + popularity, card, matched))

    scored.sort(key=lambda item: item[0], reverse=True)

    return {
        "themes": [t.as_dict() for t in themes],
        "color_identity": "".join(sorted(allowed)),
        "format": format_key,
        "recommendations": [
            {"card": card, "because": matched, "score": round(score, 3)}
            for score, card, matched in scored[:limit]
        ],
        "note": None,
    }
