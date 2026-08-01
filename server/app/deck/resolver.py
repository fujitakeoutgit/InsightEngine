"""Resolve raw decklist names to real cards.

A deliberate ladder, cheapest and most certain first. Each rung is a different
kind of near-miss, and the rung that matched is reported so the UI can show
confidence rather than silently guessing:

  exact      folded name matches exactly -- 'fire/fall', 'fire fall' and
             'firefall' all fold to the same key, so all three land here
  face       the entry names one face of a multi-face card ('Fire' -> 'Fire // Ice')
  prefix     the entry is a unique prefix of exactly one card
  fuzzy      rapidfuzz similarity above threshold, unambiguous winner
  ambiguous  several candidates scored close together -- resolved to the best,
             but flagged with alternatives for the user to choose
  unresolved nothing plausible

Folding is what makes punctuation and spacing irrelevant; see `db.fold_name`.
"""

from __future__ import annotations

import sqlite3
from dataclasses import dataclass, field
from typing import Any

from rapidfuzz import fuzz, process

from ..db import fold_name, row_to_card
from ..search_local import LIST_COLUMNS, deckable_clause

# Below this, a suggestion is worse than admitting defeat.
FUZZY_FLOOR = 82.0
# Two candidates inside this margin are treated as genuinely ambiguous.
AMBIGUITY_MARGIN = 4.0


@dataclass
class Resolution:
    raw_name: str
    quantity: int
    section: str
    match: str                       # exact | face | prefix | fuzzy | ambiguous | unresolved
    card: dict[str, Any] | None = None
    score: float = 0.0
    alternatives: list[str] = field(default_factory=list)
    line_number: int = 0

    @property
    def resolved(self) -> bool:
        return self.card is not None

    def as_dict(self) -> dict[str, Any]:
        return {
            "raw_name": self.raw_name,
            "quantity": self.quantity,
            "section": self.section,
            "match": self.match,
            "score": round(self.score, 1),
            "alternatives": self.alternatives,
            "line_number": self.line_number,
            "card": self.card,
        }


class CardNameResolver:
    """Holds the folded-name indices. Build once, reuse across requests."""

    def __init__(self, conn: sqlite3.Connection) -> None:
        self.conn = conn
        self._exact: dict[str, str] = {}      # folded full name -> oracle_id
        self._face: dict[str, str] = {}       # folded face name -> oracle_id
        self._display: dict[str, str] = {}    # oracle_id -> display name
        self._rank: dict[str, int] = {}       # oracle_id -> EDHREC rank
        self._choices: list[str] = []         # folded keys for rapidfuzz

        # Tokens, emblems and art series are excluded outright. An art print
        # carries its card's name verbatim -- "Sol Ring // Sol Ring" -- so
        # indexing them meant a decklist line could resolve to a picture of the
        # card instead of the card, and meant the ambiguity list offered those
        # pictures as corrections.
        for row in conn.execute(
            f"SELECT oracle_id, name, edhrec_rank FROM cards WHERE {deckable_clause()}"
        ):
            oracle_id, name = row["oracle_id"], row["name"]
            self._display[oracle_id] = name
            # Unranked cards sort last rather than first.
            self._rank[oracle_id] = row["edhrec_rank"] if row["edhrec_rank"] is not None \
                else 1_000_000
            self._exact.setdefault(fold_name(name), oracle_id)
            if " // " in name:
                for face in name.split(" // "):
                    self._face.setdefault(fold_name(face), oracle_id)

        self._choices = list(self._exact.keys())

    # -- lookup helpers ----------------------------------------------------

    def _card(self, oracle_id: str) -> dict[str, Any] | None:
        row = self.conn.execute(
            f"SELECT {LIST_COLUMNS} FROM cards WHERE oracle_id = ?", (oracle_id,)
        ).fetchone()
        return row_to_card(row) if row else None

    def _prefix_candidates(self, folded: str, cap: int = 25) -> list[str]:
        """Folded keys that begin with `folded`, most played first.

        This is the rung that rescues shorthand entries like "1 elf" or
        "atraxa" -- a unique prefix resolves outright, and several plausible
        prefixes resolve to the most-played card with the rest offered as
        alternatives.
        """
        if len(folded) < 4:
            return []
        hits = [key for key in self._exact if key.startswith(folded)]
        if not hits or len(hits) > cap:
            return []
        return sorted(hits, key=lambda k: self._rank[self._exact[k]])

    # -- the ladder --------------------------------------------------------

    def resolve_name(self, raw: str) -> tuple[str, str | None, float, list[str]]:
        """Return (match_kind, oracle_id, score, alternatives)."""
        folded = fold_name(raw)
        if not folded:
            return "unresolved", None, 0.0, []

        if oracle_id := self._exact.get(folded):
            return "exact", oracle_id, 100.0, []

        if oracle_id := self._face.get(folded):
            return "face", oracle_id, 100.0, []

        prefixes = self._prefix_candidates(folded)
        if len(prefixes) == 1:
            return "prefix", self._exact[prefixes[0]], 95.0, []
        if prefixes:
            alternatives = [self._display[self._exact[k]] for k in prefixes[1:6]]
            return "ambiguous", self._exact[prefixes[0]], 90.0, alternatives

        # Names are folded to a single token, so token-based scorers have
        # nothing to work with. Plain ratio is used because it penalises the
        # length gap that makes a short name a spurious substring match
        # ("Llanowar" scoring above "Llanowar Elves" for "Llanowar Elfs").
        matches = process.extract(
            folded, self._choices, scorer=fuzz.ratio, limit=5, score_cutoff=FUZZY_FLOOR
        )
        if not matches:
            return "unresolved", None, 0.0, []

        best_key, best_score, _ = matches[0]
        close = [
            self._display[self._exact[key]]
            for key, score, _ in matches[1:]
            if best_score - score <= AMBIGUITY_MARGIN
        ]
        kind = "ambiguous" if close else "fuzzy"
        return kind, self._exact[best_key], best_score, close

    def resolve(self, raw_name: str, quantity: int, section: str,
                line_number: int = 0) -> Resolution:
        kind, oracle_id, score, alternatives = self.resolve_name(raw_name)
        return Resolution(
            raw_name=raw_name,
            quantity=quantity,
            section=section,
            match=kind,
            card=self._card(oracle_id) if oracle_id else None,
            score=score,
            alternatives=alternatives,
            line_number=line_number,
        )
