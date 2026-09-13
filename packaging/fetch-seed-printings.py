"""Fetch every printing the sample decks name, for shipping with the build.

The mirror is Scryfall's `oracle_cards`: one row per card, not per printing. So
a seeded deck naming `(6ED) 274` displays whichever edition the mirror happens
to hold -- for the samples that was 23 of 88 cards showing the wrong art, which
is a poor first impression from the one deck a new install opens.

`printings` is the table that fixes this for a user who picks an edition by
hand, and it is a local, per-install table. This writes the same rows for the
samples ahead of time so a fresh install has them without a network round trip
per card on first run.

Run from the repo root when a sample decklist changes:

    py -3.11 packaging/fetch-seed-printings.py

Writes server/app/seed/printings.json, which the seeder installs. Requires the
network; the build does not.
"""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parent.parent
SEED_DIR = ROOT / "server" / "app" / "seed"
OUT = SEED_DIR / "printings.json"

API = "https://api.scryfall.com"
HEADERS = {
    "User-Agent": "InsightEngine/1.0 (+https://github.com/fujitakeoutgit/InsightEngine)",
    "Accept": "application/json",
}

#: Scryfall asks for 50-100ms between requests. This runs a few times a year.
DELAY = 0.12

# The decklist parser lives in the server package.
sys.path.insert(0, str(ROOT / "server"))
from app.deck.parser import parse_decklist  # noqa: E402


def wanted() -> list[tuple[str, str]]:
    """Every (set, collector number) the sample decks name, deduplicated."""
    seen: dict[tuple[str, str], None] = {}
    for path in sorted(SEED_DIR.glob("*.txt")):
        for entry in parse_decklist(path.read_text(encoding="utf-8")).entries:
            if entry.set_code and entry.collector_number:
                seen[(entry.set_code.lower(), str(entry.collector_number))] = None
    return list(seen)


def row_for(card: dict) -> dict | None:
    """The card, in the shape the `printings` table stores.

    Shaped here rather than at runtime so the shipped file is a plain list of
    rows and the seeder needs to know nothing about Scryfall's schema.
    """
    images = card.get("image_uris") or {}
    if not images:
        faces = card.get("card_faces") or []
        if faces:
            images = faces[0].get("image_uris") or {}
    prices = card.get("prices") or {}
    usd = prices.get("usd")

    oracle_id = card.get("oracle_id")
    if not oracle_id:
        # Reversible cards carry it per face.
        for face in card.get("card_faces") or []:
            if face.get("oracle_id"):
                oracle_id = face["oracle_id"]
                break
    if not (card.get("id") and oracle_id):
        return None

    return {
        "scryfall_id": card["id"],
        "oracle_id": oracle_id,
        "name": card.get("name") or "",
        "set_code": (card.get("set") or "").lower(),
        "set_name": card.get("set_name"),
        "collector_number": str(card.get("collector_number")),
        "image_small": images.get("small"),
        "image_normal": images.get("normal"),
        "usd": float(usd) if usd not in (None, "") else None,
        "artist": card.get("artist"),
        "released_at": card.get("released_at"),
    }


def main() -> int:
    targets = wanted()
    print(f"{len(targets)} printings named across the sample decks")

    rows: list[dict] = []
    missing: list[str] = []
    with httpx.Client(timeout=20.0, headers=HEADERS, follow_redirects=True) as client:
        for i, (set_code, number) in enumerate(targets, start=1):
            try:
                resp = client.get(f"{API}/cards/{set_code}/{number}")
                if resp.status_code != 200:
                    missing.append(f"{set_code.upper()} {number} -> HTTP {resp.status_code}")
                    continue
                row = row_for(resp.json())
                if row is None:
                    missing.append(f"{set_code.upper()} {number} -> unusable")
                    continue
                rows.append(row)
            except Exception as exc:  # noqa: BLE001 - report and carry on
                missing.append(f"{set_code.upper()} {number} -> {exc}")
            if i % 20 == 0:
                print(f"  {i}/{len(targets)}")
            time.sleep(DELAY)

    OUT.write_text(json.dumps(rows, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"\nwrote {OUT.relative_to(ROOT)}: {len(rows)} printings")
    if missing:
        print(f"{len(missing)} could not be fetched:")
        for m in missing:
            print("  ", m)
    return 1 if missing else 0


if __name__ == "__main__":
    raise SystemExit(main())
