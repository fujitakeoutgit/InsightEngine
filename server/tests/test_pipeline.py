"""Tests for the parts of the semantic pipeline that must hold without an LLM.

The model is not exercised here on purpose: these are the mechanical guarantees
that stand even if the model behaves badly.
"""

from __future__ import annotations

import pytest

from app.db import connect
from app.llm import prompts
from app.llm.guard import validate_indices
from app.llm.pipeline import SemanticPipeline, _relax
from app.search_local import cards_by_oracle_ids, search_mtg_database


@pytest.fixture(scope="module")
def conn():
    c = connect()
    yield c
    c.close()


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


# --- no text channel -------------------------------------------------------

def _leaf_types(schema: dict) -> set[str]:
    """Every scalar type reachable in a JSON Schema."""
    found: set[str] = set()
    kind = schema.get("type")
    if kind == "object":
        for child in (schema.get("properties") or {}).values():
            found |= _leaf_types(child)
    elif kind == "array":
        found |= _leaf_types(schema.get("items") or {})
    elif kind:
        found.add(kind)
    return found


def test_selection_schema_cannot_carry_text():
    """The model grades candidates with integers and nothing else.

    This is the structural half of the no-hallucination guarantee: with no
    string field in the schema, constrained decoding leaves the model no way
    to author text that reaches the user.
    """
    assert _leaf_types(prompts.SELECT_SCHEMA) == {"integer"}


def test_no_summarisation_prompt_remains():
    assert not hasattr(prompts, "SUMMARY_SCHEMA")
    assert not hasattr(prompts, "SUMMARY_SYSTEM")


# --- plan isolation --------------------------------------------------------

def test_one_broken_plan_does_not_kill_the_run(conn):
    """The regression: a planner emitted a regex as a colour and the whole
    eight-minute run aborted on QueryCompileError."""
    pipeline = SemanticPipeline(conn)
    plans = [
        {"rationale": "good plan", "filters": {"oracle_any": ["sacrifice a creature"]}},
        {"rationale": "regex as colour", "filters": {"colors": "^[^b]*$"}},
        {"rationale": "unknown key", "filters": {"nonsense_key": "x"}},
        {"rationale": "bad rarity", "filters": {"rarity": ["legendary"]}},
        {"rationale": "another good plan", "filters": {"type_contains": ["Creature"]}},
    ]
    cards, stats, warnings = pipeline.execute_plans(plans, None, tags=None)

    assert cards, "surviving plans must still produce candidates"
    assert len(stats) == len(plans)
    failed = [s for s in stats if s.get("error")]
    assert len(failed) == 3
    assert any("colour" in w for w in warnings)


def test_colour_exclusion_replaces_the_regex_workaround(conn):
    """'nonblack' now has a real filter, so no planner needs a pattern."""
    cards = search_mtg_database(
        conn,
        {"type_contains": ["Creature"], "color_identity_exclude": "B"},
        limit=60,
    )
    assert len(cards) == 60
    for card in cards:
        assert "B" not in card["color_identity"]


def test_global_constraints_reach_every_plan_and_the_sweep(conn):
    """A 'nonblack' request leaked black cards: the constraint lived only in
    the prompt, so plans applied it inconsistently and the tag sweep not at
    all. It is now forced onto every query in code."""
    pipeline = SemanticPipeline(conn)
    plans = [
        # None of these mention colour; the constraint must still bite.
        {"rationale": "sac outlets", "filters": {"oracle_any": ["sacrifice a creature"]}},
        {"rationale": "death triggers", "filters": {"oracle_any": ["dies"]}},
    ]
    tags = [{"slug": "sacrifice-outlet-creature", "card_count": 888}]

    loose, _, _ = pipeline.execute_plans(plans, None, tags=tags)
    strict, _, _ = pipeline.execute_plans(
        plans, None, tags=tags, constraints={"color_identity_exclude": "B"},
    )

    assert any("B" in (c["color_identity"] or "") for c in loose), "sanity: black leaks without it"
    assert strict, "constraint must not empty the result"
    offenders = [c["name"] for c in strict if "B" in (c["color_identity"] or "")]
    assert not offenders, f"black cards survived a nonblack search: {offenders[:5]}"


def test_global_constraint_merges_with_a_plans_own_exclusion():
    from app.llm.pipeline import _apply_global

    merged = _apply_global(
        {"color_identity_exclude": "R"}, {"color_identity_exclude": "B"}
    )
    assert set(merged["color_identity_exclude"]) == {"R", "B"}


def test_colour_exclusion_accepts_words_and_letters(conn):
    by_word = search_mtg_database(conn, {"colors_exclude": "black, red"}, limit=20)
    by_letter = search_mtg_database(conn, {"colors_exclude": "BR"}, limit=20)
    assert [c["oracle_id"] for c in by_word] == [c["oracle_id"] for c in by_letter]
    for card in by_word:
        assert not ({"B", "R"} & set(card["colors"]))
