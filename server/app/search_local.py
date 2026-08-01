"""The local search engine over the Scryfall bulk mirror.

`search_mtg_database` is the single function the LLM planner is allowed to
invoke. It takes a validated filter dict and returns real database rows -- the
model never sees a path by which it could author card data itself.
"""

from __future__ import annotations

import sqlite3
from dataclasses import dataclass, field
from typing import Any

from .db import row_to_card
from .query.filters import to_ast
from .query.parser import And, Node, is_empty
from .query.sql import RARITY_ORDER, Compiled, compile_node

# Columns pulled for list views. The detail view re-reads the full row.
LIST_COLUMNS = (
    "oracle_id, scryfall_id, name, mana_cost, cmc, type_line, oracle_text, "
    "power, toughness, loyalty, colors, color_identity, keywords, set_code, "
    "set_name, collector_number, rarity, artist, flavor_text, released_at, edhrec_rank, "
    "reserved, game_changer, digital, games, all_parts, produced_mana, "
    "legalities, prices, usd, "
    "image_small, image_normal, image_art_crop, scryfall_uri, card_faces, layout"
)

SORTS: dict[str, str] = {
    "name": "name COLLATE NOCASE",
    "mv": "cmc",
    "cmc": "cmc",
    "usd": "usd",
    "price": "usd",
    "rarity": RARITY_ORDER,
    "released": "released_at",
    "edhrec": "edhrec_rank",
    "power": "CAST(power AS REAL)",
    "toughness": "CAST(toughness AS REAL)",
    "color": "color_identity",
    "relevance": "edhrec_rank",
}

# NULLs should always sink, whichever direction is requested.
_NULL_LAST = {"usd", "price", "edhrec", "relevance", "power", "toughness"}


@dataclass
class SearchResult:
    cards: list[dict[str, Any]]
    total: int
    page: int
    per_page: int
    warnings: list[str] = field(default_factory=list)

    @property
    def has_more(self) -> bool:
        return self.page * self.per_page < self.total


#: Layouts that are not cards you can put in a deck. Scryfall calls these
#: "extras" and hides them unless a query says `include:extras`; the mirror
#: holds them because rulings and tokens are wanted elsewhere, so the same
#: default has to be applied here or the two engines disagree.
NOT_DECKABLE = ("token", "double_faced_token", "emblem", "art_series", "vanguard")

_NOT_DECKABLE_SQL = ", ".join(f"'{layout}'" for layout in NOT_DECKABLE)


def visibility_clause(
    include_digital: bool, include_funny: bool, include_extras: bool = False,
) -> str:
    """Default result hygiene, matching Scryfall's own search defaults.

    Digital-only cards (Alchemy 'A-' rebalances, Arena exclusives), joke-set
    cards and non-deckable extras are excluded unless explicitly asked for,
    because they otherwise crowd out real answers -- an art-series print shares
    its card's name exactly, so "Delver of Secrets" returned the card and its
    art card as two indistinguishable rows.

    Returns bare SQL with no placeholders: every caller concatenates this onto
    a WHERE clause it has already bound parameters for, so introducing one here
    would silently misalign them. The layout names are a fixed constant, not
    user input.
    """
    parts = []
    if not include_digital:
        parts.append("digital = 0")
    if not include_funny:
        parts.append("is_funny = 0")
    if not include_extras:
        parts.append(f"layout NOT IN ({_NOT_DECKABLE_SQL})")
    return " AND ".join(parts) if parts else "1 = 1"


def deckable_clause() -> str:
    """The layout filter on its own.

    For callers that want every printing a decklist line could legitimately
    mean -- funny and digital cards included, because someone may really be
    building an Un-deck -- but never a token, emblem or art card, which no
    decklist line ever means.
    """
    return f"layout NOT IN ({_NOT_DECKABLE_SQL})"


def constrains_layout(compiled: Compiled) -> bool:
    """Whether the query already says something about `layout`.

    When it does, the extras default is dropped: a query that names a layout
    has answered the question the default exists to answer, and `layout:token`
    should find tokens. This is safe precisely because the constraint does the
    filtering itself -- `is:transform` compiles to `layout = 'transform'`, which
    no art-series or token row can satisfy anyway.
    """
    return "layout" in compiled.where


def _order_clause(sort: str, order: str) -> str:
    column = SORTS.get(sort, SORTS["name"])
    direction = "DESC" if order.lower() == "desc" else "ASC"
    prefix = ""
    if sort in _NULL_LAST:
        # SQLite lacks NULLS LAST before 3.30; this form works everywhere.
        base = column.split(" COLLATE")[0]
        prefix = f"({base} IS NULL), "
    return f"{prefix}{column} {direction}, name COLLATE NOCASE ASC"


def search_ast(
    conn: sqlite3.Connection,
    node: Node,
    *,
    sort: str = "name",
    order: str = "asc",
    page: int = 1,
    per_page: int = 60,
    include_funny: bool = False,
    include_digital: bool = False,
) -> SearchResult:
    """Run a compiled AST against the mirror with pagination."""
    compiled: Compiled = compile_node(node) if not is_empty(node) else Compiled.always_true()
    where = (
        f"({compiled.where}) AND "
        f"{visibility_clause(include_digital, include_funny, constrains_layout(compiled))}"
    )
    params = list(compiled.params)

    total = conn.execute(
        f"SELECT COUNT(*) AS n FROM cards WHERE {where}", params
    ).fetchone()["n"]

    page = max(1, page)
    per_page = max(1, min(per_page, 250))
    rows = conn.execute(
        f"SELECT {LIST_COLUMNS} FROM cards WHERE {where} "
        f"ORDER BY {_order_clause(sort, order)} LIMIT ? OFFSET ?",
        params + [per_page, (page - 1) * per_page],
    ).fetchall()

    return SearchResult([row_to_card(r) for r in rows], total, page, per_page)


def search_node_limited(
    conn: sqlite3.Connection,
    node: Node,
    *,
    limit: int = 400,
    include_funny: bool = False,
    include_digital: bool = False,
) -> list[dict[str, Any]]:
    """Run an AST and return up to `limit` rows, most popular first.

    An empty AST matches *nothing* here (unlike paged search, where an empty
    query means "browse everything"). A plan that compiles to no constraints is
    a broken plan, and must never be treated as "select all".
    """
    compiled = compile_node(node) if not is_empty(node) else Compiled.always_false()
    where = (
        f"({compiled.where}) AND "
        f"{visibility_clause(include_digital, include_funny, constrains_layout(compiled))}"
    )
    rows = conn.execute(
        f"SELECT {LIST_COLUMNS} FROM cards WHERE {where} "
        "ORDER BY (edhrec_rank IS NULL), edhrec_rank ASC, name COLLATE NOCASE ASC "
        "LIMIT ?",
        list(compiled.params) + [limit],
    ).fetchall()
    return [row_to_card(r) for r in rows]


def search_mtg_database(
    conn: sqlite3.Connection,
    filters: dict[str, Any],
    *,
    limit: int = 400,
    extra: Node | None = None,
) -> list[dict[str, Any]]:
    """Execute one structured filter set. This is the LLM planner's only tool.

    Deterministic, exhaustive within the filter, and it returns whole database
    records. `extra` ANDs in the structured half of a mixed query such as
    ``q:"..." c:black mv<=3`` so the intersection happens in SQL.
    """
    node = to_ast(filters)
    if extra is not None and not is_empty(extra):
        node = And([node, extra])
    return search_node_limited(conn, node, limit=limit)


def count_matches(conn: sqlite3.Connection, filters: dict[str, Any]) -> int:
    """Row count for a filter set, used to detect plans that are too broad."""
    node = to_ast(filters)
    compiled = compile_node(node) if not is_empty(node) else Compiled.always_false()
    return conn.execute(
        f"SELECT COUNT(*) AS n FROM cards WHERE {compiled.where}", list(compiled.params)
    ).fetchone()["n"]


def cards_by_oracle_ids(
    conn: sqlite3.Connection, oracle_ids: list[str]
) -> dict[str, dict[str, Any]]:
    """Rehydrate canonical records for a set of ids.

    The grounding step returns ids only; this is where they become card data.
    Any id the model invented simply finds no row and disappears.
    """
    if not oracle_ids:
        return {}
    out: dict[str, dict[str, Any]] = {}
    for chunk_start in range(0, len(oracle_ids), 500):
        chunk = oracle_ids[chunk_start:chunk_start + 500]
        placeholders = ",".join("?" * len(chunk))
        rows = conn.execute(
            f"SELECT {LIST_COLUMNS} FROM cards WHERE oracle_id IN ({placeholders})",
            tuple(chunk),
        ).fetchall()
        for row in rows:
            out[row["oracle_id"]] = row_to_card(row)
    return out


def get_card(conn: sqlite3.Connection, oracle_id: str) -> dict[str, Any] | None:
    row = conn.execute(
        "SELECT * FROM cards WHERE oracle_id = ?", (oracle_id,)
    ).fetchone()
    return row_to_card(row) if row else None


def get_rulings(conn: sqlite3.Connection, oracle_id: str) -> list[dict[str, Any]]:
    rows = conn.execute(
        "SELECT published_at, comment, source FROM rulings WHERE oracle_id = ? "
        "ORDER BY published_at",
        (oracle_id,),
    ).fetchall()
    return [dict(r) for r in rows]


def list_sets(conn: sqlite3.Connection) -> list[dict[str, Any]]:
    rows = conn.execute(
        "SELECT code, name, set_type, released_at, card_count, digital, "
        "icon_svg_uri, parent_code FROM sets ORDER BY released_at DESC"
    ).fetchall()
    return [dict(r) for r in rows]
