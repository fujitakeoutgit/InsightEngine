"""Tests for the parts of the semantic pipeline that must hold without an LLM.

The model is not exercised here on purpose: these are the mechanical guarantees
that stand even if the model behaves badly.
"""

from __future__ import annotations

import pytest

from app.db import connect
from app.llm.guard import (
    GuardReport, NameIndex, audit_prose, deterministic_summary, validate_indices,
)
from app.llm.pipeline import _relax
from app.search_local import cards_by_oracle_ids, search_mtg_database


@pytest.fixture(scope="module")
def conn():
    c = connect()
    yield c
    c.close()


@pytest.fixture(scope="module")
def names(conn):
    return NameIndex(conn)


# --- recall rescue ---------------------------------------------------------

def test_relax_demotes_anded_phrases():
    relaxed = _relax({"oracle_contains": ["sacrifice a creature", "when this creature dies"]})
    assert relaxed is not None
    assert "oracle_contains" not in relaxed
    assert set(relaxed["oracle_any"]) == {"sacrifice a creature", "when this creature dies"}


def test_relax_leaves_single_phrase_alone():
    assert _relax({"oracle_contains": ["sacrifice a creature"]}) is None


def test_relax_merges_into_existing_any():
    relaxed = _relax({"oracle_contains": ["a", "b"], "oracle_any": ["c"]})
    assert relaxed is not None
    assert set(relaxed["oracle_any"]) == {"a", "b", "c"}


def test_relaxation_actually_recovers_cards(conn):
    """The failure this exists for: ANDed phrases match nothing, ORed match many."""
    strict = {"oracle_contains": ["sacrifice a creature", "when this creature dies"]}
    assert search_mtg_database(conn, strict, limit=50) == []

    relaxed = _relax(strict)
    assert relaxed is not None
    assert len(search_mtg_database(conn, relaxed, limit=50)) == 50


def test_tilde_placeholder_becomes_a_wildcard(conn):
    """Planners emit Scryfall's ~ for the card's own name; it must not be literal."""
    literal = conn.execute(
        "SELECT COUNT(*) n FROM cards WHERE oracle_all LIKE '%when ~ dies%'"
    ).fetchone()["n"]
    assert literal == 0, "no card text actually contains a tilde"

    cards = search_mtg_database(conn, {"oracle_contains": ["when ~ dies"]}, limit=50)
    assert len(cards) == 50
    for card in cards:
        # Double-faced cards carry no front-face oracle_text; the match is
        # against the combined text of every face.
        faces = card.get("card_faces") or []
        combined = " ".join(
            [card.get("oracle_text") or "", *(f.get("oracle_text", "") for f in faces)]
        ).lower()
        assert "dies" in combined


# --- index validation ------------------------------------------------------

def test_indices_are_range_checked():
    valid, invalid = validate_indices([1, 3, 50, 51, 0, -2], 50)
    assert valid == [0, 2, 49]        # converted to 0-based
    assert sorted(invalid) == [-2, 0, 51]


def test_non_integer_indices_rejected():
    valid, invalid = validate_indices(["3", None, True, 2.5], 10)
    assert valid == []
    assert len(invalid) == 4


def test_garbage_payload_yields_nothing():
    assert validate_indices("not a list", 10) == ([], [])
    assert validate_indices(None, 10) == ([], [])


def test_invented_oracle_ids_resolve_to_nothing(conn):
    """A fabricated id cannot become a card -- the core structural guarantee."""
    real = conn.execute("SELECT oracle_id FROM cards LIMIT 1").fetchone()["oracle_id"]
    found = cards_by_oracle_ids(conn, [real, "00000000-dead-beef-0000-000000000000"])
    assert set(found) == {real}


# --- prose auditing --------------------------------------------------------

def test_clean_prose_passes_through(names):
    report = GuardReport()
    text = "Several low-cost sacrifice outlets appear, mostly in black."
    assert audit_prose(text, names, [], report) == text
    assert report.clean


def test_named_card_in_prose_is_caught_and_replaced(conn, names):
    report = GuardReport()
    cards = search_mtg_database(conn, {"oracle_tags": ["sacrifice-outlet-creature"]}, limit=5)
    out = audit_prose(
        "You should consider Blood Artist and Viscera Seer here.", names, cards, report
    )
    assert not report.clean
    assert report.prose_replaced
    assert "Blood Artist" in report.leaked_names
    assert "Blood Artist" not in out          # replaced with the factual summary
    assert "cards matched" in out


def test_lowercase_common_words_do_not_false_positive(names):
    report = GuardReport()
    text = "these cards counter spells, deal with fire, and opt for card draw"
    audit_prose(text, names, [], report)
    assert report.clean, f"false positives: {report.leaked_names}"


def test_short_names_are_not_flagged(names):
    # 'Fire', 'Shock', 'Opt' are real cards but too collision-prone to flag.
    assert not names.find("Fire and Shock and Opt")


# --- deterministic summary -------------------------------------------------

def test_summary_of_empty_set_is_exact():
    assert deterministic_summary([]) == "The database returned no cards matching this query."


def test_summary_reports_real_statistics(conn):
    cards = search_mtg_database(conn, {"type_contains": ["Creature"], "colors": "R"}, limit=25)
    summary = deterministic_summary(cards)
    assert "25 cards matched" in summary
    assert "red" in summary
