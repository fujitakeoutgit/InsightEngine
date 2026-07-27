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
CURVE_KEYS = ("0", "1", "2", "3", "4", "5", "6", "7+")

_SYMBOL = re.compile(r"\{([^}]+)\}")


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

        if is_land:
            lands += qty
            for symbol in (card.get("produced_mana") or []):
                if symbol in COLOURS:
                    produced[symbol] += qty
            text = (card.get("oracle_text") or "").lower()
            if "enters the battlefield tapped" not in text and "enters tapped" not in text:
                untapped_lands += qty
        else:
            nonland_cards += qty
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
    total_sources = sum(produced.values()) or 1
    balance = []
    for colour in COLOURS:
        if not pips[colour] and not produced[colour]:
            continue
        balance.append({
            "color": colour,
            "pips": pips[colour],
            "pip_share": round(pips[colour] / total_pips, 4),
            "sources": produced[colour],
            "source_share": round(produced[colour] / total_sources, 4),
            # Positive means under-supplied relative to what the deck asks for.
            "gap": round(pips[colour] / total_pips - produced[colour] / total_sources, 4),
        })

    return {
        "empty": False,
        "total_cards": total_cards,
        "lands": lands,
        "untapped_lands": untapped_lands,
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
