"""Deck composition statistics.

What replaces the format-legality wall: the numbers you actually look at while
building — where your pips are, whether your lands can pay for them, the curve
broken down by colour, and what the deck puts onto the battlefield.
"""

from __future__ import annotations

import json
import re
import sqlite3
from collections import Counter
from typing import Any

from .resolver import Resolution

COLOURS = ("W", "U", "B", "R", "G")

# A mana source has to stay on the battlefield to be one. Scryfall lists
# produced_mana for rituals too, and counting Dark Ritual as a black source
# would flatter every mana base that runs one.
_PERMANENT = re.compile(r"\b(Artifact|Creature|Enchantment|Planeswalker|Battle)\b")
_ONE_SHOT = re.compile(r"\b(Instant|Sorcery)\b")
CURVE_KEYS = ("0", "1", "2", "3", "4", "5", "6", "7+")

_SYMBOL = re.compile(r"\{([^}]+)\}")

# How many sources of a colour you want, by the heaviest number of that
# colour's pips on a single card. Frank Karsten's tables, rounded: enough
# sources to cast the spell on curve about 90% of the time. Index 0 is unused
# -- a colour with no pips never reaches here.
_SOURCE_TARGETS = {
    "commander": (0, 20, 24, 27),
    "sixty": (0, 14, 20, 23),
}


def _counted(resolutions: list[Resolution]) -> list[Resolution]:
    """Cards occupying deck slots. The maybeboard is a holding area, not a deck."""
    return [r for r in resolutions
            if r.card and r.section in ("main", "commander", "companion")]


def _pips(mana_cost: str | None) -> Counter:
    """Coloured pips in a mana cost. Hybrid counts for both halves."""
    found: Counter = Counter()
    for symbol in _SYMBOL.findall(mana_cost or ""):
        for part in symbol.split("/"):
            if part in COLOURS:
                found[part] += 1
    return found


def compute(conn: sqlite3.Connection, resolutions: list[Resolution]) -> dict[str, Any]:
    cards = _counted(resolutions)
    if not cards:
        return {"empty": True}

    pips: Counter = Counter()
    produced: Counter = Counter()
    types: Counter = Counter()
    rarity: Counter = Counter()
    side_rarity: Counter = Counter()
    curve: dict[str, Counter] = {k: Counter() for k in CURVE_KEYS}

    identity: set[str] = set()
    total_cards = 0
    nonland_cards = 0
    total_mv = 0.0
    lands = 0
    untapped_lands = 0
    # Non-land mana sources, split by what they are.
    rocks = 0
    dorks = 0
    other_sources = 0
    # Cards that produce at least one coloured symbol, counted once each.
    source_cards = 0
    # Most pips of one colour on a single card, which is what the source
    # requirement is keyed on.
    intensity: Counter = Counter()

    for res in cards:
        card = res.card
        assert card is not None
        qty = res.quantity
        total_cards += qty
        rarity[card.get("rarity") or "unknown"] += qty
        identity |= set(card.get("color_identity") or "")

        line = card.get("type_line") or ""
        is_land = "Land" in line
        for name in ("Land", "Creature", "Artifact", "Enchantment",
                     "Instant", "Sorcery", "Planeswalker", "Battle"):
            if name in line:
                # Land wins for dual-classed cards; otherwise first match.
                types[("Land" if is_land else name)] += qty
                break
        else:
            types["Other"] += qty

        card_pips = _pips(card.get("mana_cost"))
        for colour, n in card_pips.items():
            pips[colour] += n * qty
            # The heaviest single demand in this colour. Twenty one-pip white
            # cards are easy; one WWW card is not, and it is the WWW card that
            # decides how many white sources the deck actually needs.
            if n > intensity[colour]:
                intensity[colour] = n

        # Whether a card is a mana source and which colours it supplies are two
        # different questions. Sol Ring makes only C, so it is very much a rock
        # while contributing to no colour's balance.
        all_makes = card.get("produced_mana") or []
        makes = [s for s in all_makes if s in COLOURS]

        if is_land:
            lands += qty
            if makes:
                source_cards += qty
            for symbol in makes:
                produced[symbol] += qty
            text = (card.get("oracle_text") or "").lower()
            if "enters the battlefield tapped" not in text and "enters tapped" not in text:
                untapped_lands += qty
        else:
            nonland_cards += qty
            # Rocks, dorks and mana enchantments are mana sources too, and a
            # base judged on lands alone badly understates a deck that ramps on
            # artifacts. Permanents only: a ritual produces mana once, which is
            # not the repeatable source this balance is measuring.
            if all_makes and _PERMANENT.search(line) and not _ONE_SHOT.search(line):
                if makes:
                    source_cards += qty
                for symbol in makes:
                    produced[symbol] += qty
                if "Creature" in line:
                    dorks += qty
                elif "Artifact" in line:
                    rocks += qty
                else:
                    other_sources += qty
            mv = int(card.get("cmc") or 0)
            total_mv += (card.get("cmc") or 0) * qty
            bucket = "7+" if mv >= 7 else str(mv)
            # Curve is stacked by colour identity so you can see which colour
            # sits where on the curve, not just how tall each column is.
            # Named separately from the deck-wide `identity` accumulator, which
            # this would otherwise clobber with a single card's string.
            card_identity = card.get("color_identity") or ""
            key = card_identity if len(card_identity) == 1 else ("multi" if card_identity else "C")
            curve[bucket][key] += qty

    for res in resolutions:
        if res.card and res.section == "sideboard":
            side_rarity[res.card.get("rarity") or "unknown"] += res.quantity

    # Sources vs requirements: the question a mana base has to answer.
    total_pips = sum(pips.values()) or 1
    # The number of source *cards*, not the sum of the colours they make.
    #
    # Summing `produced` counted a five-colour land five times, so every extra
    # colour a source could make inflated the denominator that every colour is
    # then judged against. A mono-red deck whose fixing all taps for red as
    # well reported Red at -46% and could never reach 100%: red was measured
    # against a total that its own colour-agnostic lands had quintupled.
    # Counting each source once makes the share mean "what fraction of my
    # sources can produce this colour", which is the question being asked --
    # and a land that makes any colour now satisfies every colour it makes,
    # rather than diluting all of them.
    total_sources = source_cards or 1
    table = _SOURCE_TARGETS["commander" if total_cards >= 80 else "sixty"]
    balance = []
    for colour in COLOURS:
        # Only colours the deck actually casts. A colour with no pips has no
        # requirement, so there is nothing to be short or long of -- and the
        # old code gave it a row anyway. Minsc plays no blue and no black card
        # at all, and reported a +24% surplus in each, purely because seven of
        # its lands can incidentally tap for them.
        if not pips[colour]:
            continue
        need = table[min(intensity[colour], 3)]
        balance.append({
            "color": colour,
            "pips": pips[colour],
            "pip_share": round(pips[colour] / total_pips, 4),
            "sources": produced[colour],
            "source_share": round(produced[colour] / total_sources, 4),
            # The heaviest cost in this colour, and how many sources that cost
            # wants. Karsten's tables: roughly 20/24/27 sources in a 99 for
            # one, two and three pips, and 14/20/23 in a 60.
            "intensity": intensity[colour],
            "target": need,
            # Sources you have minus sources you want, in cards. Negative means
            # short.
            #
            # This replaces a subtraction of two percentages that did not share
            # a denominator. Pip share was out of all pips and summed to 100%;
            # source share was out of source *cards* while its numerators
            # counted every colour a card makes, so it summed to whatever the
            # average source produced -- 220% in Minsc. Subtracting them left a
            # figure that was positive for every colour in every multicolour
            # deck, which is not a measurement, and the number of cards is what
            # a player can act on anyway.
            "shortfall": produced[colour] - need,
        })

    return {
        "empty": False,
        "total_cards": total_cards,
        "lands": lands,
        "untapped_lands": untapped_lands,
        "mana_rocks": rocks,
        "mana_dorks": dorks,
        "other_mana_sources": other_sources,
        "nonland_sources": rocks + dorks + other_sources,
        # How many of those cards actually make a coloured symbol. The
        # caption used to imply all of them did, which is how a base with
        # 41 sources and 29 colour-producers read as healthier than it is.
        "coloured_sources": source_cards,
        "avg_cmc": round(total_mv / nonland_cards, 2) if nonland_cards else 0.0,
        "pips": {c: pips[c] for c in COLOURS if pips[c]},
        "produced": {c: produced[c] for c in COLOURS if produced[c]},
        "balance": balance,
        "types": dict(types.most_common()),
        "rarity": {"main": dict(rarity), "sideboard": dict(side_rarity)},
        "curve": {k: dict(curve[k]) for k in CURVE_KEYS},
        "tokens": tokens_made(conn, cards, identity),
    }


def tokens_made(
    conn: sqlite3.Connection, cards: list[Resolution], deck_identity: set[str] | None = None,
) -> list[dict[str, Any]]:
    """Tokens and emblems the deck can produce.

    Read from Scryfall's `all_parts` links rather than pattern-matched from
    rules text, so "create a 1/1 white Soldier" and "put a Treasure onto the
    battlefield" are both caught without a regex for each phrasing.
    """
    # Matched by name, not id: all_parts references a specific *printing*,
    # while the mirror stores one row per oracle card, so the ids rarely line up.
    deck_identity = deck_identity or set()
    names: set[str] = set()
    for res in cards:
        card = res.card
        if not card:
            continue
        raw = card.get("all_parts")
        parts = raw if isinstance(raw, list) else (json.loads(raw) if raw else [])
        for part in parts or []:
            line = part.get("type_line") or ""
            if part.get("component") == "token" or "Emblem" in line:
                if part.get("name"):
                    names.add(part["name"])

    if not names:
        return []

    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for chunk_start in range(0, len(names), 400):
        chunk = list(names)[chunk_start:chunk_start + 400]
        rows = conn.execute(
            f"SELECT oracle_id, name, type_line, power, toughness, color_identity, "
            f"image_normal FROM cards WHERE name IN ({','.join('?' * len(chunk))}) "
            f"AND (layout = 'token' OR type_line LIKE '%Emblem%')",
            tuple(chunk),
        ).fetchall()
        # Several distinct tokens share a name ("Zombie" exists in white and
        # black). Prefer the one inside the deck's colour identity, since that
        # is the one the deck can actually make.
        # Ranking, in order: inside the deck's colours first, then *coloured*
        # ahead of colourless. Without the second key the empty identity wins
        # every tie -- it is a subset of everything -- and a black Zombie deck
        # gets shown the colourless Zombie.
        rows = sorted(
            rows,
            key=lambda r: (
                not (set(r["color_identity"] or "") <= deck_identity),
                not (set(r["color_identity"] or "") & deck_identity),
                r["color_identity"] or "",
            ),
        )
        for row in rows:
            if row["name"] in seen:
                continue
            seen.add(row["name"])
            out.append({
                "oracle_id": row["oracle_id"],
                "name": row["name"],
                "type_line": row["type_line"],
                "pt": f"{row['power']}/{row['toughness']}" if row["power"] else None,
                "color_identity": row["color_identity"],
                "image": row["image_normal"],
                "is_emblem": "Emblem" in (row["type_line"] or ""),
            })
    out.sort(key=lambda t: (t["is_emblem"], t["name"]))
    return out
