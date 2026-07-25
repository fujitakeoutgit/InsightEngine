"""Spell checking against Magic's own vocabulary.

The browser's native spell checker is the wrong tool for a query bar: it does
not know "Llanowar" or "planeswalker", and it flags every operator. This builds
a dictionary from the card corpus itself -- every word appearing in a card
name, type line or keyword, plus the query syntax's own field names -- so the
only words underlined are ones that genuinely appear nowhere in Magic.
"""

from __future__ import annotations

import re
import sqlite3
import unicodedata

from rapidfuzz import fuzz, process

# Words shorter than this are too noisy to judge.
MIN_LENGTH = 3
SUGGESTION_FLOOR = 68.0

_WORD_RE = re.compile(r"[A-Za-z][A-Za-z'’-]*")

# Query grammar and common English words that will never appear on a card.
EXTRA_TERMS = {
    # operators / field names
    "c", "color", "colors", "id", "ci", "identity", "commander", "t", "type",
    "o", "oracle", "text", "fo", "fulloracle", "n", "name", "mv", "cmc",
    "manavalue", "m", "mana", "pow", "power", "tou", "toughness", "loy",
    "loyalty", "r", "rarity", "s", "set", "e", "edition", "legal", "banned",
    "restricted", "f", "format", "is", "has", "kw", "keyword", "a", "artist",
    "usd", "price", "eur", "tix", "year", "date", "rank", "edhrec", "layout",
    "produces", "otag", "function", "tag", "q", "ask", "or", "and", "not",
    # values people type
    "red", "blue", "green", "white", "black", "colorless", "colourless",
    "multicolor", "multicolour", "gold", "common", "uncommon", "rare",
    "mythic", "special", "bonus", "standard", "pioneer", "modern", "legacy",
    "vintage", "pauper", "brawl", "historic", "timeless", "alchemy",
    "explorer", "penny", "oathbreaker", "duel", "predh", "premodern",
    "oldschool", "gladiator", "standardbrawl", "permanent", "spell",
    "vanilla", "dfc", "hybrid", "phyrexian", "reserved", "gamechanger",
    "digital", "paper", "arena", "mtgo", "funny", "reprint", "transform",
    "modal", "split", "flip", "leveler", "meld", "adventure", "saga",
    "historic", "creature", "land", "artifact", "enchantment", "instant",
    "sorcery", "planeswalker", "battle", "token", "legendary", "basic",
    # frequent connective words in phrase searches
    "a", "an", "the", "of", "to", "in", "on", "for", "with", "you", "your",
    "any", "all", "each", "one", "two", "three", "when", "whenever", "if",
    "this", "that", "target", "up", "at", "as", "from", "into", "than",
    "may", "can", "it", "its", "they", "them", "other", "another", "and",
}


def _fold(word: str) -> str:
    decomposed = unicodedata.normalize("NFKD", word)
    ascii_only = "".join(c for c in decomposed if not unicodedata.combining(c))
    return re.sub(r"[^a-z]", "", ascii_only.lower())


class SpellChecker:
    """Case-insensitive dictionary plus fuzzy suggestions."""

    def __init__(self, conn: sqlite3.Connection) -> None:
        self._words: set[str] = set(EXTRA_TERMS)
        self._display: dict[str, str] = {}

        # Rules text is included deliberately. Users type oracle phrases
        # (o:"nonblack creature"), so any word Magic has ever printed must
        # count as spelled correctly -- in a search box a false underline is a
        # worse failure than a missed typo.
        rows = conn.execute(
            "SELECT name, type_line, oracle_all FROM cards WHERE digital = 0"
        ).fetchall()
        for row in rows:
            for source in (row["name"], row["type_line"], row["oracle_all"]):
                for match in _WORD_RE.finditer(source or ""):
                    self._add(match.group())

        for row in conn.execute("SELECT name FROM sets"):
            for match in _WORD_RE.finditer(row["name"] or ""):
                self._add(match.group())

        # Ordered list for rapidfuzz. Sorting keeps suggestions stable.
        self._choices = sorted(self._words)

    def _add(self, word: str) -> None:
        folded = _fold(word)
        if len(folded) >= MIN_LENGTH:
            self._words.add(folded)
            self._display.setdefault(folded, word)

    def __len__(self) -> int:
        return len(self._words)

    def known(self, word: str) -> bool:
        folded = _fold(word)
        # Short tokens and anything with digits are left alone.
        return len(folded) < MIN_LENGTH or folded in self._words

    def check(self, words: list[str]) -> list[str]:
        """Return the subset that is not in the dictionary."""
        return [w for w in words if not self.known(w)]

    def suggest(self, word: str, limit: int = 6) -> list[str]:
        folded = _fold(word)
        if not folded:
            return []
        matches = process.extract(
            folded, self._choices, scorer=fuzz.ratio,
            limit=limit, score_cutoff=SUGGESTION_FLOOR,
        )
        # Prefer the corpus's own capitalisation over the folded key.
        return [self._display.get(key, key) for key, _score, _i in matches]
