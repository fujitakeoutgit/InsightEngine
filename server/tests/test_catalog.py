"""Type-ahead catalogue tests, focused on the name lookup.

The name catalogue is what the deck editor's Search tab types against, so the
folding behaviour matters: a player typing "fire ice" or "fireice" is looking
for the same split card as one who types "Fire // Ice".
"""

from __future__ import annotations

import pytest

from app.db import connect
from app.routers.catalog import _catalog, _names
from app.state import state


@pytest.fixture(scope="module", autouse=True)
def mirror():
    conn = connect()
    previous = state.conn
    state.conn = conn
    yield conn
    state.conn = previous
    conn.close()


def names(query: str, limit: int = 10) -> list[str]:
    return _names(query, limit)["values"]


@pytest.mark.parametrize("query", ["Fire // Ice", "fire//ice", "fire ice", "fireice", "FIRE ICE"])
def test_split_card_found_however_it_is_typed(query):
    assert "Fire // Ice" in names(query)


def test_prefix_ranks_above_substring():
    found = names("sol ring")
    assert found[0] == "Sol Ring"


def test_punctuation_in_the_query_is_ignored():
    assert "Jace, the Mind Sculptor" in names("jace the mind")


def test_diacritics_fold():
    # Aether cards are stored with the ligature; typing ASCII must still find
    # them, which is the same folding the deck resolver relies on.
    assert names("aetherling") == ["Aetherling"]


def test_limit_is_honoured():
    assert len(names("a", limit=3)) == 3


def test_empty_query_returns_nothing():
    # An empty box should not dump the first N cards in the database at you.
    assert _names("", 10) == {"kind": "names", "values": [], "total": 0}


def test_digital_only_cards_are_hidden():
    # Alchemy rebalances share their base card's name behind an "A-" prefix.
    assert not [n for n in names("A-", limit=50) if n.startswith("A-")]


def test_other_catalogs_still_load():
    assert "Creature" in _catalog("types")
    assert "Flying" in _catalog("keywords")
