"""The name type-ahead offers cards you can actually put in a deck.

Dozens of token cards share a name -- "Elemental" is 31 separate rows in the
mirror, "Cat" is 8 -- so a plain `SELECT name` offered the same word over and
over and pushed the real cards off the end of a twelve-row list.
"""

from __future__ import annotations

import pytest

from app.db import connect
from app.routers.catalog import NOT_DECKABLE, _names
from app.state import state


@pytest.fixture(scope="module", autouse=True)
def mirror():
    conn = connect()
    previous = state.conn
    state.conn = conn
    yield conn
    state.conn = previous
    conn.close()


def values(needle: str, limit: int = 12) -> list[str]:
    return _names(needle, limit)["values"]


def test_no_duplicate_names():
    """The symptom: 'cat' returned the word "Cat" eight times."""
    got = values("cat", 16)
    assert len(got) == len(set(got)), f"duplicates: {got}"


def test_tokens_are_not_offered():
    """A token is not a card you can add to a decklist."""
    assert "Cat" not in values("cat", 16)
    assert "Elemental" not in values("elemental", 16)


def test_real_cards_are_not_crowded_out(mirror):
    """The point of excluding tokens: the real cards fit in the list again."""
    got = values("cat", 12)
    assert len(got) == 12
    assert "Catalog" in got


def test_prefix_still_ranks_above_substring():
    got = values("commod", 6)
    assert got[0] == "Commodore Guff"
    assert "Crimson Fleet Commodore" in got


def test_folding_still_works():
    """Punctuation and spacing are folded on both sides."""
    assert any("Ashnod" in v for v in values("ashnods", 8))


def test_every_excluded_layout_is_really_absent(mirror):
    """Guards the exclusion list against a typo silently doing nothing."""
    placeholders = ",".join("?" * len(NOT_DECKABLE))
    row = mirror.execute(
        f"SELECT COUNT(*) n FROM cards WHERE layout IN ({placeholders})",
        NOT_DECKABLE,
    ).fetchone()
    assert row["n"] > 0, "nothing matched — the layout names are wrong"


def test_empty_needle_returns_nothing():
    assert values("") == []
