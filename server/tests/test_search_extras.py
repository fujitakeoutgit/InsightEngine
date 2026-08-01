"""Non-deckable layouts stay out of search results.

Scryfall calls tokens, emblems, art series and vanguards "extras" and hides
them unless a query says `include:extras`. The mirror holds them, so without
the same default the two engines disagree -- the local engine answering a
question the proxied one would not.

The art-series rows that prompted this were in fact already excluded, because
every one of them carries `is_funny = 1`. The leak was the thousand-odd tokens,
emblems and vanguards that do not.
"""

from __future__ import annotations

import pytest

from app.db import connect
from app.query.parser import parse
from app.query.sql import compile_node
from app.search_local import NOT_DECKABLE, constrains_layout, search_ast, visibility_clause


@pytest.fixture(scope="module")
def conn():
    c = connect()
    yield c
    c.close()


def run(conn, query, **kw):
    return search_ast(conn, parse(query), **kw)


def test_the_excluded_layouts_are_really_present(conn):
    """Guards the list against a typo silently excluding nothing."""
    placeholders = ",".join("?" * len(NOT_DECKABLE))
    row = conn.execute(
        f"SELECT COUNT(*) n FROM cards WHERE layout IN ({placeholders})", NOT_DECKABLE
    ).fetchone()
    assert row["n"] > 0, "nothing matched — the layout names are wrong"


def test_extras_are_absent_from_an_ordinary_search(conn):
    """The regression: emblems and tokens ranked alongside real cards."""
    result = run(conn, "t:emblem", per_page=175)
    assert result.total == 0

    result = run(conn, "emblem", per_page=175)
    assert all(c["layout"] not in NOT_DECKABLE for c in result.cards)


def test_a_token_name_no_longer_returns_the_token(conn):
    """"Cat" is eight separate token rows; none of them is a card."""
    result = run(conn, "Cat", per_page=175)
    assert result.total > 0
    assert all(c["layout"] not in NOT_DECKABLE for c in result.cards)


def test_naming_a_layout_reaches_the_extras(conn):
    """The escape hatch: a query that constrains layout drops the default.

    Art series are also `is:funny`, so getting at them takes both switches --
    which is the honest answer to "show me the art cards".
    """
    result = run(conn, "layout:art_series", include_funny=True, per_page=10)
    assert result.total > 0
    assert all(c["layout"] == "art_series" for c in result.cards)

    result = run(conn, "layout:emblem", per_page=10)
    assert result.total > 0


def test_layout_detection_is_driven_by_the_compiled_sql(conn):
    """`is:` predicates that compile to a layout comparison count too.

    They are safe to let through: the comparison itself excludes every extra,
    so dropping the default changes nothing for them.
    """
    assert constrains_layout(compile_node(parse("layout:token")))
    assert constrains_layout(compile_node(parse("is:transform")))
    assert not constrains_layout(compile_node(parse("c:red t:creature")))

    result = run(conn, "is:transform", per_page=50)
    assert result.total > 0
    assert all(c["layout"] == "transform" for c in result.cards)


def test_clause_carries_no_placeholders():
    """Callers concatenate this onto a WHERE they have already bound."""
    assert "?" not in visibility_clause(False, False)
    assert "?" not in visibility_clause(True, True, True)
