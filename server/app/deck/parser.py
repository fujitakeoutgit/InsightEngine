"""Decklist text -> structured entries.

Handles the formats people actually paste: Arena exports, MTGO .dek text,
Moxfield/Archidekt copy, and hand-typed lists. The parser is deliberately
permissive -- it extracts a quantity and a raw name, and leaves every question
of "is this a real card" to the resolver.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

# 4 Llanowar Elves (M21) 178 *F*   |   4x Llanowar Elves   |   Llanowar Elves
_LINE_RE = re.compile(
    r"""^\s*
    (?:(?P<qty>\d{1,3})\s*[xX]?\s+ | [xX]\s*(?P<qty2>\d{1,3})\s+)?   # 4 / 4x / x4
    (?P<name>.+?)                                                     # card name
    (?:\s+\((?P<set>[A-Za-z0-9_]{2,8})\)(?:\s+(?P<number>[A-Za-z0-9\-★]+))?)?  # (SET) 123
    (?P<flags>(?:\s*\*[^*]*\*)*)                                      # *F* *CMDR*
    \s*$""",
    re.VERBOSE,
)

_SECTION_RE = re.compile(
    r"^\s*(?://|\#)?\s*(?P<name>deck|main(?:board|deck)?|sideboard|side|commander|"
    r"companion|maybe(?:board)?|tokens?|bulk|trades?|fav(?:ou?rites?)?)"
    r"\s*:?\s*(?:\(\d+\))?\s*$",
    re.IGNORECASE,
)

_SECTION_ALIASES = {
    "deck": "main", "main": "main", "mainboard": "main", "maindeck": "main",
    "sideboard": "sideboard", "side": "sideboard",
    "commander": "commander", "companion": "companion",
    "maybe": "maybeboard", "maybeboard": "maybeboard",
    "token": "tokens", "tokens": "tokens",
    # The binder's own names for the same three sections. It is a deck in every
    # mechanical sense and stores an ordinary decklist, so its headings have to
    # be readable by the same parser — otherwise "Bulk" and "Trades" come back
    # as cards, which is exactly what they did.
    "bulk": "main", "trade": "sideboard", "trades": "sideboard",
    "fav": "maybeboard", "favourite": "maybeboard", "favorite": "maybeboard",
}

# "SB: 2 Duress" -- old MTGO style
_SB_PREFIX_RE = re.compile(r"^\s*SB:\s*", re.IGNORECASE)


@dataclass
class DeckEntry:
    quantity: int
    raw_name: str
    section: str = "main"
    set_code: str | None = None
    collector_number: str | None = None
    is_commander: bool = False
    line_number: int = 0
    source_line: str = ""


@dataclass
class ParsedDeck:
    entries: list[DeckEntry] = field(default_factory=list)
    ignored_lines: list[str] = field(default_factory=list)


def _clean_name(raw: str) -> str:
    """Normalise the many ways a double-faced card gets written."""
    name = raw.strip().strip(",")
    # Unify separators: 'Fire//Ice', 'Fire / Ice', 'Fire | Ice' -> 'Fire // Ice'
    name = re.sub(r"\s*(?://|\||/)\s*", " // ", name)
    name = re.sub(r"\s{2,}", " ", name).strip()
    return name


def parse_decklist(text: str) -> ParsedDeck:
    deck = ParsedDeck()
    section = "main"

    for number, line in enumerate(text.splitlines(), start=1):
        stripped = line.strip()
        if not stripped:
            continue

        if match := _SECTION_RE.match(stripped):
            key = match.group("name").lower().rstrip("s") if match.group("name").lower() not in (
                "tokens",
            ) else "tokens"
            section = _SECTION_ALIASES.get(key, _SECTION_ALIASES.get(
                match.group("name").lower(), "main"))
            continue

        # A Tokens section -- which every exporter emits -- documents what the
        # deck *makes*, not what is in it. Every count already excluded it, and
        # the tokens a deck produces are derived from the cards' own all_parts
        # rather than read from here, so carrying the lines any further only
        # gave the resolver names it should never have been asked about.
        if section == "tokens":
            deck.ignored_lines.append(line)
            continue

        forced_section = None
        if _SB_PREFIX_RE.match(stripped):
            stripped = _SB_PREFIX_RE.sub("", stripped)
            forced_section = "sideboard"

        # A comment line that is not a section header carries no card.
        if stripped.startswith("#"):
            deck.ignored_lines.append(line)
            continue

        match = _LINE_RE.match(stripped)
        if not match:
            deck.ignored_lines.append(line)
            continue

        name = _clean_name(match.group("name"))
        if not name or name.lower() in _SECTION_ALIASES:
            deck.ignored_lines.append(line)
            continue

        quantity = int(match.group("qty") or match.group("qty2") or 1)
        flags = (match.group("flags") or "").lower()

        deck.entries.append(DeckEntry(
            quantity=max(1, quantity),
            raw_name=name,
            section=forced_section or ("commander" if "cmdr" in flags else section),
            set_code=(match.group("set") or "").lower() or None,
            collector_number=match.group("number"),
            is_commander="cmdr" in flags or (forced_section or section) == "commander",
            line_number=number,
            source_line=line.rstrip(),
        ))

    return deck
