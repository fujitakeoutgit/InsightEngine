"""Access to Scryfall Tagger's oracle tags.

Tags are the controlled vocabulary the semantic planner selects from. Two
properties make them valuable here:

* They are curated by humans, so 'sacrifice-outlet' catches cards whose rules
  text shares no common substring.
* They form a hierarchy, so selecting a parent can be expanded to every
  descendant deterministically -- which is how the pipeline reaches
  exhaustiveness without the model guessing at synonyms.
"""

from __future__ import annotations

import json
import re
import sqlite3


_STOPWORDS = {
    "the", "and", "for", "with", "that", "this", "from", "are", "can", "all",
    "any", "card", "cards", "mtg", "magic", "get", "one", "when", "you", "your",
}


def _fts_query(text: str) -> str:
    """Build a safe FTS5 expression from a free-text concept phrase.

    Words become OR'd prefix terms, so "sacrifice creatures" also reaches
    'sacrificed' and 'creature'. Only ``[a-z0-9]`` survives tokenisation, so
    no FTS operator can be smuggled in.
    """
    words = re.findall(r"[a-z0-9]+", text.lower())
    terms = [w for w in words if len(w) >= 3 and w not in _STOPWORDS]
    if not terms:
        terms = [w for w in words if w]
    # Truncate long words to a stem before the prefix wildcard so that
    # 'sacrificing' still reaches 'sacrifice'.
    return " OR ".join(f"{w[:8]}*" for w in dict.fromkeys(terms))


def search_tags(conn: sqlite3.Connection, phrase: str, limit: int = 12) -> list[dict]:
    """Find tags whose slug, label or description matches a concept phrase."""
    query = _fts_query(phrase)
    if not query:
        return []
    rows = conn.execute(
        """
        SELECT t.slug, t.label, t.description, t.card_count
        FROM tags_fts f
        JOIN tags t ON t.slug = f.slug
        WHERE tags_fts MATCH ?
          AND t.card_count > 0
        ORDER BY bm25(tags_fts, 4.0, 3.0, 1.0, 2.0), t.card_count DESC
        LIMIT ?
        """,
        (query, limit),
    ).fetchall()
    return [dict(r) for r in rows]


def build_id_index(conn: sqlite3.Connection) -> dict[str, str]:
    rows = conn.execute("SELECT tag_id, slug FROM tags WHERE tag_id IS NOT NULL").fetchall()
    return {r["tag_id"]: r["slug"] for r in rows}


def expand_descendants(
    conn: sqlite3.Connection, slugs: list[str], max_depth: int = 3
) -> set[str]:
    """Grow a tag selection downward through the hierarchy.

    ``tutor`` alone misses ``tutor-creature``; expanding descendants is what
    turns a plausible tag choice into an exhaustive one.
    """
    index = build_id_index(conn)
    seen: set[str] = set()
    frontier = {s.lower() for s in slugs}

    for _ in range(max_depth):
        frontier -= seen
        if not frontier:
            break
        seen |= frontier
        placeholders = ",".join("?" * len(frontier))
        rows = conn.execute(
            f"SELECT child_ids FROM tags WHERE slug IN ({placeholders})",
            tuple(frontier),
        ).fetchall()
        children: set[str] = set()
        for row in rows:
            for child_id in json.loads(row["child_ids"] or "[]"):
                if slug := index.get(child_id):
                    children.add(slug)
        frontier = children

    return seen


def known_slugs(conn: sqlite3.Connection, slugs: list[str]) -> list[str]:
    """Filter a proposed tag list down to slugs that actually exist."""
    if not slugs:
        return []
    placeholders = ",".join("?" * len(slugs))
    rows = conn.execute(
        f"SELECT slug FROM tags WHERE slug IN ({placeholders})",
        tuple(s.lower() for s in slugs),
    ).fetchall()
    return [r["slug"] for r in rows]


def tags_for_card(conn: sqlite3.Connection, oracle_id: str) -> list[str]:
    rows = conn.execute(
        "SELECT slug FROM tag_cards WHERE oracle_id = ? ORDER BY slug", (oracle_id,)
    ).fetchall()
    return [r["slug"] for r in rows]
