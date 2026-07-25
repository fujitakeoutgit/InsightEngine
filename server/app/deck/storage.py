"""Saved decks.

Stored server-side rather than in localStorage so a deck survives clearing
browser data, and so the same list is visible from any browser pointed at this
machine. The table is user data and is excluded from the derived-table rebuild
in `db.init_db`.
"""

from __future__ import annotations

import sqlite3
import time
from typing import Any

MAX_DECK_BYTES = 200_000


class DeckError(ValueError):
    pass


def _now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _row(row: sqlite3.Row, *, with_text: bool = True) -> dict[str, Any]:
    deck = {
        "id": row["id"],
        "name": row["name"],
        "commander": row["commander"],
        "format": row["format"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }
    if with_text:
        deck["text"] = row["text"]
    else:
        # Enough for a list row without shipping every decklist.
        deck["lines"] = len([ln for ln in (row["text"] or "").splitlines() if ln.strip()])
    return deck


def save(
    conn: sqlite3.Connection,
    name: str,
    text: str,
    *,
    deck_id: int | None = None,
    commander: str | None = None,
    format_key: str | None = None,
) -> dict[str, Any]:
    name = (name or "").strip() or "Untitled deck"
    if len(text.encode("utf-8")) > MAX_DECK_BYTES:
        raise DeckError("Decklist is too large to save.")

    now = _now()
    if deck_id is not None:
        cursor = conn.execute(
            "UPDATE decks SET name = ?, text = ?, commander = ?, format = ?, "
            "updated_at = ? WHERE id = ?",
            (name, text, commander, format_key, now, deck_id),
        )
        if cursor.rowcount == 0:
            raise DeckError(f"No saved deck with id {deck_id}.")
    else:
        cursor = conn.execute(
            "INSERT INTO decks(name, text, commander, format, created_at, updated_at) "
            "VALUES(?,?,?,?,?,?)",
            (name, text, commander, format_key, now, now),
        )
        deck_id = cursor.lastrowid
    conn.commit()

    row = conn.execute("SELECT * FROM decks WHERE id = ?", (deck_id,)).fetchone()
    return _row(row)


def listing(conn: sqlite3.Connection) -> list[dict[str, Any]]:
    rows = conn.execute("SELECT * FROM decks ORDER BY updated_at DESC").fetchall()
    return [_row(r, with_text=False) for r in rows]


def load(conn: sqlite3.Connection, deck_id: int) -> dict[str, Any]:
    row = conn.execute("SELECT * FROM decks WHERE id = ?", (deck_id,)).fetchone()
    if row is None:
        raise DeckError(f"No saved deck with id {deck_id}.")
    return _row(row)


def delete(conn: sqlite3.Connection, deck_id: int) -> None:
    cursor = conn.execute("DELETE FROM decks WHERE id = ?", (deck_id,))
    if cursor.rowcount == 0:
        raise DeckError(f"No saved deck with id {deck_id}.")
    conn.commit()
