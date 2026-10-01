"""Export the sample decks' card text, as the rules compiler's test corpus.

The compiler in `web/src/game/compiler/` reads oracle text. Its tests read the
same text the playtester will, so they need the cards themselves rather than
paraphrases -- and the sample decks are the cards a new install plays first,
which makes them the right ones to hold the compiler to.

Run from the repo root after a sample decklist changes:

    py -3.11 packaging/export-rules-corpus.py

Reads the local card mirror (read-only) and writes
web/src/game/compiler/corpus.json.
"""

from __future__ import annotations

import json
import re
import sqlite3
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MIRROR = ROOT / "data" / "mirror.sqlite3"
SEED_DIR = ROOT / "server" / "app" / "seed"
OUT = ROOT / "web" / "src" / "game" / "compiler" / "corpus.json"
DECKS = {
    "Aristocrat": "aristocrat.txt",
    "Land & Draw": "land-and-draw.txt",
    "Abzan Armor": "abzan-armor.txt",
}
LINE = re.compile(r"^\s*(\d+)\s+(.*?)(?:\s+\([^)]+\)\s+\S+)?\s*$")
HEADER = re.compile(r"^(Commander|Deck|Sideboard|Maybeboard)$")
#: Only what the compiler reads. Prices and images change daily and would
#: churn the fixture for nothing.
FIELDS = (
    "oracle_id", "name", "type_line", "mana_cost", "oracle_text", "power",
    "toughness", "loyalty", "colors", "color_identity",
)


def main() -> None:
    conn = sqlite3.connect(f"file:{MIRROR}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    cards: dict[str, dict] = {}
    for deck, filename in DECKS.items():
        section = None
        for raw in (SEED_DIR / filename).read_text(encoding="utf-8").splitlines():
            raw = raw.strip()
            if HEADER.match(raw):
                section = raw
                continue
            m = LINE.match(raw)
            if not m or section not in ("Commander", "Deck"):
                continue
            row = conn.execute("SELECT * FROM cards WHERE name = ? LIMIT 1", (m.group(2),)).fetchone()
            if row is None:
                raise SystemExit(f"Not in the mirror: {m.group(2)}")
            if "Basic Land" in (row["type_line"] or ""):
                continue
            card = cards.setdefault(row["oracle_id"], {
                **{field: row[field] for field in FIELDS},
                "keywords": json.loads(row["keywords"]) if row["keywords"] else [],
                "produced_mana": json.loads(row["produced_mana"]) if row["produced_mana"] else None,
                "card_faces": [
                    {k: face.get(k) for k in ("name", "mana_cost", "type_line", "oracle_text", "power", "toughness")}
                    for face in json.loads(row["card_faces"])
                ] if row["card_faces"] else None,
                "decks": [],
            })
            if deck not in card["decks"]:
                card["decks"].append(deck)
    ordered = sorted(cards.values(), key=lambda c: c["name"])
    OUT.write_text(json.dumps(ordered, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"{len(ordered)} cards -> {OUT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
