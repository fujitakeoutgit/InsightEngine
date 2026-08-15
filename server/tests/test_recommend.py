"""Recommendation and saved-deck tests."""

from __future__ import annotations

import pytest

from app.db import connect, init_db
from app.deck import storage
from app.deck.parser import parse_decklist
from app.deck.recommend import derive_themes, recommend
from app.deck.resolver import CardNameResolver

ARISTOCRATS = """Commander
1 Teysa Karlov

Deck
1 Blood Artist
1 Zulaport Cutthroat
1 Viscera Seer
1 Carrion Feeder
1 Ashnod's Altar
1 Phyrexian Altar
1 Village Rites
1 Priest of Forgotten Gods
1 Midnight Reaper
1 Grim Haruspex
"""


@pytest.fixture(scope="module")
def conn():
    c = connect()
    init_db(c)
    yield c
    c.close()


@pytest.fixture(scope="module")
def resolver(conn):
    return CardNameResolver(conn)


def resolve_deck(resolver, text):
    return [
        resolver.resolve(e.raw_name, e.quantity, e.section, e.line_number)
        for e in parse_decklist(text).entries
    ]


# --- themes ----------------------------------------------------------------

def test_themes_describe_the_deck_not_the_rules(conn, resolver):
    """Generic mechanics must not drown out what the deck is actually doing."""
    resolutions = resolve_deck(resolver, ARISTOCRATS)
    ids = [r.card["oracle_id"] for r in resolutions if r.card]
    themes = derive_themes(conn, ids)

    slugs = [t.slug for t in themes]
    assert slugs, "an aristocrats deck must produce themes"
    assert "activated-ability" not in slugs
    assert "triggered-ability" not in slugs
    assert any("sacrifice" in s or "death" in s or "dies" in s for s in slugs), slugs


def test_functional_tags_never_count_as_signature(conn, resolver):
    """'This deck plays mana rocks' would recommend every mana rock printed."""
    from app.deck.recommend import FUNCTIONAL_TAGS

    resolutions = resolve_deck(resolver, ARISTOCRATS)
    ids = [r.card["oracle_id"] for r in resolutions if r.card]
    themes = derive_themes(conn, ids)

    signature = {t.slug for t in themes if t.signature}
    assert signature, "a deck must have at least one signature theme"
    assert not (signature & FUNCTIONAL_TAGS), signature & FUNCTIONAL_TAGS


def test_generic_staples_are_not_recommended(conn, resolver):
    """Ramp and generic removal must not appear just for being good cards."""
    resolutions = resolve_deck(resolver, ARISTOCRATS)
    result = recommend(conn, resolutions, format_key="commander", limit=150)
    names = {r["card"]["name"] for r in result["recommendations"]}

    # Colorless auto-includes every Commander deck runs. None of these
    # interact with sacrifice, so none should be suggested here.
    staples = {"Sol Ring", "Arcane Signet", "Swiftfoot Boots", "Lightning Greaves",
               "Commander's Sphere", "Mind Stone", "Fellwar Stone", "Talisman of Hierarchy"}
    assert not (names & staples), f"generic staples leaked in: {names & staples}"


def test_every_recommendation_hits_a_signature_theme(conn, resolver):
    resolutions = resolve_deck(resolver, ARISTOCRATS)
    result = recommend(conn, resolutions, format_key="commander", limit=150)
    signature = {t["slug"] for t in result["themes"] if t["signature"]}
    for entry in result["recommendations"]:
        assert set(entry["because"]) & signature, entry["card"]["name"]


def test_list_is_substantial(conn, resolver):
    resolutions = resolve_deck(resolver, ARISTOCRATS)
    result = recommend(conn, resolutions, format_key="commander", limit=150)
    assert len(result["recommendations"]) >= 60, len(result["recommendations"])


def test_themes_are_ranked_by_distinctiveness(conn, resolver):
    resolutions = resolve_deck(resolver, ARISTOCRATS)
    ids = [r.card["oracle_id"] for r in resolutions if r.card]
    themes = derive_themes(conn, ids)
    scores = [t.score for t in themes]
    assert scores == sorted(scores, reverse=True)


# --- recommendations -------------------------------------------------------

def test_recommendations_are_real_playable_cards(conn, resolver):
    resolutions = resolve_deck(resolver, ARISTOCRATS)
    result = recommend(conn, resolutions, format_key="commander", limit=30)

    recs = result["recommendations"]
    assert len(recs) >= 10

    owned = {r.card["oracle_id"] for r in resolutions if r.card}
    identity = set(result["color_identity"])

    for entry in recs:
        card = entry["card"]
        assert card["oracle_id"] not in owned, f"{card['name']} is already in the deck"
        assert set(card["color_identity"] or "") <= identity, card["name"]
        assert card["legalities"]["commander"] == "legal", card["name"]
        assert entry["because"], "every suggestion must say which themes it hit"


def test_recommendations_respect_commander_color_identity(conn, resolver):
    # Teysa Karlov is W/B, so nothing red, blue or green may be suggested.
    resolutions = resolve_deck(resolver, ARISTOCRATS)
    result = recommend(conn, resolutions, format_key="commander", limit=40)
    assert set(result["color_identity"]) == {"W", "B"}
    for entry in result["recommendations"]:
        assert not (set(entry["card"]["color_identity"] or "") & {"U", "R", "G"})


def test_recommendations_are_deterministic(conn, resolver):
    resolutions = resolve_deck(resolver, ARISTOCRATS)
    first = recommend(conn, resolutions, format_key="commander", limit=20)
    second = recommend(conn, resolutions, format_key="commander", limit=20)
    assert [r["card"]["name"] for r in first["recommendations"]] == \
           [r["card"]["name"] for r in second["recommendations"]]


def test_empty_deck_explains_itself(conn):
    result = recommend(conn, [], format_key="commander")
    assert result["recommendations"] == []
    assert result["note"]


# --- saved decks -----------------------------------------------------------

def test_save_load_update_delete(conn):
    saved = storage.save(conn, "Test Aristocrats", ARISTOCRATS, commander="Teysa Karlov",
                         format_key="commander")
    deck_id = saved["id"]
    assert saved["name"] == "Test Aristocrats"

    loaded = storage.load(conn, deck_id)
    assert loaded["text"] == ARISTOCRATS
    assert loaded["commander"] == "Teysa Karlov"

    assert any(d["id"] == deck_id for d in storage.listing(conn))

    updated = storage.save(conn, "Renamed", "1 Sol Ring\n", deck_id=deck_id)
    assert updated["id"] == deck_id
    assert storage.load(conn, deck_id)["name"] == "Renamed"

    storage.delete(conn, deck_id)
    with pytest.raises(storage.DeckError):
        storage.load(conn, deck_id)


def test_listing_omits_decklist_bodies(conn):
    saved = storage.save(conn, "Body check", ARISTOCRATS)
    try:
        row = next(d for d in storage.listing(conn) if d["id"] == saved["id"])
        assert "text" not in row
        assert row["lines"] > 0
    finally:
        storage.delete(conn, saved["id"])


def test_unnamed_deck_gets_a_placeholder(conn):
    saved = storage.save(conn, "   ", "1 Sol Ring\n")
    try:
        assert saved["name"] == "Untitled deck"
    finally:
        storage.delete(conn, saved["id"])


def test_missing_deck_raises(conn):
    with pytest.raises(storage.DeckError):
        storage.load(conn, 999999)
    with pytest.raises(storage.DeckError):
        storage.delete(conn, 999999)
