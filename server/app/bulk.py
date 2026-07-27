"""Download and ingest Scryfall bulk data into the local SQLite mirror.

Run directly to build or refresh the database:

    py -3.11 -m app.bulk            # refresh if Scryfall has newer files
    py -3.11 -m app.bulk --force    # re-download everything

Bulk files are the sanctioned way to obtain the whole corpus; hammering the
paginated search endpoint for the same data would violate Scryfall's rate
guidance and still not guarantee completeness.
"""

from __future__ import annotations

import argparse
import json
import sqlite3
import sys
import time
from pathlib import Path
from typing import Any, Iterator

import httpx

from .config import settings
from .db import connect, fold_name, init_db, get_meta, normalize_name, set_meta

WANTED_BULK = ("oracle_cards", "oracle_tags", "rulings")
_HEADERS = {"User-Agent": settings.scryfall_user_agent, "Accept": "application/json"}

# Sets that exist to be jokes rather than playable cards. Kept in the mirror
# (people search for them) but flagged so the default view can hide them.
FUNNY_SET_TYPES = {"funny", "memorabilia"}


def _log(msg: str) -> None:
    print(f"[bulk] {msg}", flush=True)


def fetch_manifest(client: httpx.Client) -> dict[str, dict[str, Any]]:
    resp = client.get(f"{settings.scryfall_base}/bulk-data", headers=_HEADERS)
    resp.raise_for_status()
    return {item["type"]: item for item in resp.json()["data"]}


def download(client: httpx.Client, uri: str, dest: Path) -> Path:
    """Stream a bulk file to disk. These are hundreds of MB."""
    tmp = dest.with_suffix(".part")
    with client.stream("GET", uri, headers=_HEADERS, timeout=None) as resp:
        resp.raise_for_status()
        total = int(resp.headers.get("content-length", 0))
        seen = 0
        last_report = 0.0
        with tmp.open("wb") as fh:
            for chunk in resp.iter_bytes(1 << 20):
                fh.write(chunk)
                seen += len(chunk)
                now = time.time()
                if total and now - last_report > 2:
                    _log(f"  {dest.name}: {seen / 1e6:6.1f} / {total / 1e6:.1f} MB")
                    last_report = now
    tmp.replace(dest)
    _log(f"  {dest.name}: done ({seen / 1e6:.1f} MB)")
    return dest


def _face_texts(card: dict[str, Any]) -> tuple[str, str]:
    """Return (front-face oracle text, oracle text of *every* face).

    The second value backs the ``o:`` operator, so it must contain rules text
    only -- no names or type lines, or ``o:creature`` would match every
    creature ever printed instead of cards that say "creature".
    """
    primary = card.get("oracle_text") or ""
    parts: list[str] = [primary] if primary else []
    for face in card.get("card_faces") or []:
        if face.get("oracle_text"):
            parts.append(face["oracle_text"])
    return primary, "\n".join(parts)


def _card_row(card: dict[str, Any], funny_sets: set[str]) -> tuple | None:
    oracle_id = card.get("oracle_id")
    if not oracle_id:
        # `reversible_card` layouts carry oracle_id on each face instead.
        faces = card.get("card_faces") or []
        oracle_id = next((f.get("oracle_id") for f in faces if f.get("oracle_id")), None)
    if not oracle_id:
        return None

    name = card.get("name") or ""
    oracle_text, oracle_all = _face_texts(card)
    images = card.get("image_uris") or {}
    if not images and card.get("card_faces"):
        images = (card["card_faces"][0].get("image_uris")) or {}

    prices = card.get("prices") or {}
    try:
        usd = float(prices.get("usd") or prices.get("usd_foil") or 0) or None
    except (TypeError, ValueError):
        usd = None

    colors = "".join(card.get("colors") or [])
    identity = "".join(sorted(card.get("color_identity") or []))
    games = card.get("games") or []

    return (
        oracle_id,
        card.get("id"),
        name,
        normalize_name(name),
        fold_name(name),
        card.get("released_at"),
        card.get("layout"),
        card.get("mana_cost"),
        card.get("cmc"),
        card.get("type_line"),
        oracle_text,
        oracle_all,
        card.get("power"),
        card.get("toughness"),
        card.get("loyalty"),
        card.get("defense"),
        colors,
        identity,
        len(identity),
        json.dumps(card.get("keywords") or []),
        json.dumps(card.get("produced_mana") or []),
        card.get("set"),
        card.get("set_name"),
        card.get("collector_number"),
        card.get("rarity"),
        card.get("artist"),
        card.get("edhrec_rank"),
        card.get("penny_rank"),
        int(bool(card.get("reserved"))),
        int(bool(card.get("game_changer"))),
        int((card.get("set") or "") in funny_sets),
        json.dumps(games),
        # Scryfall's own links to the tokens and emblems a card produces —
        # far more reliable than pattern-matching rules text for "create ...".
        json.dumps(card.get("all_parts")) if card.get("all_parts") else None,
        # Digital-only cards (Alchemy rebalances, Arena exclusives) are hidden
        # by default, matching Scryfall's own search behaviour.
        int("paper" not in games),
        json.dumps(card.get("legalities") or {}),
        json.dumps(prices),
        usd,
        images.get("small"),
        images.get("normal"),
        images.get("art_crop"),
        card.get("scryfall_uri"),
        json.dumps(card.get("card_faces")) if card.get("card_faces") else None,
    )


_CARD_COLUMNS = (
    "oracle_id, scryfall_id, name, name_norm, name_fold, released_at, layout, "
    "mana_cost, cmc, type_line, oracle_text, oracle_all, power, toughness, "
    "loyalty, defense, colors, color_identity, color_count, keywords, "
    "produced_mana, set_code, set_name, collector_number, rarity, artist, "
    "edhrec_rank, penny_rank, reserved, game_changer, is_funny, games, all_parts, digital, "
    "legalities, prices, usd, image_small, image_normal, image_art_crop, "
    "scryfall_uri, card_faces"
)


def ingest_sets(conn: sqlite3.Connection, client: httpx.Client) -> set[str]:
    """Load the set list; returns codes belonging to joke/memorabilia sets."""
    resp = client.get(f"{settings.scryfall_base}/sets", headers=_HEADERS)
    resp.raise_for_status()
    sets = resp.json()["data"]
    conn.execute("DELETE FROM sets")
    conn.executemany(
        "INSERT OR REPLACE INTO sets(code, name, set_type, released_at, card_count, "
        "digital, icon_svg_uri, parent_code) VALUES(?,?,?,?,?,?,?,?)",
        [
            (
                s["code"], s["name"], s.get("set_type"), s.get("released_at"),
                s.get("card_count"), int(bool(s.get("digital"))),
                s.get("icon_svg_uri"), s.get("parent_set_code"),
            )
            for s in sets
        ],
    )
    conn.commit()
    _log(f"sets: {len(sets)}")
    return {s["code"] for s in sets if s.get("set_type") in FUNNY_SET_TYPES}


def ingest_cards(conn: sqlite3.Connection, path: Path, funny_sets: set[str]) -> int:
    _log("parsing oracle_cards ...")
    cards = json.loads(path.read_text(encoding="utf-8"))
    rows = [r for r in (_card_row(c, funny_sets) for c in cards) if r]

    conn.execute("DELETE FROM cards")
    conn.execute("DELETE FROM cards_fts")
    placeholders = ",".join("?" * len(rows[0]))
    conn.executemany(
        f"INSERT OR REPLACE INTO cards({_CARD_COLUMNS}) VALUES({placeholders})", rows
    )
    conn.execute(
        "INSERT INTO cards_fts(rowid, name, type_line, oracle_all) "
        "SELECT rowid, name, type_line, oracle_all FROM cards"
    )
    conn.commit()
    _log(f"cards: {len(rows)}")
    return len(rows)


def ingest_tags(conn: sqlite3.Connection, path: Path) -> int:
    """Ingest Scryfall Tagger's oracle tags.

    These are human-curated functional labels ('sacrifice-outlet',
    'creature-tutor'). They become the controlled vocabulary the LLM selects
    from, which is what keeps the semantic pipeline both exhaustive and
    incapable of inventing a concept that has no cards behind it.
    """
    _log("parsing oracle_tags ...")
    tags = json.loads(path.read_text(encoding="utf-8"))

    conn.execute("DELETE FROM tags")
    conn.execute("DELETE FROM tag_cards")
    conn.execute("DELETE FROM tags_fts")

    tag_rows: list[tuple] = []
    link_rows: list[tuple] = []
    fts_rows: list[tuple] = []
    for tag in tags:
        slug = tag.get("slug")
        if not slug:
            continue
        taggings = tag.get("taggings") or []
        oracle_ids = {t.get("oracle_id") for t in taggings if t.get("oracle_id")}
        aliases = " ".join(tag.get("aliases") or [])
        tag_rows.append((
            slug, tag.get("id"), tag.get("label"), tag.get("description"),
            json.dumps(tag.get("aliases") or []),
            json.dumps(tag.get("parent_ids") or []),
            json.dumps(tag.get("child_ids") or []),
            len(oracle_ids),
        ))
        link_rows.extend((slug, oid) for oid in oracle_ids)
        # Slug words are searchable terms in their own right.
        fts_rows.append((slug, tag.get("label") or "", tag.get("description") or "",
                         f"{aliases} {slug.replace('-', ' ')}"))

    conn.executemany(
        "INSERT OR REPLACE INTO tags(slug, tag_id, label, description, aliases, "
        "parent_ids, child_ids, card_count) VALUES(?,?,?,?,?,?,?,?)", tag_rows
    )
    conn.executemany(
        "INSERT OR IGNORE INTO tag_cards(slug, oracle_id) VALUES(?,?)", link_rows
    )
    conn.executemany(
        "INSERT INTO tags_fts(slug, label, description, aliases) VALUES(?,?,?,?)", fts_rows
    )
    conn.commit()
    _log(f"tags: {len(tag_rows)} ({len(link_rows)} card links)")
    return len(tag_rows)


def ingest_rulings(conn: sqlite3.Connection, path: Path) -> int:
    _log("parsing rulings ...")
    rulings = json.loads(path.read_text(encoding="utf-8"))
    conn.execute("DELETE FROM rulings")
    conn.executemany(
        "INSERT INTO rulings(oracle_id, published_at, comment, source) VALUES(?,?,?,?)",
        [
            (r.get("oracle_id"), r.get("published_at"), r.get("comment"), r.get("source"))
            for r in rulings if r.get("oracle_id")
        ],
    )
    conn.commit()
    _log(f"rulings: {len(rulings)}")
    return len(rulings)


def _ingest(conn: sqlite3.Connection, kind: str, dest: Path, funny_sets: set[str]) -> None:
    if kind == "oracle_cards":
        ingest_cards(conn, dest, funny_sets)
    elif kind == "oracle_tags":
        ingest_tags(conn, dest)
    elif kind == "rulings":
        ingest_rulings(conn, dest)


def refresh(force: bool = False, reingest: bool = False) -> None:
    conn = connect()
    init_db(conn)

    with httpx.Client(timeout=60.0, follow_redirects=True) as client:
        manifest = fetch_manifest(client)
        funny_sets = ingest_sets(conn, client)

        for kind in WANTED_BULK:
            entry = manifest.get(kind)
            dest = settings.bulk_dir / f"{kind}.json"

            # Re-parse files already on disk: used after a schema change, and
            # deliberately avoids re-downloading a quarter of a gigabyte.
            if reingest:
                if dest.exists():
                    _ingest(conn, kind, dest, funny_sets)
                    if entry:
                        # The cached file is this version, and now so is the DB.
                        set_meta(conn, f"file:{kind}", entry["updated_at"])
                        set_meta(conn, f"ingest:{kind}", entry["updated_at"])
                else:
                    _log(f"!! {kind}: no cached file to re-ingest")
                continue

            if not entry:
                _log(f"!! Scryfall did not offer a '{kind}' bulk file; skipping")
                continue

            stamp = entry["updated_at"]
            # Tracked separately: the file on disk may be current while the
            # database needs rebuilding after a schema bump.
            have_file = dest.exists() and get_meta(conn, f"file:{kind}") == stamp
            have_ingest = get_meta(conn, f"ingest:{kind}") == stamp

            if not force and have_file and have_ingest:
                _log(f"{kind}: already current ({stamp})")
                continue

            if force or not have_file:
                _log(f"{kind}: downloading {entry['download_uri']}")
                download(client, entry["download_uri"], dest)
                set_meta(conn, f"file:{kind}", stamp)
            else:
                _log(f"{kind}: re-ingesting cached file")

            _ingest(conn, kind, dest, funny_sets)
            set_meta(conn, f"ingest:{kind}", stamp)

    conn.execute("ANALYZE")
    set_meta(conn, "built_at", time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()))
    conn.commit()

    total = conn.execute("SELECT COUNT(*) AS n FROM cards").fetchone()["n"]
    _log(f"ready: {total} unique oracle cards in {settings.db_path}")
    conn.close()


def main() -> int:
    parser = argparse.ArgumentParser(description="Build the Insight Enigma card mirror")
    parser.add_argument("--force", action="store_true", help="re-download even if current")
    parser.add_argument("--reingest", action="store_true",
                        help="re-parse cached bulk files without downloading")
    args = parser.parse_args()
    refresh(force=args.force, reingest=args.reingest)
    return 0


if __name__ == "__main__":
    sys.exit(main())
