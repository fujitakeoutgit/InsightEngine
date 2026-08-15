"""Query-engine tests. These run against the real mirror in ../data."""

from __future__ import annotations

import pytest

from app.db import connect
from app.query.filters import FilterError, to_ast, validate
from app.query.parser import extract_semantic, parse, requires_local_engine
from app.query.sql import compile_node, wildcard_to_regex
from app.search_local import search_ast, search_mtg_database


@pytest.fixture(scope="module")
def conn():
    c = connect()
    yield c
    c.close()


def run(conn, query, **kw):
    return search_ast(conn, parse(query), **kw)


# --- parsing ---------------------------------------------------------------

def test_pair_and_bare_words():
    node = parse('c:red t:creature mv<=3')
    sql = compile_node(node)
    assert "instr(colors, 'R')" in sql.where
    assert "cmc <= ?" in sql.where


def test_exact_name_bang():
    node = parse('!"Lightning Bolt"')
    sql = compile_node(node)
    assert "lower(name) = ?" in sql.where
    assert sql.params == ["lightning bolt"]


def test_negation_and_or_grouping():
    node = parse('t:creature -t:artifact (c:red or c:blue)')
    sql = compile_node(node)
    assert "NOT (" in sql.where
    assert " OR " in sql.where


def test_semantic_extraction_keeps_structured_half():
    prompts, rest = extract_semantic(parse('q:"sacrifice things" c:black mv<=3'))
    assert prompts == ["sacrifice things"]
    where = compile_node(rest).where
    assert "instr(colors, 'B')" in where
    assert "cmc" in where


def test_local_engine_routing():
    assert requires_local_engine(parse('q:"anything"'))
    assert requires_local_engine(parse('o:"Elf_creature"'))
    assert requires_local_engine(parse('otag:sacrifice-outlet'))
    assert not requires_local_engine(parse('c:red t:creature'))


# --- wildcard --------------------------------------------------------------

def test_wildcard_regex_escapes_metacharacters():
    assert wildcard_to_regex("Elf_creature") == "Elf.*?creature"
    assert wildcard_to_regex("a.b") == r"a\.b"
    assert wildcard_to_regex("(x)_(y)") == r"\(x\).*?\(y\)"


def test_wildcard_matches_across_words(conn):
    hits = run(conn, 'o:"Elf_creature" t:creature', per_page=20)
    assert hits.total > 0
    assert all("elf" in (c["oracle_text"] or "").lower() for c in hits.cards)


def test_wildcard_is_stricter_than_plain_contains(conn):
    wild = run(conn, 'o:"draw_card"').total
    plain = run(conn, 'o:"draw a card"').total
    assert wild > plain  # 'draw two cards', 'draw a card' both match the wildcard


# --- live searches ---------------------------------------------------------

def test_color_and_cost(conn):
    res = run(conn, 'c:red t:creature mv<=3', per_page=10)
    assert res.total > 500
    for card in res.cards:
        assert "R" in card["colors"]
        assert card["cmc"] <= 3
        assert "Creature" in card["type_line"]


def test_oracle_phrase(conn):
    res = run(conn, 'o:"draw a card"', per_page=5)
    assert res.total > 500


def test_format_legality(conn):
    res = run(conn, 'legal:commander t:creature mv=1', per_page=5)
    assert res.total > 100
    for card in res.cards:
        assert card["legalities"]["commander"] == "legal"


def test_color_identity_subset(conn):
    res = run(conn, 'id<=wu t:creature', per_page=25)
    for card in res.cards:
        assert set(card["color_identity"]) <= {"W", "U"}


def test_exact_color_match(conn):
    res = run(conn, 'c=rg', per_page=25)
    for card in res.cards:
        assert set(card["colors"]) == {"R", "G"}


def test_oracle_tag_lookup(conn):
    res = run(conn, 'otag:sacrifice-outlet-creature', per_page=5)
    assert res.total > 100


def test_unknown_tag_yields_nothing_rather_than_erroring(conn):
    # 'sacrifice-outlet' looks plausible but is not a real slug. A guessed tag
    # must fail closed -- this is why the planner picks from retrieved tags.
    assert run(conn, 'otag:sacrifice-outlet').total == 0


def test_price_and_rarity_ordering(conn):
    res = run(conn, 'r>=rare usd<=1', sort="usd", order="desc", per_page=10)
    assert res.total > 0
    for card in res.cards:
        assert card["usd"] is not None and card["usd"] <= 1


# --- filter dict (the LLM's tool) ------------------------------------------

def test_filters_reject_unknown_keys():
    with pytest.raises(FilterError):
        validate({"drop_table": "x"})


def test_filters_coerce_a_lone_phrase_to_a_list():
    # A single phrase means the one-element list; discarding the plan over it
    # cost recall for no reason.
    assert validate({"oracle_contains": "draw a card"}) == {"oracle_contains": ["draw a card"]}


def test_filters_reject_genuinely_wrong_types():
    with pytest.raises(FilterError):
        validate({"oracle_contains": 42})
    with pytest.raises(FilterError):
        validate({"max_mana_cost": "three"})
    with pytest.raises(FilterError):
        validate({"oracle_contains": [1, 2, 3]})


def test_filters_execute(conn):
    cards = search_mtg_database(conn, {
        "type_contains": ["Creature"],
        "color_identity": "B",
        "color_identity_mode": "subset",
        "max_mana_cost": 3,
        "oracle_any": ["sacrifice a creature", "sacrifice another creature"],
    }, limit=50)
    assert cards
    for card in cards:
        assert set(card["color_identity"]) <= {"B"}
        assert card["cmc"] <= 3


def test_filters_tag_channel(conn):
    cards = search_mtg_database(conn, {"oracle_tags": ["sacrifice-outlet-creature"]}, limit=25)
    assert len(cards) == 25


# --- tag retrieval (the planner's controlled vocabulary) -------------------

def test_tag_search_finds_real_slugs_from_a_concept(conn):
    from app.tags import search_tags

    hits = search_tags(conn, "sacrifice creatures", limit=10)
    slugs = {h["slug"] for h in hits}
    assert slugs
    assert any("sacrifice" in s for s in slugs)
    # Everything returned must exist and have cards behind it.
    assert all(h["card_count"] > 0 for h in hits)


def test_known_slugs_filters_out_invented_tags(conn):
    from app.tags import known_slugs

    result = known_slugs(conn, ["sacrifice-outlet-creature", "totally-made-up-tag"])
    assert result == ["sacrifice-outlet-creature"]


def test_descendant_expansion_grows_selection(conn):
    from app.tags import expand_descendants

    expanded = expand_descendants(conn, ["tutor"])
    assert "tutor" in expanded
    assert len(expanded) > 1  # picks up tutor-creature, tutor-land, ...


def test_empty_filters_match_nothing(conn):
    assert search_mtg_database(conn, {}) == []
