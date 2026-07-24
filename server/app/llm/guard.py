"""Hallucination containment.

The pipeline's safety does not rest on the model behaving. It rests on three
mechanical properties:

1. The model never emits card data -- only filter objects and integer indices.
   Card fields are always rehydrated from SQLite (`cards_by_oracle_ids`).
2. Indices are range-checked against the batch actually shown to the model.
   An out-of-range index cannot resolve to a card; it is dropped and counted.
3. Free-text the model writes is scanned against the full 38k-name index. Any
   card name found in prose is a policy violation (prompts forbid naming
   cards), and the prose is replaced with a deterministic, data-derived
   summary rather than shown to the user.

Property 3 is what catches the residual case: a model that ignores its
instructions and starts recommending cards it "remembers".
"""

from __future__ import annotations

import re
import sqlite3
from dataclasses import dataclass, field

from ..db import fold_name

# Card names shorter than this are too collision-prone to flag ("Fire", "Opt").
_MIN_FOLDED_LEN = 6
# Longest name we will try to match, in words.
_MAX_NAME_WORDS = 10

_WORD_RE = re.compile(r"[A-Za-z0-9'’,\-]+")


@dataclass
class GuardReport:
    invalid_indices: list[int] = field(default_factory=list)
    leaked_names: list[str] = field(default_factory=list)
    prose_replaced: bool = False

    @property
    def clean(self) -> bool:
        return not self.invalid_indices and not self.leaked_names

    def as_dict(self) -> dict:
        return {
            "clean": self.clean,
            "invalid_indices": self.invalid_indices,
            "leaked_names": self.leaked_names,
            "prose_replaced": self.prose_replaced,
        }


class NameIndex:
    """Folded card names -> oracle_id, for detecting names in model prose."""

    def __init__(self, conn: sqlite3.Connection) -> None:
        self._names: dict[str, str] = {}
        self._display: dict[str, str] = {}
        rows = conn.execute("SELECT oracle_id, name FROM cards").fetchall()
        for row in rows:
            self._add(row["name"], row["oracle_id"])
            # Index each face of a split/modal card separately.
            if " // " in row["name"]:
                for face in row["name"].split(" // "):
                    self._add(face, row["oracle_id"])

    def _add(self, name: str, oracle_id: str) -> None:
        folded = fold_name(name)
        if len(folded) >= _MIN_FOLDED_LEN:
            self._names.setdefault(folded, oracle_id)
            self._display.setdefault(folded, name)

    def find(self, text: str) -> dict[str, str]:
        """Return {display_name: oracle_id} for card names appearing in text.

        Only word sequences beginning with a capitalised token are considered,
        since card names are proper nouns and this keeps common words like
        "counterspell" from matching in ordinary prose.
        """
        if not text:
            return {}
        tokens = _WORD_RE.findall(text)
        found: dict[str, str] = {}
        for start, token in enumerate(tokens):
            if not token[:1].isupper():
                continue
            for length in range(min(_MAX_NAME_WORDS, len(tokens) - start), 0, -1):
                folded = fold_name("".join(tokens[start:start + length]))
                if len(folded) < _MIN_FOLDED_LEN:
                    continue
                if oracle_id := self._names.get(folded):
                    found[self._display[folded]] = oracle_id
                    break
        return found


def validate_indices(raw: object, batch_size: int) -> tuple[list[int], list[int]]:
    """Split model-supplied indices into (valid, invalid).

    Indices are 1-based in the prompt, so they are converted here.
    """
    valid: list[int] = []
    invalid: list[int] = []
    if not isinstance(raw, list):
        return valid, invalid
    for item in raw:
        if isinstance(item, bool) or not isinstance(item, int):
            invalid.append(item if isinstance(item, int) else -1)
            continue
        if 1 <= item <= batch_size:
            valid.append(item - 1)
        else:
            invalid.append(item)
    return sorted(set(valid)), invalid


def deterministic_summary(cards: list[dict]) -> str:
    """A summary computed from the data, used when model prose is rejected."""
    if not cards:
        return "The database returned no cards matching this query."

    total = len(cards)
    costs = [c["cmc"] for c in cards if c.get("cmc") is not None]
    avg_mv = sum(costs) / len(costs) if costs else 0.0

    colour_names = {"W": "white", "U": "blue", "B": "black", "R": "red", "G": "green"}
    counts: dict[str, int] = {}
    for card in cards:
        for letter in card.get("color_identity") or "":
            counts[letter] = counts.get(letter, 0) + 1
    colourless = sum(1 for c in cards if not (c.get("color_identity") or ""))

    ranked = sorted(counts.items(), key=lambda kv: kv[1], reverse=True)
    spread = ", ".join(f"{colour_names[k]} {v}" for k, v in ranked[:5]) or "none"

    types: dict[str, int] = {}
    for card in cards:
        head = (card.get("type_line") or "").split("—")[0].strip()
        for word in head.split():
            if word in ("Creature", "Instant", "Sorcery", "Artifact", "Enchantment",
                        "Land", "Planeswalker", "Battle"):
                types[word] = types.get(word, 0) + 1
    type_spread = ", ".join(f"{k.lower()} {v}" for k, v in
                            sorted(types.items(), key=lambda kv: kv[1], reverse=True)[:4])

    return (
        f"{total} cards matched. Average mana value {avg_mv:.1f}. "
        f"Colour identity spread: {spread}"
        f"{f', colourless {colourless}' if colourless else ''}. "
        f"Card types: {type_spread or 'mixed'}. "
        "Summary generated from database records."
    )


def audit_prose(
    text: str, index: NameIndex, cards: list[dict], report: GuardReport
) -> str:
    """Reject model prose that names cards; substitute a factual summary."""
    mentions = index.find(text or "")
    if not mentions:
        return (text or "").strip()

    report.leaked_names.extend(sorted(mentions))
    report.prose_replaced = True
    return deterministic_summary(cards)
