"""Build the small card database the installer ships with.

A fresh install used to be unusable until a 175MB mirror had been downloaded
and indexed, and if that failed the app opened on "The card database did not
finish building" and nothing else. Shipping a seed means the app works the
moment it is installed, and the full download becomes something that happens
in the background rather than something you wait on.

What goes in: the cards most likely to be looked up, by EDHREC rank, plus
every basic land regardless of rank. Rank is the closest thing the data has to
"cards people actually search for", and a seed chosen any other way is a
seed that misses Sol Ring.

What stays out: rulings, tags and set rows. They are large, none of them is
needed to search or build a deck, and all of them arrive with the full mirror.

Run from the repo root with the venv python:

    server\\.venv\\Scripts\\python packaging\\make-seed.py [count]
"""

from __future__ import annotations

import os
import sqlite3
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "server"))

from app.db import SCHEMA_MIRROR, init_mirror, set_meta  # noqa: E402
from app.bulk import _CARD_COLUMNS  # noqa: E402

OUT = ROOT / "packaging" / "seed-mirror.sqlite3"
DEFAULT_COUNT = 2500


def _source() -> Path:
    """A full mirror to cut down. The installed one, else the dev checkout."""
    for candidate in (
        Path(os.environ.get("LOCALAPPDATA", "")) / "InsightEngine" / "mirror.sqlite3",
        ROOT / "data" / "mirror.sqlite3",
    ):
        if candidate.exists() and candidate.stat().st_size > 1_000_000:
            return candidate
    raise SystemExit("No full mirror found. Build one first: python -m app.bulk")


def main() -> int:
    count = int(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_COUNT
    src_path = _source()
    print(f"  source  {src_path}  ({src_path.stat().st_size / 1048576:.0f} MB)")

    src = sqlite3.connect(f"file:{src_path}?mode=ro", uri=True)
    src.row_factory = sqlite3.Row

    if OUT.exists():
        OUT.unlink()
    out = sqlite3.connect(OUT)
    out.executescript(SCHEMA_MIRROR)
    # meta is created here rather than by the schema, and the seed marker and
    # the schema version both live in it.
    init_mirror(out)

    # Paper only, and nothing joke or digital: a seed is a first impression.
    # Basics are unioned in rather than trusted to rank, because a deck without
    # them cannot be built and their rank is poor.
    rows = src.execute(
        f"""
        SELECT {_CARD_COLUMNS} FROM cards
        WHERE digital = 0 AND is_funny = 0
          AND (type_line LIKE 'Basic Land%%' OR edhrec_rank IS NOT NULL)
        ORDER BY (type_line LIKE 'Basic Land%%') DESC,
                 COALESCE(edhrec_rank, 999999) ASC
        LIMIT ?
        """,
        (count,),
    ).fetchall()

    # Every card the sample deck needs, whatever its rank.
    #
    # The app seeds a Minsc deck so a new install has something to look at, and
    # a seed mirror chosen purely by EDHREC rank does not contain most of it --
    # Minsc himself was missing, so the one deck a new user opens resolves to
    # nothing. Both seeds exist for the same first run, so they have to agree.
    #
    # Parsed and folded by the app's own code rather than a regex here. A first
    # attempt with a hand-written pattern missed four lines out of eighty-nine:
    # a "*CMDR*" flag, a split card written "Dusk / Dawn", an accented name,
    # and a section header it took for a card. The parser already knows all of
    # that, and using it means the seed contains exactly what the app will look
    # for.
    from app.deck.parser import parse_decklist
    from app.db import fold_name

    deck = (ROOT / "server" / "app" / "seed" / "minsc.txt").read_text(encoding="utf-8")
    wanted = {fold_name(e.raw_name) for e in parse_decklist(deck).entries}

    have = {fold_name(r["name"]) for r in rows}
    missing = sorted(wanted - have)
    if missing:
        qs = ",".join("?" * len(missing))
        extra = src.execute(
            f"SELECT {_CARD_COLUMNS} FROM cards WHERE name_fold IN ({qs})", missing
        ).fetchall()
        rows = list(rows) + list(extra)
        print(f"  deck    +{len(extra)} of {len(missing)} sample-deck cards")

    placeholders = ",".join("?" * len(rows[0]))
    out.executemany(
        f"INSERT OR REPLACE INTO cards({_CARD_COLUMNS}) VALUES({placeholders})",
        [tuple(r) for r in rows],
    )
    out.execute(
        "INSERT INTO cards_fts(rowid, name, type_line, oracle_all) "
        "SELECT rowid, name, type_line, oracle_all FROM cards"
    )

    # Marked so the app knows this is a starting point rather than the real
    # thing, and can go and fetch the rest without being asked.
    set_meta(out, "mirror:seed", "1")
    out.commit()
    out.execute("VACUUM")
    out.close()
    src.close()

    print(f"  cards   {len(rows)}")
    print(f"  written {OUT}  ({OUT.stat().st_size / 1048576:.1f} MB)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
