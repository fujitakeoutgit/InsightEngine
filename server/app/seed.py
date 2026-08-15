"""What a freshly installed database comes with.

An empty Deck Lab is a worse first impression than it sounds: every feature
worth showing -- the curve, the mana analysis, recommendations, the
playtester -- needs a deck before it does anything, so a new install opens on
six empty panels and a "paste a decklist" prompt. Seeding one real deck means
the app demonstrates itself.

Seeded once and never again. The marker lives in `meta` rather than being
inferred from "are there no decks", because deleting the sample is a decision,
and a tool that keeps putting it back has not understood that.
"""

from __future__ import annotations

import sqlite3
from pathlib import Path

from .db import get_meta, set_meta

SEED_KEY = "seed:decks"
SEED_DIR = Path(__file__).resolve().parent / "seed"

#: Name, format, decklist file, and how the deck works.
#:
#: The description is not decoration. It is what **AI recommend** reads as part
#: of its prompt, so a seeded deck without one demonstrates the feature at its
#: worst -- and it is the one deck a new install opens.
SEED_DECKS = (
    (
        "Minsc",
        "commander",
        "minsc.txt",
        "Aristocrat, value in things entering and leaving the graveyard. "
        "Token gen for sacrifice.",
    ),
)


def _mirror_ready(conn: sqlite3.Connection) -> bool:
    """Whether there are cards to resolve names against."""
    try:
        return bool(conn.execute("SELECT 1 FROM cards LIMIT 1").fetchone())
    except sqlite3.Error:
        return False


def seed_decks(conn: sqlite3.Connection) -> int:
    """Install the sample deck(s) on a database that has never had them.

    Returns how many were added. Safe to call on every startup: it is a single
    `meta` read once the work has been done.
    """
    if get_meta(conn, SEED_KEY):
        return 0

    # Not before the mirror exists.
    #
    # `storage.save` works out the commander by resolving names against the
    # cards table, and on a fresh install the server starts before the bulk
    # ingest has run. Seeding then would store the deck with no commander and
    # no art -- permanently, since it is only detected on save. Deferring to
    # the first start after ingest costs nothing and gets it right.
    if not _mirror_ready(conn):
        return 0

    # Imported here rather than at module scope: storage pulls in the deck
    # parser and resolver, and seeding must not be on the import path of
    # anything that merely wants to open the database.
    from .deck import storage

    added = 0
    for name, fmt, filename, description in SEED_DECKS:
        path = SEED_DIR / filename
        if not path.exists():
            continue
        # A deck the user already made with this name is theirs, not ours.
        clash = conn.execute("SELECT 1 FROM decks WHERE name = ?", (name,)).fetchone()
        if clash:
            continue
        storage.save(
            conn,
            name,
            path.read_text(encoding="utf-8"),
            format_key=fmt,
            description=description,
        )
        added += 1

    set_meta(conn, SEED_KEY, "done")
    return added
