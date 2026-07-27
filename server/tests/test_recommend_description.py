"""The deck description as a theme signal for the non-AI recommender.

A decklist says what a deck contains; the description says what it is for. The
matching here is deliberately crude -- substring against tag slugs -- because it
can only ever reweight themes the deck already carries. It cannot introduce one,
so a loose match costs ranking, never a card that does not belong.
"""

from __future__ import annotations

import pytest

from app.deck.recommend import (
    DESCRIPTION_BOOST, Theme, derive_themes, description_terms,
)
from app.db import connect
from app.state import state


@pytest.fixture(scope="module", autouse=True)
def mirror():
    conn = connect()
    previous = state.conn
    state.conn = conn
    yield conn
    state.conn = previous
    conn.close()


# --- term extraction -------------------------------------------------------

def test_extracts_content_words():
    terms = description_terms("Sacrifice creatures for value and drain the table.")
    assert "sacrifice" in terms
    assert "creature" in terms and "creatures" in terms  # plural shed for slugs
    assert "drain" in terms


def test_drops_stopwords_and_short_words():
    terms = description_terms("This deck plays cards with the table and it is fun")
    for noise in ("this", "deck", "play", "plays", "cards", "table", "with"):
        assert noise not in terms


def test_empty_description_yields_no_terms():
    assert description_terms(None) == set()
    assert description_terms("") == set()
    assert description_terms("   ") == set()


def test_short_words_never_match():
    # Three-letter words would hit far too many slugs by chance.
    assert description_terms("go on it be my elf") == set()


# --- theme reweighting -----------------------------------------------------

def _themes(conn, ids, description=None):
    return {t.slug: t for t in derive_themes(conn, sorted(ids), description)}


def test_description_cannot_introduce_a_theme(mirror):
    """The strongest guarantee: describing something absent adds nothing."""
    ids = [
        r["oracle_id"] for r in mirror.execute(
            "SELECT oracle_id FROM cards WHERE name IN "
            "('Llanowar Elves','Elvish Mystic','Fyndhorn Elves','Elvish Archdruid',"
            "'Priest of Titania','Elvish Visionary')"
        )
    ]
    plain = _themes(mirror, ids)
    described = _themes(mirror, ids, "This deck is all about dragons and burning things")
    assert set(described) == set(plain), "description invented or removed a theme"


def test_named_theme_is_boosted_and_flagged(mirror):
    ids = [
        r["oracle_id"] for r in mirror.execute(
            "SELECT oracle_id FROM cards WHERE name IN "
            "('Blood Artist','Zulaport Cutthroat','Viscera Seer','Carrion Feeder',"
            "\"Ashnod's Altar\",'Village Rites','Bastion of Remembrance')"
        )
    ]
    plain = _themes(mirror, ids)
    described = _themes(mirror, ids, "Sacrifice creatures repeatedly for value.")

    hits = [s for s in described if "sacrifice" in s]
    assert hits, "expected at least one sacrifice tag on this deck"
    for slug in hits:
        assert described[slug].described is True
        assert described[slug].score == pytest.approx(plain[slug].score * DESCRIPTION_BOOST)
        # Boosting must not silently change the underlying counts.
        assert described[slug].in_deck == plain[slug].in_deck


def test_unnamed_themes_are_untouched(mirror):
    ids = [
        r["oracle_id"] for r in mirror.execute(
            "SELECT oracle_id FROM cards WHERE name IN "
            "('Blood Artist','Zulaport Cutthroat','Viscera Seer','Carrion Feeder',"
            "\"Ashnod's Altar\",'Village Rites')"
        )
    ]
    plain = _themes(mirror, ids)
    described = _themes(mirror, ids, "Sacrifice creatures for value.")
    for slug, theme in described.items():
        if not theme.described:
            assert theme.score == pytest.approx(plain[slug].score)


def test_functional_tags_stay_out_of_signature_even_when_described(mirror):
    """Describing a generic job must not turn it into a recommendation licence.

    "This deck ramps" is true of a thousand cards; letting it qualify would fill
    the list with every mana rock ever printed.
    """
    themes = derive_themes(
        mirror,
        sorted(r["oracle_id"] for r in mirror.execute(
            "SELECT oracle_id FROM cards WHERE name IN "
            "('Sol Ring','Arcane Signet','Cultivate',\"Kodama's Reach\","
            "'Rampant Growth','Farseek','Mind Stone')"
        )),
        "This deck ramps hard into big spells with mana rocks",
    )
    for theme in themes:
        if theme.slug in {"ramp", "land-ramp", "mana-rock"}:
            assert theme.signature is False


def test_boost_is_a_pure_multiplier():
    """Guards the arithmetic without needing the mirror."""
    theme = Theme(slug="sacrifice-outlet", in_deck=4, corpus=100, score=2.0)
    theme.score *= DESCRIPTION_BOOST
    assert theme.score == pytest.approx(2.0 * DESCRIPTION_BOOST)
    assert DESCRIPTION_BOOST > 1.0
