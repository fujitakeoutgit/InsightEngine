"""SQLite storage for the local Scryfall bulk mirror.

Why a local mirror at all: the public API is paginated and rate limited, so an
*exhaustive* sweep of the corpus (a hard requirement for the `q:` pipeline)
cannot be done politely over HTTP. Scryfall publish daily bulk files precisely
for this use case. Live API calls are still used for prices, printings and
rulings freshness -- see `scryfall.py`.
"""

from __future__ import annotations

import json
import re
import sqlite3
import unicodedata
from pathlib import Path
from typing import Any, Iterable

from .config import settings

# Bump when the `cards`/`tags`/`rulings` layout changes. The mirror is derived
# data, so a bump drops and rebuilds those tables from the cached bulk files
# rather than attempting an ALTER migration. `http_cache` is preserved.
SCHEMA_VERSION = "3"

DERIVED_TABLES = ("cards", "cards_fts", "tags", "tags_fts", "tag_cards", "rulings", "sets")

SCHEMA = """
PRAGMA journal_mode = WAL;
PRAGMA synchronous  = NORMAL;

CREATE TABLE IF NOT EXISTS cards (
    oracle_id        TEXT PRIMARY KEY,
    scryfall_id      TEXT,
    name             TEXT NOT NULL,
    name_norm        TEXT NOT NULL,
    name_fold        TEXT NOT NULL,
    released_at      TEXT,
    layout           TEXT,
    mana_cost        TEXT,
    cmc              REAL,
    type_line        TEXT,
    oracle_text      TEXT,
    oracle_all       TEXT,
    power            TEXT,
    toughness        TEXT,
    loyalty          TEXT,
    defense          TEXT,
    colors           TEXT,
    color_identity   TEXT,
    color_count      INTEGER,
    keywords         TEXT,
    produced_mana    TEXT,
    set_code         TEXT,
    set_name         TEXT,
    collector_number TEXT,
    rarity           TEXT,
    artist           TEXT,
    edhrec_rank      INTEGER,
    penny_rank       INTEGER,
    reserved         INTEGER DEFAULT 0,
    game_changer     INTEGER DEFAULT 0,
    is_funny         INTEGER DEFAULT 0,
    games            TEXT,
    digital          INTEGER DEFAULT 0,
    legalities       TEXT,
    prices           TEXT,
    usd              REAL,
    image_small      TEXT,
    image_normal     TEXT,
    image_art_crop   TEXT,
    scryfall_uri     TEXT,
    card_faces       TEXT
);

CREATE INDEX IF NOT EXISTS idx_cards_name_fold  ON cards(name_fold);
CREATE INDEX IF NOT EXISTS idx_cards_cmc        ON cards(cmc);
CREATE INDEX IF NOT EXISTS idx_cards_set        ON cards(set_code);
CREATE INDEX IF NOT EXISTS idx_cards_rarity     ON cards(rarity);
CREATE INDEX IF NOT EXISTS idx_cards_edhrec     ON cards(edhrec_rank);
CREATE INDEX IF NOT EXISTS idx_cards_ci         ON cards(color_identity);
CREATE INDEX IF NOT EXISTS idx_cards_digital    ON cards(digital);

CREATE VIRTUAL TABLE IF NOT EXISTS cards_fts USING fts5(
    name, type_line, oracle_all,
    content='cards', content_rowid='rowid',
    tokenize='unicode61 remove_diacritics 2'
);

CREATE TABLE IF NOT EXISTS tags (
    slug        TEXT PRIMARY KEY,
    tag_id      TEXT,
    label       TEXT,
    description TEXT,
    aliases     TEXT,
    parent_ids  TEXT,
    child_ids   TEXT,
    card_count  INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS tag_cards (
    slug      TEXT NOT NULL,
    oracle_id TEXT NOT NULL,
    PRIMARY KEY (slug, oracle_id)
);
CREATE INDEX IF NOT EXISTS idx_tag_cards_oracle ON tag_cards(oracle_id);

CREATE VIRTUAL TABLE IF NOT EXISTS tags_fts USING fts5(
    slug, label, description, aliases,
    tokenize='unicode61 remove_diacritics 2'
);

CREATE TABLE IF NOT EXISTS rulings (
    oracle_id    TEXT NOT NULL,
    published_at TEXT,
    comment      TEXT,
    source       TEXT
);
CREATE INDEX IF NOT EXISTS idx_rulings_oracle ON rulings(oracle_id);

CREATE TABLE IF NOT EXISTS sets (
    code         TEXT PRIMARY KEY,
    name         TEXT,
    set_type     TEXT,
    released_at  TEXT,
    card_count   INTEGER,
    digital      INTEGER,
    icon_svg_uri TEXT,
    parent_code  TEXT
);

CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT
);

-- Persistent HTTP cache for proxied Scryfall responses.
CREATE TABLE IF NOT EXISTS http_cache (
    key        TEXT PRIMARY KEY,
    body       BLOB,
    fetched_at REAL
);
"""

_PUNCT = re.compile(r"[^a-z0-9]+")


def fold_name(value: str) -> str:
    """Aggressively normalise a card name for fuzzy matching.

    Strips diacritics, case and every non-alphanumeric character, so that
    ``Fire // Ice``, ``fire/ice``, ``Fire Ice`` and ``fireice`` all collapse to
    the same key. This is what makes near-miss decklist entries resolvable.
    """
    decomposed = unicodedata.normalize("NFKD", value)
    ascii_only = "".join(c for c in decomposed if not unicodedata.combining(c))
    return _PUNCT.sub("", ascii_only.lower())


def normalize_name(value: str) -> str:
    """Lighter normalisation that preserves word boundaries."""
    decomposed = unicodedata.normalize("NFKD", value)
    ascii_only = "".join(c for c in decomposed if not unicodedata.combining(c))
    return _PUNCT.sub(" ", ascii_only.lower()).strip()


def _regexp(pattern: str, value: str | None) -> bool:
    if value is None:
        return False
    return re.search(pattern, value, re.IGNORECASE | re.DOTALL) is not None


def connect(path: Path | None = None) -> sqlite3.Connection:
    """Open a connection with the app's custom functions registered."""
    target = path or settings.db_path
    conn = sqlite3.connect(target, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    # Powers the `_` wildcard operator, which has no SQL LIKE equivalent.
    conn.create_function("REGEXP", 2, _regexp, deterministic=True)
    return conn


def init_db(conn: sqlite3.Connection) -> None:
    """Create the schema, rebuilding derived tables if the version moved on."""
    conn.execute("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)")
    conn.commit()

    existing = conn.execute(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'cards'"
    ).fetchone()
    # A database predating the version key counts as stale, not as fresh.
    current = get_meta(conn, "schema_version") or ("0" if existing else SCHEMA_VERSION)

    if current != SCHEMA_VERSION:
        for table in DERIVED_TABLES:
            conn.execute(f"DROP TABLE IF EXISTS {table}")
        # Force re-ingest of every bulk file; the cached downloads are reused.
        for row in conn.execute(
            "SELECT key FROM meta WHERE key LIKE 'ingest:%'"
        ).fetchall():
            conn.execute("DELETE FROM meta WHERE key = ?", (row["key"],))
        conn.commit()

    conn.executescript(SCHEMA)
    set_meta(conn, "schema_version", SCHEMA_VERSION)
    conn.commit()


def get_meta(conn: sqlite3.Connection, key: str) -> str | None:
    row = conn.execute("SELECT value FROM meta WHERE key = ?", (key,)).fetchone()
    return row["value"] if row else None


def set_meta(conn: sqlite3.Connection, key: str, value: str) -> None:
    conn.execute(
        "INSERT INTO meta(key, value) VALUES(?, ?) "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (key, value),
    )
    conn.commit()


def row_to_card(row: sqlite3.Row) -> dict[str, Any]:
    """Inflate a DB row into the canonical card dict served to clients.

    This is the *only* path by which card data reaches a response. The LLM
    never writes card fields; it only ever selects oracle_ids that are then
    rehydrated here.
    """
    card = dict(row)
    for json_field in ("keywords", "legalities", "prices", "card_faces",
                       "produced_mana", "games"):
        raw = card.get(json_field)
        card[json_field] = json.loads(raw) if raw else None
    card["reserved"] = bool(card.get("reserved"))
    card["game_changer"] = bool(card.get("game_changer"))
    card.pop("name_fold", None)
    card.pop("name_norm", None)
    card.pop("oracle_all", None)
    return card


def chunked(iterable: Iterable[Any], size: int) -> Iterable[list[Any]]:
    batch: list[Any] = []
    for item in iterable:
        batch.append(item)
        if len(batch) >= size:
            yield batch
            batch = []
    if batch:
        yield batch
