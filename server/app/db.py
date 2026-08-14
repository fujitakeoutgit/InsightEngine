"""SQLite storage for the local Scryfall bulk mirror.

Why a local mirror at all: the public API is paginated and rate limited, so an
*exhaustive* sweep of the corpus (a hard requirement for the `q:` pipeline)
cannot be done politely over HTTP. Scryfall publish daily bulk files precisely
for this use case. Live API calls are still used for prices, printings and
rulings freshness -- see `scryfall.py`.
"""

from __future__ import annotations

import json
import os
import re
import sqlite3
import unicodedata
from pathlib import Path
from typing import Any, Iterable

from .config import settings

# Bump when the `cards`/`tags`/`rulings` layout changes. The mirror is derived
# data, so a bump drops and rebuilds those tables from the cached bulk files
# rather than attempting an ALTER migration. `http_cache` is preserved.
SCHEMA_VERSION = "5"

DERIVED_TABLES = ("cards", "cards_fts", "tags", "tags_fts", "tag_cards", "rulings", "sets")

SCHEMA_MIRROR = """
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
    flavor_text      TEXT,
    edhrec_rank      INTEGER,
    penny_rank       INTEGER,
    reserved         INTEGER DEFAULT 0,
    game_changer     INTEGER DEFAULT 0,
    is_funny         INTEGER DEFAULT 0,
    games            TEXT,
    all_parts        TEXT,
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
"""

# The user's own tables. Small, irreplaceable, and never dropped by a schema
# bump or a card refresh -- which is the whole reason they live in a separate
# file now. See `connect`.
SCHEMA_USER = """
PRAGMA journal_mode = WAL;
PRAGMA synchronous  = NORMAL;

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

-- Saved decks. User data, not derived from the mirror, so it is deliberately
-- absent from DERIVED_TABLES and survives every schema rebuild.
CREATE TABLE IF NOT EXISTS decks (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    text       TEXT NOT NULL,
    commander  TEXT,
    format     TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_decks_updated ON decks(updated_at DESC);

-- Individual printings, fetched from Scryfall the first time one is chosen and
-- kept from then on.
--
-- The mirror is built from Scryfall's oracle_cards file, which holds one row
-- per *oracle* card and therefore knows nothing about alternate printings. So
-- a chosen printing had nowhere to live: the decklist text kept "(SET) 123",
-- but on reload the resolver matched by name, found the single oracle row, and
-- handed that back -- discarding the choice.
--
-- Deliberately in the USER database rather than the mirror. Rebuilding card
-- data replaces the mirror wholesale, and a printing you picked is your data,
-- not a derived copy of Scryfall's.
CREATE TABLE IF NOT EXISTS printings (
    scryfall_id      TEXT PRIMARY KEY,
    oracle_id        TEXT NOT NULL,
    name             TEXT NOT NULL,
    set_code         TEXT NOT NULL,
    set_name         TEXT,
    collector_number TEXT NOT NULL,
    image_small      TEXT,
    image_normal     TEXT,
    usd              REAL,
    artist           TEXT,
    released_at      TEXT,
    fetched_at       REAL NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_printings_lookup
    ON printings(set_code, collector_number);
CREATE INDEX IF NOT EXISTS idx_printings_oracle ON printings(oracle_id);

-- What is in the binder, as oracle ids, so `binder:true` is a join rather than
-- a decklist parsed per search.
--
-- Derived from the binder deck's text and rebuilt whenever that deck is saved.
-- It is a cache of user data rather than of the mirror, which is why it lives
-- here and not there -- but unlike `decks` it can always be regenerated, so
-- losing it costs nothing.
CREATE TABLE IF NOT EXISTS binder_cards (
    oracle_id TEXT PRIMARY KEY
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


#: The attached card mirror. Unqualified table names resolve against `main`
#: first and then attachments, so every existing query that says `cards` finds
#: `mirror.cards` without being rewritten.
MIRROR = "mirror"


def _open(target: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(target, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    # Powers the `_` wildcard operator, which has no SQL LIKE equivalent.
    conn.create_function("REGEXP", 2, _regexp, deterministic=True)
    return conn


def connect_mirror(path: Path | None = None) -> sqlite3.Connection:
    """Open a mirror file on its own, as `main`.

    Used by the builder, and it is why the split costs so little: a mirror
    under construction is an ordinary database whose derived tables are
    unqualified, so every line of ingest SQL works exactly as it did when there
    was only one file.
    """
    conn = _open(path or settings.mirror_path)
    conn.executescript(SCHEMA_MIRROR)
    conn.commit()
    return conn


def connect_user(path: Path | None = None) -> sqlite3.Connection:
    """Open the user database *without* the mirror.

    For callers that only touch user tables — the Scryfall HTTP cache is the
    one that matters. Attaching the mirror to a connection that never reads a
    card is not merely wasteful: every attachment is a handle on the file, and
    the refresh has to replace that file. One long-lived connection holding the
    mirror for no reason is enough to make the swap fail with "the process
    cannot access the file because it is being used by another process".
    """
    return _open(path or settings.db_path)


def connect(path: Path | None = None) -> sqlite3.Connection:
    """Open the user database, with the card mirror attached.

    Two files, because they have nothing in common but a disk. The user's decks
    are small, irreplaceable and edited by hand; the mirror is large, entirely
    derived from Scryfall, and replaced wholesale every time the cards are
    refreshed. Keeping them together meant a refresh had to operate *inside*
    the database holding the only data the user had actually made — and since
    ingest truncates `cards` and refills it in place, a download that died
    halfway left the app with no cards at all.

    Split, a refresh is a file swap: build a new mirror beside the old one, and
    replace it only once it is complete. Failure means deleting a file.
    """
    target = path or settings.db_path
    conn = _open(target)
    attach_mirror(conn)
    return conn


def attach_mirror(conn: sqlite3.Connection, path: Path | None = None) -> None:
    """Attach the mirror, creating an empty one if there is none yet.

    An empty mirror is a working app with no cards in it, which is a far better
    starting state than a failure: the deck editor, the playtester and every
    saved deck still open, and Settings says the card data needs building.
    """
    mirror = path or settings.mirror_path
    mirror.parent.mkdir(parents=True, exist_ok=True)
    if not mirror.exists():
        connect_mirror(mirror).close()
    conn.execute(f"ATTACH DATABASE ? AS {MIRROR}", (str(mirror),))


def detach_mirror(conn: sqlite3.Connection) -> None:
    try:
        conn.execute(f"DETACH DATABASE {MIRROR}")
    except sqlite3.Error:
        pass


def init_mirror(conn: sqlite3.Connection) -> None:
    """Bring a standalone mirror up to the current derived schema.

    Rebuilding is always the right answer here: every table is derived from a
    bulk file that is either cached on disk or a download away, so a schema
    bump costs an ingest rather than any data.
    """
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

    conn.executescript(SCHEMA_MIRROR)
    set_meta(conn, "schema_version", SCHEMA_VERSION)
    conn.commit()


def init_db(conn: sqlite3.Connection) -> None:
    """Create the user schema and migrate it. Never drops a user table.

    The mirror is not touched from here: it is a separate file with its own
    lifecycle, brought up to date by the builder.
    """
    conn.executescript(SCHEMA_USER)

    # User tables are migrated, never rebuilt: dropping `decks` would throw
    # away the only data in this database the user actually created.
    _add_column_if_missing(conn, "decks", "commander_oracle_id", "TEXT")
    _add_column_if_missing(conn, "decks", "description", "TEXT")
    conn.commit()


def _add_column_if_missing(
    conn: sqlite3.Connection, table: str, column: str, ddl: str
) -> None:
    existing = {row["name"] for row in conn.execute(f"PRAGMA table_info({table})")}
    if column not in existing:
        conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {ddl}")


def get_meta(conn: sqlite3.Connection, key: str) -> str | None:
    row = conn.execute("SELECT value FROM meta WHERE key = ?", (key,)).fetchone()
    return row["value"] if row else None


def get_mirror_meta(conn: sqlite3.Connection, key: str) -> str | None:
    """Read the *mirror's* own meta through an app connection.

    `meta` unqualified resolves to `main`, which after the split is the user
    database. The mirror carries its own provenance — which bulk files were
    ingested, and when it was built — and that has to travel with the file it
    describes, or a swapped-in mirror would inherit the last one's history.
    """
    try:
        row = conn.execute(f"SELECT value FROM {MIRROR}.meta WHERE key = ?", (key,)).fetchone()
    except sqlite3.Error:
        return None
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


def _probe(path: Path) -> tuple[bool, bool]:
    """(has a `cards` table, has any cards in it).

    Two different questions that must not share an answer. "Does this file hold
    the mirror's schema" decides whether a file is the old combined layout;
    "does it actually contain cards" decides whether a mirror is real or an
    empty placeholder. Conflating them meant the placeholder that
    `attach_mirror` writes on a fresh start looked exactly like a finished
    mirror, and the migration politely declined to run.

    Opened and closed explicitly. `with sqlite3.connect(...)` manages the
    transaction and leaves the connection *open*, which on Windows keeps the
    file and its WAL locked against a rename.
    """
    conn = _open(path)
    try:
        table = conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='cards'"
        ).fetchone() is not None
        rows = bool(conn.execute("SELECT 1 FROM cards LIMIT 1").fetchone()) if table else False
        return table, rows
    except sqlite3.Error:
        return False, False
    finally:
        conn.close()


def split_if_needed() -> bool:
    """Move an existing single-file database into the two-file layout.

    Done by *renaming* rather than copying. The old file already holds the
    mirror — 220MB of it — and the user's decks are a few kilobytes, so the
    cheap direction is to let the old file become the mirror and lift the small
    half out of it. A copy would move a quarter of a gigabyte to achieve the
    same thing; the rename takes a fraction of a second.

    Ordered so that every interruption leaves something recoverable:

    1. rename the old file to the mirror's name — instant, and afterwards the
       decks are still inside it;
    2. create the user database and copy the decks and preferences across;
    3. only then drop the originals from the mirror.

    Dying between 1 and 3 leaves the decks in the mirror, where step 2 finds
    them again on the next start. Returns whether it did anything.
    """
    user_path = settings.db_path
    mirror_path = settings.mirror_path

    if not user_path.exists() or not _probe(user_path)[0]:
        # Already split, or a fresh install with nothing to move.
        return False

    if mirror_path.exists():
        if _probe(mirror_path)[1]:
            # Two files both claiming to be the mirror. Guessing which is meant
            # could throw away a real one, so do nothing and leave them be.
            return False
        # An empty placeholder — `attach_mirror` writes one whenever it finds
        # no mirror at all. It must not be allowed to stand in for the real
        # mirror still sitting inside the user file, or the app comes up with
        # every deck intact and no cards.
        #
        # Failing to remove it is not fatal. Another instance of the app, or a
        # virus scanner, can hold the handle; the right answer is then to leave
        # the layout alone and come up on the combined database exactly as
        # before, rather than to refuse to start at all.
        try:
            for suffix in ("", "-wal", "-shm"):
                stray = mirror_path.with_name(mirror_path.name + suffix)
                if stray.exists():
                    stray.unlink()
        except OSError:
            return False

    # WAL sidecars belong to the file they were written for, so the log is
    # folded back in and they are removed rather than left to be adopted by
    # whatever takes this filename next.
    try:
        conn = _open(user_path)
        try:
            conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        finally:
            conn.close()
        for suffix in ("-wal", "-shm"):
            side = user_path.with_name(user_path.name + suffix)
            if side.exists():
                side.unlink()
        os.replace(user_path, mirror_path)
    except OSError:
        # Same reasoning: an unmovable file means "not today", not "do not
        # start". The combined database still works.
        return False

    # Lift the user's half out of whatever now holds it.
    moved = False
    user = _open(user_path)
    try:
        user.executescript(SCHEMA_USER)
        init_db(user)
        user.execute("ATTACH DATABASE ? AS old", (str(mirror_path),))
        old_has_decks = user.execute(
            "SELECT name FROM old.sqlite_master WHERE type='table' AND name='decks'"
        ).fetchone()
        if old_has_decks:
            here = user.execute("SELECT COUNT(*) AS n FROM main.decks").fetchone()["n"]
            if here == 0:
                cols = [r["name"] for r in user.execute("PRAGMA old.table_info(decks)")]
                shared = [c for c in cols if c != "id"]
                names = ", ".join(shared)
                user.execute(
                    f"INSERT INTO main.decks (id, {names}) SELECT id, {names} FROM old.decks"
                )
            # User preferences live in meta; the mirror's own meta is its
            # provenance and stays where it is.
            for key in ("model_tier", "seeded", "sync:checked_at"):
                row = user.execute("SELECT value FROM old.meta WHERE key = ?", (key,)).fetchone()
                if row:
                    user.execute(
                        "INSERT INTO main.meta(key, value) VALUES(?, ?) "
                        "ON CONFLICT(key) DO NOTHING",
                        (key, row["value"]),
                    )
            user.commit()
            user.execute("DROP TABLE old.decks")
            user.execute("DROP TABLE IF EXISTS old.http_cache")
            user.commit()
            moved = True
        user.execute("DETACH DATABASE old")
    finally:
        user.close()
    return moved
