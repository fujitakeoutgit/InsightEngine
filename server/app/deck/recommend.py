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
import re
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
MAX_THEMES = 20
CANDIDATES_PER_THEME = 120

# A theme scoring below this fraction of the best one is *supporting*: real,
# but not what makes the deck this deck. Cards are only suggested for matching
# a signature theme, which is what stops the list filling with staples.
SIGNATURE_RATIO = 0.45

#: The four jobs every deck does, as the tags that describe them. Grouped so a
#: category can be asked for deliberately (see CATEGORY_TAGS) and so the
#: redemption rule below can speak about a whole family at once.
RAMP_TAGS = {
    "ramp", "land-ramp", "multi-land-ramp", "combat-ramp", "ramp-with-set-s-mechanic",
    "mana-rock", "utility-mana-rock", "mana-rock-with-set-s-mechanic",
    "mana-dork", "mana-dork-egg",
    "adds-multiple-mana", "manaless-value", "mana-fixing", "cost-reduction",
    "tutor-land-basic", "tutor-land-to-battlefield", "fetchland",
}

REMOVAL_TAGS = {
    "spot-removal", "removal-creature", "repeatable-removal", "removal-destroy",
    "multi-removal", "removal-toughness", "removal-exile", "removal-nonland",
    "removal-sacrifice", "removal-bounce", "removal-artifact", "removal-land",
    "mass-removal", "board-wipe", "single-target-instant-sorcery",
}

COUNTER_TAGS = {
    "counterspell", "counterspell-soft", "counterspell-reusable",
    "counterspell-ability", "counterspell-creature", "counterspell-exile",
    "counterspell-automatic", "counterspell-with-set-mechanic",
}

DRAW_TAGS = {
    "draw-engine", "repeatable-pure-draw", "pure-draw", "burst-draw", "cantrip",
    "delayed-cantrip", "card-advantage", "repeatable-card-advantage",
    "impulsive-draw", "repeatable-impulsive-draw", "long-term-impulsive-draw",
}

CATEGORY_TAGS: dict[str, set[str]] = {
    "ramp": RAMP_TAGS,
    "removal": REMOVAL_TAGS,
    "counterspell": COUNTER_TAGS,
    "draw": DRAW_TAGS,
}

# Tags describing a generic job any deck wants done. On their own they are
# never a reason to play a card here -- "it ramps" is true of a thousand cards.
# They stay in the theme list (they are informative) but never qualify a
# recommendation by themselves.
FUNCTIONAL_TAGS = RAMP_TAGS | REMOVAL_TAGS | COUNTER_TAGS | DRAW_TAGS | {
    "evasion", "combat-trick", "tapper-creature", "lifegain",
    "unique-type-line", "alliteration", "french-vanilla",
}

# ...unless the deck is specifically built to care. A landfall deck really does
# want land ramp, and that is a synergy rather than a staple. Each entry reads
# "these functional tags stop being generic when the deck carries any of these
# payoffs", so redemption has to be earned by something already in the deck.
REDEEMED_BY: list[tuple[set[str], set[str]]] = [
    (
        {"land-ramp", "multi-land-ramp", "tutor-land-basic",
         "tutor-land-to-battlefield", "fetchland"},
        {"landfall", "landfall-other", "lands-matter", "land-count-matters",
         "differently-named-lands-matter", "sacrifice-outlet-land",
         "graveyard-lands", "land-animation"},
    ),
    (
        COUNTER_TAGS | {"single-target-instant-sorcery"},
        {"magecraft", "prowess-anthem", "gives-prowess", "gains-prowess",
         "off-turn-casting-matters", "cost-reducer-instant-sorcery"},
    ),
    (
        DRAW_TAGS,
        {"draw-matters", "second-draw-matters", "force-draw", "draw-hate"},
    ),
    (
        {"mana-rock", "utility-mana-rock", "mana-dork", "adds-multiple-mana"},
        {"artifacts-matter", "affinity", "improvise", "untap-permanent",
         "big-mana-payoff", "mana-sink"},
    ),
]


# Words that carry no theme, so a description containing them does not promote
# whatever tag happens to share the letters.
_STOPWORDS = {
    "this", "that", "with", "from", "then", "them", "they", "have", "into",
    "your", "when", "what", "which", "while", "will", "would", "about",
    "deck", "card", "cards", "play", "plays", "played", "playing", "game",
    "table", "turn", "turns", "some", "most", "much", "many", "more", "over",
    "also", "just", "like", "want", "wants", "make", "makes", "made", "good",
    "very", "lots", "well", "keep", "keeps", "does", "doing", "back",
}

# How much an explicitly described theme outranks the same theme derived from
# the cards alone. Enough to clear the signature cutoff from mid-table, not
# enough to overturn a theme the deck demonstrably revolves around.
DESCRIPTION_BOOST = 1.6

_WORD = re.compile(r"[a-z]{4,}")


def description_terms(description: str | None) -> set[str]:
    """Content words from the builder's description, for matching tag slugs.

    Crude on purpose. This only ever *reweights themes the deck already has* --
    it cannot introduce one -- so a loose match costs a bit of ranking, never a
    card that does not belong. Anything cleverer than substring matching wants
    the model, and that is what AI mode is for.
    """
    if not description:
        return set()
    terms: set[str] = set()
    for word in _WORD.findall(description.lower()):
        if word in _STOPWORDS:
            continue
        terms.add(word)
        # Tag slugs are singular ("token-maker", not "tokens-maker"), and
        # builders write prose, so shed a plural before matching.
        if word.endswith("s") and len(word) > 4:
            terms.add(word[:-1])
    return terms


def _describes(slug: str, terms: set[str]) -> bool:
    return any(term in slug for term in terms)


@dataclass
class Theme:
    slug: str
    in_deck: int
    corpus: int
    score: float
    signature: bool = False
    #: The builder's description named this theme.
    described: bool = False

    def as_dict(self) -> dict[str, Any]:
        return {
            "slug": self.slug,
            "in_deck": self.in_deck,
            "corpus": self.corpus,
            "score": round(self.score, 3),
            "signature": self.signature,
            "described": self.described,
        }


def _deck_cards(resolutions: list[Resolution]) -> list[dict[str, Any]]:
    return [r.card for r in resolutions if r.card and r.section != "maybeboard"]


def derive_themes(
    conn: sqlite3.Connection,
    oracle_ids: list[str],
    description: str | None = None,
) -> list[Theme]:
    """Rank the deck's tags by how much they distinguish it from the corpus.

    A decklist states what a deck contains; the description states what it is
    *for*. Where the two agree, the description settles which of several
    plausible themes is the point -- a sacrifice deck and a tokens deck share
    most of their tags, and the cards alone cannot say which one you built. The
    description can only boost tags the deck already carries, so it steers the
    ranking without ever putting an unrelated card in front of you.
    """
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
    terms = description_terms(description)
    if terms:
        for theme in themes:
            if _describes(theme.slug, terms):
                theme.score *= DESCRIPTION_BOOST
                theme.described = True

    themes.sort(key=lambda t: t.score, reverse=True)
    themes = themes[:MAX_THEMES]

    # Signature themes are what make this deck distinctive; everything else is
    # supporting. A purely functional tag is never signature no matter how it
    # scores, because "this deck plays mana rocks" recommends every mana rock
    # ever printed.
    if themes:
        present = {t.slug for t in themes}
        # A functional family is only generic until the deck proves it cares.
        redeemed: set[str] = set()
        for family, payoffs in REDEEMED_BY:
            if present & payoffs:
                redeemed |= family

        cutoff = themes[0].score * SIGNATURE_RATIO
        for theme in themes:
            generic = theme.slug in FUNCTIONAL_TAGS and theme.slug not in redeemed
            theme.signature = theme.score >= cutoff and not generic
        # If the denylist removed every candidate, fall back to the best
        # non-functional theme rather than returning nothing at all. Falling
        # back to themes[0] unconditionally was how "land ramp" became a
        # signature theme and filled the list with Cultivate and Harrow.
        if not any(t.signature for t in themes):
            fallback = next((t for t in themes if t.slug not in FUNCTIONAL_TAGS), None)
            if fallback:
                fallback.signature = True

    return themes


def _identity_filter(
    resolutions: list[Resolution],
    cards: list[dict[str, Any]],
    format_key: str | None,
) -> tuple[list[str], list[Any], str]:
    """Colour-identity ceiling and format legality, shared by both entry points."""
    commanders = [r.card for r in resolutions if r.card and r.section == "commander"]
    source = commanders or cards
    allowed: set[str] = set()
    for card in source:
        allowed |= set(card.get("color_identity") or "")

    where = ["c.digital = 0", "c.is_funny = 0"]
    params: list[Any] = []
    for letter in (c for c in "WUBRG" if c not in allowed):
        where.append("instr(c.color_identity, ?) = 0")
        params.append(letter)
    if format_key:
        where.append("json_extract(c.legalities, ?) = 'legal'")
        params.append(f"$.{format_key}")
    return where, params, "".join(sorted(allowed))


def recommend_category(
    conn: sqlite3.Connection,
    resolutions: list[Resolution],
    category: str,
    *,
    format_key: str | None = None,
    limit: int = 60,
) -> dict[str, Any]:
    """The best cards of one functional kind, asked for deliberately.

    Ramp, removal, counterspells and draw are barred from theme-driven
    recommendations because they are true of a thousand cards. That makes them
    invisible, not unwanted -- so they get their own request, ranked by how
    played they are rather than by how well they fit a theme.
    """
    tags = CATEGORY_TAGS.get(category)
    if not tags:
        raise ValueError(f"Unknown category '{category}'")

    cards = _deck_cards(resolutions)
    owned = {c["oracle_id"] for c in cards}
    where, params, identity = _identity_filter(resolutions, cards, format_key)
    slugs = sorted(tags)

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
        (*slugs, *params, limit + len(owned) + 40),
    ).fetchall()

    out = []
    for row in rows:
        if row["oracle_id"] in owned:
            continue
        matched = sorted(set((row["matched"] or "").split(",")) & tags)
        card = row_to_card(row)
        card.pop("matched", None)
        out.append({"card": card, "because": matched, "score": 0.0})
        if len(out) >= limit:
            break

    return {
        "themes": [],
        "color_identity": identity,
        "format": format_key,
        "category": category,
        "recommendations": out,
        "note": f"Most-played {category} in these colours, by EDHREC rank.",
    }


def recommend(
    conn: sqlite3.Connection,
    resolutions: list[Resolution],
    *,
    format_key: str | None = None,
    limit: int = 150,
    description: str | None = None,
) -> dict[str, Any]:
    cards = _deck_cards(resolutions)
    if not cards:
        return {"themes": [], "recommendations": [], "note": "No resolved cards to work from."}

    owned = {c["oracle_id"] for c in cards}
    themes = derive_themes(conn, sorted(owned), description)
    if not themes:
        return {
            "themes": [],
            "recommendations": [],
            "note": "No distinctive themes found — the deck's cards share no uncommon tags.",
        }

    where, params, identity = _identity_filter(resolutions, cards, format_key)
    slugs = [t.slug for t in themes]
    theme_weight = {t.slug: t.score for t in themes}
    signature = {t.slug for t in themes if t.signature}

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
        # Matching only supporting themes means the card is a generic staple
        # in these colours, not something this deck wants. Requiring a
        # signature hit is what keeps ramp and removal out of the list.
        if not (set(matched) & signature):
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
        "color_identity": identity,
        "format": format_key,
        "recommendations": [
            {"card": card, "because": matched, "score": round(score, 3)}
            for score, card, matched in scored[:limit]
        ],
        "note": None,
    }
