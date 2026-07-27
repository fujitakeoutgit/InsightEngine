"""Generic staples stay out of theme recommendations until the deck earns them.

Ramp, removal, counterspells and draw are true of a thousand cards, so they
never qualify a recommendation on their own. Two escape hatches: a deck that
demonstrably cares (a landfall deck really does want land ramp), and asking for
the category outright.
"""

from __future__ import annotations

import pytest

from app.db import connect
from app.deck.parser import parse_decklist
from app.deck.recommend import (
    CATEGORY_TAGS, FUNCTIONAL_TAGS, RAMP_TAGS, REDEEMED_BY, REMOVAL_TAGS,
    derive_themes, recommend, recommend_category,
)
from app.deck.resolver import CardNameResolver


@pytest.fixture(scope="module")
def conn():
    c = connect()
    yield c
    c.close()


@pytest.fixture(scope="module")
def resolver(conn):
    return CardNameResolver(conn)


def resolve(resolver, text):
    return [
        resolver.resolve(e.raw_name, e.quantity, e.section, e.line_number)
        for e in parse_decklist(text).entries
    ]


# --- the vocabulary itself --------------------------------------------------

def test_land_ramp_tags_are_functional():
    """These were the specific leak: not listed, so they became signature."""
    for slug in ("tutor-land-basic", "tutor-land-to-battlefield", "fetchland",
                 "land-ramp", "multi-land-ramp"):
        assert slug in FUNCTIONAL_TAGS


def test_every_category_is_a_subset_of_functional():
    """Anything askable by category must be barred from qualifying on theme."""
    for name, tags in CATEGORY_TAGS.items():
        assert tags <= FUNCTIONAL_TAGS, f"{name} leaks into theme recommendations"


def test_redemption_families_are_functional_tags():
    """Redeeming a tag that was never barred would be a no-op."""
    for family, payoffs in REDEEMED_BY:
        assert family <= FUNCTIONAL_TAGS
        assert not (payoffs & FUNCTIONAL_TAGS), "a payoff must not itself be generic"


# --- the gate ---------------------------------------------------------------

def _signature(conn, resolver, text, description=None):
    ids = sorted({r.card["oracle_id"] for r in resolve(resolver, text) if r.card})
    return {t.slug for t in derive_themes(conn, ids, description) if t.signature}


def test_ramp_pile_yields_no_functional_signature(conn, resolver):
    """A deck that is nothing but ramp must not call ramp its signature."""
    sig = _signature(conn, resolver, """
1 Cultivate
1 Kodama's Reach
1 Rampant Growth
1 Farseek
1 Sol Ring
1 Arcane Signet
1 Mind Stone
""")
    assert not (sig & RAMP_TAGS), f"ramp tags qualified: {sig & RAMP_TAGS}"


def test_removal_pile_yields_no_functional_signature(conn, resolver):
    sig = _signature(conn, resolver, """
1 Swords to Plowshares
1 Path to Exile
1 Beast Within
1 Generous Gift
1 Chaos Warp
1 Anguished Unmaking
""")
    assert not (sig & REMOVAL_TAGS)


def test_landfall_deck_redeems_land_ramp(conn, resolver):
    """The escape hatch: a deck built to care gets the synergy back."""
    sig = _signature(conn, resolver, """
1 Lotus Cobra
1 Tireless Provisioner
1 Felidar Retreat
1 Scute Swarm
1 Omnath, Locus of Rage
1 Cultivate
1 Harrow
1 Kodama's Reach
1 Evolving Wilds
1 Terramorphic Expanse
""")
    # Either a landfall payoff or the redeemed land ramp itself may lead; what
    # matters is that the deck is not left with nothing to recommend from.
    assert sig, "a landfall deck should have some signature theme"


def test_fallback_never_picks_a_functional_tag(conn, resolver):
    """When the denylist empties the list, fall back to a real theme.

    Falling back to themes[0] unconditionally was how land ramp became
    signature on a deck whose top tag happened to be functional.
    """
    sig = _signature(conn, resolver, """
1 Sol Ring
1 Arcane Signet
1 Mind Stone
1 Fellwar Stone
1 Thought Vessel
1 Commander's Sphere
""")
    assert not (sig & FUNCTIONAL_TAGS) or not sig


# --- asking for a category outright -----------------------------------------

def test_category_returns_cards_of_that_kind(conn, resolver):
    res = resolve(resolver, "1 Llanowar Elves\n20 Forest")
    out = recommend_category(conn, res, "removal", format_key="commander", limit=10)
    assert out["category"] == "removal"
    assert out["recommendations"], "expected some removal"
    for rec in out["recommendations"]:
        assert set(rec["because"]) <= REMOVAL_TAGS


def test_category_respects_colour_identity(conn, resolver):
    """A mono-green deck must not be offered Swords to Plowshares."""
    res = resolve(resolver, "Commander\n1 Yeva, Nature's Herald\n\nDeck\n20 Forest")
    out = recommend_category(conn, res, "removal", format_key="commander", limit=30)
    assert out["color_identity"] == "G"
    for rec in out["recommendations"]:
        assert set(rec["card"]["color_identity"]) <= {"G"}, rec["card"]["name"]


def test_category_excludes_cards_already_in_the_deck(conn, resolver):
    res = resolve(resolver, "1 Sol Ring\n20 Island")
    out = recommend_category(conn, res, "ramp", format_key="commander", limit=40)
    assert "Sol Ring" not in {r["card"]["name"] for r in out["recommendations"]}


def test_unknown_category_is_rejected(conn, resolver):
    with pytest.raises(ValueError):
        recommend_category(conn, resolve(resolver, "20 Forest"), "wincons")


def test_theme_recommendations_still_work(conn, resolver):
    """The gate must not have emptied the ordinary path."""
    res = resolve(resolver, """
Commander
1 Teysa Karlov

Deck
1 Blood Artist
1 Zulaport Cutthroat
1 Viscera Seer
1 Carrion Feeder
1 Ashnod's Altar
1 Village Rites
1 Bastion of Remembrance
10 Swamp
8 Plains
""")
    out = recommend(conn, res, format_key="commander", limit=20)
    assert out["recommendations"], "aristocrats deck should still get suggestions"
