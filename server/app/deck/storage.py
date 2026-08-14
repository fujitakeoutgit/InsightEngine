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
    keys = row.keys()
    deck = {
        "id": row["id"],
        "name": row["name"],
        "commander": row["commander"],
        "description": row["description"] if "description" in keys else None,
        "format": row["format"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
        # Present when the listing query joined the commander's card row; the
        # gallery is built from these.
        "commander_art": row["commander_art"] if "commander_art" in keys else None,
        "commander_image": row["commander_image"] if "commander_image" in keys else None,
        "color_identity": row["color_identity"] if "color_identity" in keys else None,
    }
    if with_text:
        deck["text"] = row["text"]
    else:
        # Enough for a gallery card without shipping every decklist.
        deck["lines"] = len([ln for ln in (row["text"] or "").splitlines() if ln.strip()])
    return deck


def detect_commander(conn: sqlite3.Connection, text: str) -> tuple[str | None, str | None]:
    """Find the deck's commander from its own text.

    Done here rather than asked of the caller so every save populates it, which
    is what the gallery renders. Falls back to the first legendary creature
    when no Commander section is present.
    """
    from .parser import parse_decklist
    from ..db import fold_name

    parsed = parse_decklist(text)
    named = [e for e in parsed.entries if e.section == "commander" or e.is_commander]
    candidates = named or parsed.entries

    # Every card in the commander slot, not the first one. A partner pair, a
    # commander and its Background, or a Doctor and its companion are two
    # commanders and the deck is named after both -- returning only the first
    # made "Rowan" and "Will" indistinguishable in the gallery.
    #
    # The id stays singular: it picks the face shown on a tile, and a tile has
    # room for one. The editor draws both from the deck's own entries.
    found: list[tuple[str, str]] = []
    for entry in candidates:
        row = conn.execute(
            "SELECT oracle_id, name, type_line FROM cards WHERE name_fold = ? LIMIT 1",
            (fold_name(entry.raw_name),),
        ).fetchone()
        if not row:
            continue
        if named or (
            "Legendary" in (row["type_line"] or "") and "Creature" in (row["type_line"] or "")
        ):
            found.append((row["name"], row["oracle_id"]))
            # Two is the maximum any pairing rule allows.
            if not named or len(found) == 2:
                break
    if not found:
        return None, None
    return " + ".join(name for name, _ in found), found[0][1]


def save(
    conn: sqlite3.Connection,
    name: str,
    text: str,
    *,
    deck_id: int | None = None,
    commander: str | None = None,
    format_key: str | None = None,
    description: str | None = None,
) -> dict[str, Any]:
    name = (name or "").strip() or "Untitled deck"
    if len(text.encode("utf-8")) > MAX_DECK_BYTES:
        raise DeckError("Decklist is too large to save.")

    detected_name, oracle_id = detect_commander(conn, text)
    commander = commander or detected_name

    now = _now()
    if deck_id is not None:
        cursor = conn.execute(
            "UPDATE decks SET name = ?, text = ?, commander = ?, commander_oracle_id = ?, "
            "format = ?, description = ?, updated_at = ? WHERE id = ?",
            (name, text, commander, oracle_id, format_key, description, now, deck_id),
        )
        if cursor.rowcount == 0:
            raise DeckError(f"No saved deck with id {deck_id}.")
    else:
        cursor = conn.execute(
            "INSERT INTO decks(name, text, commander, commander_oracle_id, format, "
            "description, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?)",
            (name, text, commander, oracle_id, format_key, description, now, now),
        )
        deck_id = cursor.lastrowid
    conn.commit()

    row = conn.execute("SELECT * FROM decks WHERE id = ?", (deck_id,)).fetchone()
    return _row(row)


def backfill_commanders(conn: sqlite3.Connection) -> int:
    """Populate commander art for decks saved before the column existed.

    Without this, every pre-existing deck shows a blank tile in the gallery
    until it happens to be re-saved.
    """
    rows = conn.execute(
        "SELECT id, text FROM decks WHERE commander_oracle_id IS NULL"
    ).fetchall()
    filled = 0
    for row in rows:
        name, oracle_id = detect_commander(conn, row["text"] or "")
        if not oracle_id:
            continue
        conn.execute(
            "UPDATE decks SET commander = COALESCE(commander, ?), "
            "commander_oracle_id = ? WHERE id = ?",
            (name, oracle_id, row["id"]),
        )
        filled += 1
    if filled:
        conn.commit()
    return filled


def listing(conn: sqlite3.Connection) -> list[dict[str, Any]]:
    """Decks plus their commander's art, which is what the gallery shows."""
    rows = conn.execute(
        """
        SELECT d.*,
               c.image_art_crop AS commander_art,
               c.image_normal   AS commander_image,
               c.color_identity AS color_identity
        FROM decks d
        LEFT JOIN cards c ON c.oracle_id = d.commander_oracle_id
        ORDER BY d.updated_at DESC
        """
    ).fetchall()
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
