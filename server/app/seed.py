"""What a freshly installed database comes with.

An empty Deck Lab is a worse first impression than it sounds: every feature
worth showing -- the curve, the mana analysis, recommendations, the
playtester -- needs a deck before it does anything, so a new install opens on
six empty panels and a "paste a decklist" prompt. Seeding one real deck means
the app demonstrates itself.

Each deck is seeded once and never again. The marker lives in `meta` rather
than being inferred from "are there no decks", because deleting the sample is a
decision, and a tool that keeps putting it back has not understood that.

Per deck, because the set grows. One flag for the whole operation meant a deck
added here later could only ever reach a machine installing for the first time;
everyone already running had the flag set and skipped the loop entirely.
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
        "Aristocrat",
        "commander",
        "aristocrat.txt",
        "Aristocrat, value in things entering and leaving the graveyard. "
        "Token gen for sacrifice.",
    ),
    (
        "Land & Draw",
        "commander",
        "land-and-draw.txt",
        "Land and draw focused.",
    ),
)


def _marker(name: str) -> str:
    """The meta key recording that one seed deck has had its turn."""
    return f"seed:deck:{name}"


def _carry_forward_legacy_marker(conn: sqlite3.Connection) -> None:
    """Treat the old single flag as "the decks of that era were seeded".

    Without this, moving to per-deck markers would offer every existing
    install the original sample again -- including the installs that deleted
    it, which is exactly what the flag existed to prevent.

    "Minsc" is that original sample. It is no longer in SEED_DECKS -- it was
    reworked and renamed to Aristocrat -- so this marker now only protects a
    deck nobody is offering. It stays because the protection is about what an
    install already refused, not about what the list currently holds, and
    re-adding the name later must not quietly undo someone's deletion.

    The rename does mean an existing install is offered Aristocrat as a new
    deck, since that name has never been seeded there. That is the intended
    behaviour for a new sample; the Minsc deck someone already has is theirs
    and is left alone.
    """
    if not get_meta(conn, SEED_KEY):
        return
    # Only the decks that existed when the flag was the whole mechanism.
    if not get_meta(conn, _marker("Minsc")):
        set_meta(conn, _marker("Minsc"), "legacy")


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

    _carry_forward_legacy_marker(conn)

    added = 0
    for name, fmt, filename, description in SEED_DECKS:
        # Marked per deck, not once for the set.
        #
        # A single "seeding is done" flag meant a deck added to this list later
        # could only ever reach a fresh install: every machine already running
        # had the flag set and skipped the whole loop. Recording each deck by
        # name lets a new one arrive on an existing install while keeping the
        # promise the old flag was making -- that a deck you deleted stays
        # deleted, because its own marker is still there.
        if get_meta(conn, _marker(name)):
            continue
        path = SEED_DIR / filename
        if not path.exists():
            continue
        # A deck the user already made with this name is theirs, not ours.
        clash = conn.execute("SELECT 1 FROM decks WHERE name = ?", (name,)).fetchone()
        if clash:
            # Marked anyway: the name is taken, and asking again on every
            # startup will not change that.
            set_meta(conn, _marker(name), "clash")
            continue
        storage.save(
            conn,
            name,
            path.read_text(encoding="utf-8"),
            format_key=fmt,
            description=description,
        )
        set_meta(conn, _marker(name), "done")
        added += 1

    set_meta(conn, SEED_KEY, "done")
    return added
