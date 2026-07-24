"""Deck legality and cost analysis.

Legality is checked on two axes, because either one alone is misleading:

* per-card status from Scryfall's `legalities` blob (legal / banned / restricted)
* format construction rules (deck size, copy limits, singleton, sideboard,
  commander colour identity)
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from .resolver import Resolution

BASIC_LAND_NAMES = {
    "plains", "island", "swamp", "mountain", "forest", "wastes",
    "snow-covered plains", "snow-covered island", "snow-covered swamp",
    "snow-covered mountain", "snow-covered forest",
}
ANY_NUMBER_PHRASE = "a deck can have any number of cards named"


@dataclass(frozen=True)
class FormatRule:
    label: str
    min_deck: int | None = 60
    exact_deck: int | None = None
    max_copies: int = 4
    singleton: bool = False
    sideboard_max: int | None = 15
    needs_commander: bool = False
    commander_identity: bool = False


FORMATS: dict[str, FormatRule] = {
    "standard":      FormatRule("Standard"),
    "pioneer":       FormatRule("Pioneer"),
    "modern":        FormatRule("Modern"),
    "legacy":        FormatRule("Legacy"),
    "vintage":       FormatRule("Vintage"),
    "pauper":        FormatRule("Pauper"),
    "penny":         FormatRule("Penny Dreadful"),
    "historic":      FormatRule("Historic"),
    "timeless":      FormatRule("Timeless"),
    "alchemy":       FormatRule("Alchemy"),
    "explorer":      FormatRule("Explorer"),
    "premodern":     FormatRule("Premodern"),
    "oldschool":     FormatRule("Old School"),
    "commander":     FormatRule("Commander", min_deck=None, exact_deck=100, max_copies=1,
                                singleton=True, sideboard_max=None,
                                needs_commander=True, commander_identity=True),
    "duel":          FormatRule("Duel Commander", min_deck=None, exact_deck=100,
                                max_copies=1, singleton=True, sideboard_max=None,
                                needs_commander=True, commander_identity=True),
    "predh":         FormatRule("PreDH", min_deck=None, exact_deck=100, max_copies=1,
                                singleton=True, sideboard_max=None,
                                needs_commander=True, commander_identity=True),
    "oathbreaker":   FormatRule("Oathbreaker", min_deck=None, exact_deck=60, max_copies=1,
                                singleton=True, sideboard_max=None,
                                needs_commander=True, commander_identity=True),
    "brawl":         FormatRule("Brawl", min_deck=None, exact_deck=100, max_copies=1,
                                singleton=True, sideboard_max=None,
                                needs_commander=True, commander_identity=True),
    "standardbrawl": FormatRule("Standard Brawl", min_deck=None, exact_deck=60,
                                max_copies=1, singleton=True, sideboard_max=None,
                                needs_commander=True, commander_identity=True),
    "gladiator":     FormatRule("Gladiator", min_deck=None, exact_deck=100, max_copies=1,
                                singleton=True, sideboard_max=None),
    "pauper_commander": FormatRule("Pauper EDH", min_deck=None, exact_deck=100,
                                   max_copies=1, singleton=True, sideboard_max=None,
                                   needs_commander=True, commander_identity=True),
}


@dataclass
class FormatVerdict:
    format: str
    label: str
    legal: bool
    issues: list[str] = field(default_factory=list)
    problem_cards: list[dict[str, str]] = field(default_factory=list)

    def as_dict(self) -> dict[str, Any]:
        return {
            "format": self.format, "label": self.label, "legal": self.legal,
            "issues": self.issues, "problem_cards": self.problem_cards[:40],
        }


def _unlimited(card: dict[str, Any]) -> bool:
    """Basic lands and cards that explicitly waive the copy limit."""
    if (card.get("name") or "").lower() in BASIC_LAND_NAMES:
        return True
    if "Basic" in (card.get("type_line") or ""):
        return True
    return ANY_NUMBER_PHRASE in (card.get("oracle_text") or "").lower()


def _counted(resolutions: list[Resolution]) -> list[Resolution]:
    """Entries that occupy deck slots (excludes maybeboard and tokens)."""
    return [r for r in resolutions if r.resolved and r.section in
            ("main", "commander", "companion")]


def check_format(
    key: str, rule: FormatRule, resolutions: list[Resolution]
) -> FormatVerdict:
    verdict = FormatVerdict(format=key, label=rule.label, legal=True)

    counted = _counted(resolutions)
    sideboard = [r for r in resolutions if r.resolved and r.section == "sideboard"]
    commanders = [r for r in resolutions if r.resolved and r.section == "commander"]

    total = sum(r.quantity for r in counted)
    if rule.exact_deck is not None and total != rule.exact_deck:
        verdict.legal = False
        verdict.issues.append(f"Deck has {total} cards; {rule.label} requires exactly {rule.exact_deck}.")
    elif rule.min_deck is not None and total < rule.min_deck:
        verdict.legal = False
        verdict.issues.append(f"Deck has {total} cards; {rule.label} requires at least {rule.min_deck}.")

    side_total = sum(r.quantity for r in sideboard)
    if rule.sideboard_max is not None and side_total > rule.sideboard_max:
        verdict.legal = False
        verdict.issues.append(f"Sideboard has {side_total} cards; maximum is {rule.sideboard_max}.")

    if rule.needs_commander and not commanders:
        verdict.legal = False
        verdict.issues.append("No commander designated.")

    # Per-card status and copy limits.
    copies: dict[str, int] = {}
    for res in [*counted, *sideboard]:
        card = res.card
        assert card is not None
        name = card["name"]
        copies[name] = copies.get(name, 0) + res.quantity

        status = (card.get("legalities") or {}).get(key, "not_legal")
        if status == "banned":
            verdict.legal = False
            verdict.problem_cards.append({"name": name, "reason": "banned"})
        elif status == "not_legal":
            verdict.legal = False
            verdict.problem_cards.append({"name": name, "reason": "not in format"})
        elif status == "restricted" and copies[name] > 1:
            verdict.legal = False
            verdict.problem_cards.append({"name": name, "reason": "restricted to 1 copy"})

    by_name = {r.card["name"]: r.card for r in [*counted, *sideboard] if r.card}
    for name, count in copies.items():
        card = by_name.get(name)
        if not card or _unlimited(card):
            continue
        status = (card.get("legalities") or {}).get(key, "not_legal")
        if status == "restricted":
            continue  # already reported above
        if count > rule.max_copies:
            verdict.legal = False
            limit = "1 copy" if rule.max_copies == 1 else f"{rule.max_copies} copies"
            reason = "singleton format" if rule.singleton else f"maximum {limit}"
            verdict.problem_cards.append({"name": name, "reason": f"{count} copies; {reason}"})

    # Commander colour identity.
    if rule.commander_identity and commanders:
        allowed: set[str] = set()
        for res in commanders:
            assert res.card is not None
            allowed |= set(res.card.get("color_identity") or "")
        for res in counted:
            assert res.card is not None
            identity = set(res.card.get("color_identity") or "")
            if not identity <= allowed:
                verdict.legal = False
                outside = "".join(sorted(identity - allowed))
                verdict.problem_cards.append({
                    "name": res.card["name"],
                    "reason": f"colour identity {outside} outside commander",
                })

    return verdict


def analyse(resolutions: list[Resolution]) -> dict[str, Any]:
    counted = _counted(resolutions)
    sideboard = [r for r in resolutions if r.resolved and r.section == "sideboard"]

    total_cards = sum(r.quantity for r in counted)
    unresolved = [r for r in resolutions if not r.resolved]

    price = 0.0
    missing_price = 0
    for res in [*counted, *sideboard]:
        assert res.card is not None
        if (usd := res.card.get("usd")) is not None:
            price += usd * res.quantity
        else:
            missing_price += res.quantity

    curve: dict[str, int] = {}
    colours: dict[str, int] = {}
    for res in counted:
        card = res.card
        assert card is not None
        if "Land" not in (card.get("type_line") or ""):
            bucket = int(card.get("cmc") or 0)
            key = "7+" if bucket >= 7 else str(bucket)
            curve[key] = curve.get(key, 0) + res.quantity
        for letter in card.get("color_identity") or "":
            colours[letter] = colours.get(letter, 0) + res.quantity

    verdicts = [check_format(key, rule, resolutions).as_dict()
                for key, rule in FORMATS.items()]

    return {
        "total_cards": total_cards,
        "sideboard_cards": sum(r.quantity for r in sideboard),
        "unique_cards": len({r.card["name"] for r in counted if r.card}),
        "unresolved_count": len(unresolved),
        "price_usd": round(price, 2),
        "cards_missing_price": missing_price,
        "curve": curve,
        "colors": colours,
        "formats": verdicts,
        "entries": [r.as_dict() for r in resolutions],
    }
