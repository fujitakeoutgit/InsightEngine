"""Non-land mana sources count toward the mana base.

A base judged on lands alone badly understates a deck that ramps on artifacts,
so rocks, dorks and mana enchantments count too. Rituals do not: they produce
mana once, which is not the repeatable source the balance measures.
"""

from __future__ import annotations

import pytest

from app.db import connect
from app.deck.parser import parse_decklist
from app.deck.resolver import CardNameResolver
from app.deck.stats import compute


@pytest.fixture(scope="module")
def conn():
    c = connect()
    yield c
    c.close()


@pytest.fixture(scope="module")
def resolver(conn):
    return CardNameResolver(conn)


def stats_for(conn, resolver, text):
    parsed = parse_decklist(text)
    resolutions = [
        resolver.resolve(e.raw_name, e.quantity, e.section, e.line_number)
        for e in parsed.entries
    ]
    return compute(conn, resolutions)


def test_rocks_and_dorks_are_counted(conn, resolver):
    s = stats_for(conn, resolver, """
1 Sol Ring
1 Arcane Signet
1 Llanowar Elves
1 Birds of Paradise
4 Forest
""")
    assert s["mana_rocks"] == 2, "Sol Ring and Arcane Signet"
    assert s["mana_dorks"] == 2, "Llanowar Elves and Birds of Paradise"
    assert s["nonland_sources"] == 4
    assert s["lands"] == 4


def test_dorks_add_to_the_color_they_make(conn, resolver):
    """Green sources must exceed the land count once dorks are counted."""
    with_dorks = stats_for(conn, resolver, "4 Llanowar Elves\n4 Forest")
    lands_only = stats_for(conn, resolver, "4 Forest")
    assert with_dorks["produced"]["G"] > lands_only["produced"]["G"]
    assert with_dorks["produced"]["G"] == 8


def test_rituals_are_not_sources(conn, resolver):
    """Dark Ritual has produced_mana but is not a mana base."""
    s = stats_for(conn, resolver, "4 Dark Ritual\n4 Swamp")
    assert s["nonland_sources"] == 0
    assert s["produced"].get("B") == 4, "only the Swamps"


def test_a_deck_with_no_nonland_sources_reports_zero(conn, resolver):
    s = stats_for(conn, resolver, "1 Lightning Bolt\n4 Mountain")
    assert s["mana_rocks"] == 0
    assert s["mana_dorks"] == 0
    assert s["nonland_sources"] == 0


def test_colorless_rocks_do_not_inflate_a_color(conn, resolver):
    """Sol Ring makes C, which is not one of the five tracked colors."""
    s = stats_for(conn, resolver, "1 Sol Ring\n4 Island")
    assert s["mana_rocks"] == 1
    assert set(s["produced"]) == {"U"}


def test_gap_improves_when_a_dork_supplies_the_short_color(conn, resolver):
    """The balance must actually respond to a non-land source."""
    short = stats_for(conn, resolver, "4 Llanowar Elves\n2 Forest")
    green_short = next(b for b in short["balance"] if b["color"] == "G")
    without = stats_for(conn, resolver, "4 Grizzly Bears\n2 Forest")
    green_without = next(b for b in without["balance"] if b["color"] == "G")
    assert green_short["sources"] > green_without["sources"]


def test_a_color_the_deck_never_casts_gets_no_row(conn, resolver):
    """Ten Swamps in a deck with no black card is not a black mana base.

    This replaces a test of the old signed "gap", which subtracted two
    percentages that did not share a denominator and reported a *surplus* for
    every color of every multicolor deck -- including colors the deck could
    not cast. Black earned a row and a healthy number here purely for sitting
    on ten lands nothing spent.

    The balance now answers "how much of my mana works for this color, against
    how much that color is asked for", and a color never asked for has no
    question to answer.
    """
    s = stats_for(conn, resolver, "4 Lightning Bolt\n10 Mountain\n10 Swamp")
    rows = {b["color"]: b for b in s["balance"]}
    assert "B" not in rows, "black is never cast, so it is not part of the base"

    red = rows["R"]
    assert red["pips"] > 0
    # Ten Mountains against four single-pip Bolts: comfortably more than one
    # source per pip, which is what the ratio measures.
    assert red["ratio"] > 1
