"""Process-wide resources built once at startup.

The name index and the resolver each scan all 38k cards, so they are built on
boot rather than per request.
"""

from __future__ import annotations

import sqlite3

from .db import attach_mirror, connect, detach_mirror, get_meta, init_db, split_if_needed
from .deck.resolver import CardNameResolver
from .deck.storage import backfill_commanders
from .spell import SpellChecker


class AppState:
    def __init__(self) -> None:
        self.conn: sqlite3.Connection | None = None
        self.resolver: CardNameResolver | None = None
        self.spell: SpellChecker | None = None
        self.card_count: int = 0
        self.paper_count: int = 0
        self.built_at: str | None = None

    def start(self) -> None:
        # One-time, and a no-op on every start after it: moves an existing
        # single-file database into the user/mirror pair. See db.split_if_needed.
        split_if_needed()
        self.conn = connect()
        init_db(self.conn)

    def detach_for_swap(self) -> None:
        """Let go of the mirror file so it can be replaced.

        Windows will not rename over an open handle, so the attachment has to
        be dropped first. Between this and `reattach_after_swap` the app has
        its decks and no cards, which is why the pair brackets a file rename
        and not a download.
        """
        if self.conn is not None:
            detach_mirror(self.conn)

    def reattach_after_swap(self) -> None:
        if self.conn is not None:
            attach_mirror(self.conn)
        row = self.conn.execute(
            "SELECT COUNT(*) AS n, SUM(digital = 0) AS paper FROM cards"
        ).fetchone()
        self.card_count = row["n"] if row else 0
        self.paper_count = (row["paper"] or 0) if row else 0
        self.built_at = get_meta(self.conn, "built_at")
        if self.card_count:
            self.resolver = CardNameResolver(self.conn)
            self.spell = SpellChecker(self.conn)
            # Decks saved before commander art existed would show blank tiles.
            backfill_commanders(self.conn)

    def close(self) -> None:
        if self.conn:
            self.conn.close()
            self.conn = None

    @property
    def ready(self) -> bool:
        return self.card_count > 0

    def require_conn(self) -> sqlite3.Connection:
        if self.conn is None:
            raise RuntimeError("database not initialised")
        return self.conn


state = AppState()
