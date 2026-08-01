"""A decklist line never means a token, an emblem or a piece of art.

The resolver indexed every row in the mirror, and an art print carries its
card's name verbatim -- "Sol Ring // Sol Ring". So a line could resolve to a
picture of the card rather than the card, and the ambiguity list offered those
pictures as the suggested corrections.
"""

from __future__ import annotations

import pytest

from app.db import connect
from app.deck.parser import parse_decklist
from app.deck.resolver import CardNameResolver
from app.search_local import NOT_DECKABLE


@pytest.fixture(scope="module")
def conn():
    c = connect()
    yield c
    c.close()


@pytest.fixture(scope="module")
def resolver(conn):
    return CardNameResolver(conn)


def layout_of(conn, oracle_id: str) -> str:
    return conn.execute(
        "SELECT layout FROM cards WHERE oracle_id = ?", (oracle_id,)
    ).fetchone()["layout"]


def test_an_art_print_is_never_the_match(conn, resolver):
    """The symptom: "Sol R" offered "Sol Ring // Sol Ring" as an alternative."""
    _, oracle_id, _, alternatives = resolver.resolve_name("Sol R")
    assert oracle_id is not None
    assert layout_of(conn, oracle_id) not in NOT_DECKABLE
    assert "Sol Ring // Sol Ring" not in alternatives


def test_no_alternative_is_an_extra(conn, resolver):
    """Whatever is offered as a correction has to be a card you can play."""
    for name in ("Sol R", "Blood Art", "Lightning B", "Delver of Sec"):
        _, _, _, alternatives = resolver.resolve_name(name)
        for alt in alternatives:
            # Display names round-trip through the same index they came from.
            _, oracle_id, _, _ = resolver.resolve_name(alt)
            assert oracle_id is not None, f"{alt!r} does not resolve back"
            assert layout_of(conn, oracle_id) not in NOT_DECKABLE, alt


def test_real_cards_still_resolve(resolver):
    """The exclusion must not have taken the deck with it."""
    for name, expected in [
        ("Sol Ring", "exact"),
        ("Lightning Bolt", "exact"),
        ("Elesh Norn", "face"),
        ("Lightnin Bolt", "fuzzy"),
    ]:
        kind, oracle_id, _, _ = resolver.resolve_name(name)
        assert oracle_id is not None, name
        assert kind == expected, f"{name}: {kind}"


def test_a_tokens_section_carries_no_cards():
    """Every exporter emits one, and it lists what the deck makes."""
    parsed = parse_decklist(
        "Deck\n1 Sol Ring\n4 Forest\n\nTokens\n1 Treasure\n2 Beast\n"
    )
    names = [entry.raw_name for entry in parsed.entries]
    assert names == ["Sol Ring", "Forest"]
    assert any("Treasure" in line for line in parsed.ignored_lines)


def test_a_section_after_tokens_still_counts():
    """Dropping the lines must not swallow the rest of the file."""
    parsed = parse_decklist(
        "Deck\n1 Sol Ring\n\nTokens\n1 Treasure\n\nSideboard\n2 Duress\n"
    )
    assert [(e.raw_name, e.section) for e in parsed.entries] == [
        ("Sol Ring", "main"), ("Duress", "sideboard"),
    ]
