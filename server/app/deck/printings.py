"""Printings you have chosen, kept locally once fetched.

The mirror is built from Scryfall's ``oracle_cards`` file: one row per oracle
card, no alternate printings. So picking a printing had nowhere to go. The
decklist text kept ``(SET) 123``, but on reload the resolver matched by name,
found the single oracle row and handed that back — quietly discarding the
choice, which is what "saving does not save the printing" looked like from
outside.

The fix is per-card rather than wholesale. Ingesting ``default_cards`` would
make every printing local at the cost of a much larger download and database,
almost all of it printings nobody in this install will ever ask for. Instead a
printing is fetched the first time it is chosen and kept from then on, so the
mirror grows only by what is actually used and the app still works offline for
every card you have already picked.

Kept in the *user* database. Rebuilding card data replaces the mirror
wholesale, and a printing you chose is your data, not a derived copy.
"""

from __future__ import annotations

import sqlite3
import time
from typing import Any

#: The columns a kept printing overlays onto the oracle row it belongs to.
#: Everything else about a card — its rules text, its cost, its types — is the
#: same in every printing, which is exactly why one oracle row is enough for
#: the rest of the app.
OVERLAY_FIELDS = (
    "set_code", "set_name", "collector_number",
    "image_small", "image_normal", "usd", "artist", "released_at",
)


def keep(conn: sqlite3.Connection, card: dict[str, Any]) -> dict[str, Any] | None:
    """Store one printing. Returns the stored row, or None if unusable.

    Idempotent: choosing the same printing twice refreshes the price and the
    fetch time rather than erroring or duplicating.
    """
    scryfall_id = card.get("id") or card.get("scryfall_id")
    oracle_id = card.get("oracle_id")
    set_code = (card.get("set") or card.get("set_code") or "").lower()
    number = card.get("collector_number")
    if not (scryfall_id and oracle_id and set_code and number):
        return None

    images = card.get("image_uris") or {}
    # A double-faced card carries its art on the faces rather than the card.
    if not images:
        faces = card.get("card_faces") or []
        if faces:
            images = faces[0].get("image_uris") or {}

    prices = card.get("prices") or {}
    usd = prices.get("usd") if isinstance(prices, dict) else None

    row = {
        "scryfall_id": scryfall_id,
        "oracle_id": oracle_id,
        "name": card.get("name") or "",
        "set_code": set_code,
        "set_name": card.get("set_name"),
        "collector_number": str(number),
        "image_small": card.get("image_small") or images.get("small"),
        "image_normal": card.get("image_normal") or images.get("normal"),
        "usd": float(usd) if usd not in (None, "") else card.get("usd"),
        "artist": card.get("artist"),
        "released_at": card.get("released_at"),
        "fetched_at": time.time(),
    }

    conn.execute(
        """
        INSERT INTO printings (
            scryfall_id, oracle_id, name, set_code, set_name, collector_number,
            image_small, image_normal, usd, artist, released_at, fetched_at
        ) VALUES (
            :scryfall_id, :oracle_id, :name, :set_code, :set_name, :collector_number,
            :image_small, :image_normal, :usd, :artist, :released_at, :fetched_at
        )
        ON CONFLICT(scryfall_id) DO UPDATE SET
            usd = excluded.usd,
            image_small = excluded.image_small,
            image_normal = excluded.image_normal,
            fetched_at = excluded.fetched_at
        """,
        row,
    )
    conn.commit()
    return row


def lookup(
    conn: sqlite3.Connection, set_code: str, collector_number: str,
) -> dict[str, Any] | None:
    """A kept printing by the coordinates a decklist line carries."""
    cur = conn.execute(
        "SELECT * FROM printings WHERE set_code = ? AND collector_number = ?",
        (set_code.lower(), str(collector_number)),
    )
    row = cur.fetchone()
    return dict(row) if row else None


def overlay(card: dict[str, Any], printing: dict[str, Any]) -> dict[str, Any]:
    """Apply a kept printing's fields to an oracle card.

    A copy, never in place: the resolver hands out rows from a shared cache,
    and writing a printing into one would give every other deck holding that
    card the same art.
    """
    merged = dict(card)
    for field in OVERLAY_FIELDS:
        value = printing.get(field)
        if value is not None:
            merged[field] = value
    merged["printing_kept"] = True
    return merged
