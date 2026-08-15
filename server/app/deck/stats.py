"""Deck composition statistics.

What replaces the format-legality wall: the numbers you actually look at while
building — where your pips are, whether your lands can pay for them, the curve
broken down by color, and what the deck puts onto the battlefield.
"""

from __future__ import annotations

import json
import re
import sqlite3
from collections import Counter
from typing import Any

from .resolver import Resolution

COLORS = ("W", "U", "B", "R", "G")

# A mana source has to stay on the battlefield to be one. Scryfall lists
# produced_mana for rituals too, and counting Dark Ritual as a black source
# would flatter every mana base that runs one.
_PERMANENT = re.compile(r"\b(Artifact|Creature|Enchantment|Planeswalker|Battle)\b")
_ONE_SHOT = re.compile(r"\b(Instant|Sorcery)\b")
CURVE_KEYS = ("0", "1", "2", "3", "4", "5", "6", "7+")

_SYMBOL = re.compile(r"\{([^}]+)\}")



_BASIC_COLOR = {
    "plains": "W", "island": "U", "swamp": "B", "mountain": "R", "forest": "G",
}

# "{T}, Pay 1 life, Sacrifice this land: Search your library for a Forest or
# Plains card, ..." -- the clause after the colon, up to the sentence end.
_SACRIFICE_SEARCH = re.compile(
    r"sacrifice[^:.]*:[^.]*?search your library for ([^.]*)", re.I)


def fetch_profile(card: dict[str, Any]) -> tuple[tuple[str, ...], bool]:
    """The colors a fetch land supplies, and whether what it finds is tapped.

    Scryfall gives a fetch land `produced_mana: []`, because the land itself
    taps for nothing -- it sacrifices. Taken literally that makes Windswept
    Heath contribute to no color at all, which is the opposite of why it is in
    the deck. What it is really worth is the colors it can go and get.

    Returns an empty tuple for anything that is not a sacrifice-to-search land,
    so callers can fall back to produced_mana.
    """
    text = (card.get("oracle_text") or "")
    match = _SACRIFICE_SEARCH.search(text)
    if not match:
        return (), False

    clause = match.group(1).lower()
    named = tuple(
        color for basic, color in _BASIC_COLOR.items() if basic in clause
    )
    if not named and "basic land" in clause:
        # "a basic land card" reaches any of them.
        named = tuple(_BASIC_COLOR.values())
    if not named:
        return (), False

    # Ordered like COLORS so two lands fetching the same pair compare equal.
    ordered = tuple(c for c in COLORS if c in named)
    return ordered, "battlefield tapped" in clause


def _relevant(makes: list[str], allowed: set[str]) -> list[str]:
    """The colors a source contributes, restricted to the ones that matter.

    A five-color land in a two-color deck is a perfect dual, not a fifth of
    a source in each of five colors -- three of those colors are never cast.
    Restricting first, then splitting, is what makes the split mean "how much
    of this card is working for this color".
    """
    return [c for c in makes if c in allowed]


def _weigh(
    weighted: dict[str, float], makes: list[str], qty: int, scope: set[str] | None,
) -> None:
    """Add a source to each color it serves, split evenly between them.

    A card that makes one relevant color is worth 1 to it. A dual is worth a
    half to each, a triome a third, a five-color land a fifth -- or a quarter,
    if the commander only allows four colors and the fifth is dead weight.
    """
    relevant = _relevant(makes, scope) if scope is not None else makes
    if not relevant:
        return
    share = qty / len(relevant)
    for symbol in relevant:
        weighted[symbol] += share


def _counted(resolutions: list[Resolution]) -> list[Resolution]:
    """Cards occupying deck slots. The maybeboard is a holding area, not a deck."""
    return [r for r in resolutions
            if r.card and r.section in ("main", "commander", "companion")]


def _pips(mana_cost: str | None) -> Counter:
    """Colored pips in a mana cost. Hybrid counts for both halves."""
    found: Counter = Counter()
    for symbol in _SYMBOL.findall(mana_cost or ""):
        for part in symbol.split("/"):
            if part in COLORS:
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
    # Cards that produce at least one colored symbol, counted once each.
    source_cards = 0
    # Sources weighted by how many of the commander's colors each one makes.
    # A float, because half a dual is exactly what a dual is worth to a color.
    weighted: dict[str, float] = {c: 0.0 for c in COLORS}

    # The commander's color identity, unioned across every card in the
    # commander section -- so a partner pair, a Background, or a Doctor and its
    # companion contribute both halves. This is the ceiling the deck is built
    # under, and the charts filter to it: a deck cannot cast a color its
    # commander does not allow, so showing that color is showing noise.
    #
    # Empty for a deck with no commander, which the charts read as "no ceiling"
    # and fall back to the colors actually present.
    commander_identity = set()
    for res in resolutions:
        if res.card and res.section == "commander":
            commander_identity |= set(res.card.get("color_identity") or "")

    scope = commander_identity or None

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
        for color, n in card_pips.items():
            pips[color] += n * qty

        # Whether a card is a mana source and which colors it supplies are two
        # different questions. Sol Ring makes only C, so it is very much a rock
        # while contributing to no color's balance.
        all_makes = card.get("produced_mana") or []
        makes = [s for s in all_makes if s in COLORS]

        # A fetch land's worth is the colors it can go and get. Krosan Verge
        # taps for {C} and fetches a Forest and a Plains, so it is a green and
        # white source with a colorless ability, not a colorless land.
        fetched, _ = fetch_profile(card)
        if fetched and is_land:
            makes = sorted(set(makes) | set(fetched), key=COLORS.index)
            all_makes = list(all_makes) + list(fetched)

        if is_land:
            lands += qty
            if makes:
                source_cards += qty
            for symbol in makes:
                produced[symbol] += qty
            _weigh(weighted, makes, qty, scope)
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
                _weigh(weighted, makes, qty, scope)
                if "Creature" in line:
                    dorks += qty
                elif "Artifact" in line:
                    rocks += qty
                else:
                    other_sources += qty
            mv = int(card.get("cmc") or 0)
            total_mv += (card.get("cmc") or 0) * qty
            bucket = "7+" if mv >= 7 else str(mv)
            # Curve is stacked by color identity so you can see which color
            # sits where on the curve, not just how tall each column is.
            # Named separately from the deck-wide `identity` accumulator, which
            # this would otherwise clobber with a single card's string.
            card_identity = card.get("color_identity") or ""
            key = card_identity if len(card_identity) == 1 else ("multi" if card_identity else "C")
            curve[bucket][key] += qty

    for res in resolutions:
        if res.card and res.section == "sideboard":
            side_rarity[res.card.get("rarity") or "unknown"] += res.quantity

    # Sources per pip, per color.
    #
    # The measure is deliberately plain: how much of your mana base is working
    # for a color, divided by how much that color is asked for. Above 1 means
    # more sources than pips; below 1 means fewer.
    #
    # Two rules make it mean something.
    #
    # Only the commander's colors count. A land that taps for blue in a deck
    # with no blue commander is not a blue source, it is a land -- and the old
    # panel gave that phantom color a row and a healthy-looking number.
    #
    # And a source is split between the colors it serves. A dual is half a
    # source to each of its two colors, a triome a third to each, a five-color
    # land a fifth -- or a quarter, when the commander only allows four and the
    # fifth color is dead weight. Counting a dual as a whole source for both
    # colors is what let a three-color deck report every color as covered
    # while no single color actually was.
    total_pips = sum(pips.values()) or 1
    total_sources = source_cards or 1
    balance = []
    for color in COLORS:
        # Outside the commander's identity, or never cast: not a row.
        if commander_identity and color not in commander_identity:
            continue
        if not pips[color]:
            continue
        share = weighted[color]
        balance.append({
            "color": color,
            "pips": pips[color],
            "pip_share": round(pips[color] / total_pips, 4),
            # Whole cards that can tap for this color, for the detail table.
            "sources": produced[color],
            "source_share": round(produced[color] / total_sources, 4),
            # The same sources after splitting each between the colors it
            # serves. This is the numerator of the ratio.
            "weighted_sources": round(share, 2),
            "ratio": round(share / pips[color], 3),
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
        # How many of those cards actually make a colored symbol. The
        # caption used to imply all of them did, which is how a base with
        # 41 sources and 29 color-producers read as healthier than it is.
        "colored_sources": source_cards,
        "commander_identity": "".join(c for c in COLORS if c in commander_identity),
        "avg_cmc": round(total_mv / nonland_cards, 2) if nonland_cards else 0.0,
        "pips": {c: pips[c] for c in COLORS if pips[c]},
        "produced": {c: produced[c] for c in COLORS if produced[c]},
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
        # black). Prefer the one inside the deck's color identity, since that
        # is the one the deck can actually make.
        # Ranking, in order: inside the deck's colors first, then *colored*
        # ahead of colorless. Without the second key the empty identity wins
        # every tie -- it is a subset of everything -- and a black Zombie deck
        # gets shown the colorless Zombie.
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
