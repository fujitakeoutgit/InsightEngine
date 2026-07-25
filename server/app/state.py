"""Process-wide resources built once at startup.

The name index and the resolver each scan all 38k cards, so they are built on
boot rather than per request.
"""

from __future__ import annotations

import sqlite3

from .db import connect, get_meta, init_db
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
        self.conn = connect()
        init_db(self.conn)
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
