"""Compile a parsed query AST into a SQLite WHERE clause.

Everything here is parameterised -- no user text is ever interpolated into SQL.
The one exception is a set of fixed column names chosen from closed maps.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from .parser import And, Node, Not, Or, Term

# --------------------------------------------------------------------------
# Vocabularies
# --------------------------------------------------------------------------

COLOR_WORDS: dict[str, str] = {
    "w": "W", "white": "W", "u": "U", "blue": "U", "b": "B", "black": "B",
    "r": "R", "red": "R", "g": "G", "green": "G",
    "c": "", "colorless": "",
    # Guilds
    "azorius": "WU", "dimir": "UB", "rakdos": "BR", "gruul": "RG", "selesnya": "GW",
    "orzhov": "WB", "izzet": "UR", "golgari": "BG", "boros": "RW", "simic": "GU",
    # Shards and wedges
    "bant": "GWU", "esper": "WUB", "grixis": "UBR", "jund": "BRG", "naya": "RGW",
    "abzan": "WBG", "jeskai": "URW", "sultai": "BGU", "mardu": "RWB", "temur": "GUR",
    # Four- and five-colour
    "chaos": "UBRG", "aggression": "WBRG", "altruism": "WURG", "growth": "WUBG",
    "artifice": "WUBR", "wubrg": "WUBRG", "five": "WUBRG", "rainbow": "WUBRG",
}

RARITY_ORDER = "CASE rarity WHEN 'common' THEN 0 WHEN 'uncommon' THEN 1 " \
               "WHEN 'rare' THEN 2 WHEN 'special' THEN 3 WHEN 'mythic' THEN 4 " \
               "WHEN 'bonus' THEN 5 ELSE -1 END"
RARITY_VALUES = {"common": 0, "c": 0, "uncommon": 1, "u": 1, "rare": 2, "r": 2,
                 "special": 3, "s": 3, "mythic": 4, "m": 4, "bonus": 5}

PERMANENT_TYPES = ("Artifact", "Creature", "Enchantment", "Land", "Planeswalker", "Battle")

# Fixed SQL for `is:` / `has:` predicates.
IS_PREDICATES: dict[str, str] = {
    "permanent": "(" + " OR ".join(f"type_line LIKE '%{t}%'" for t in PERMANENT_TYPES) + ")",
    "spell": "(type_line NOT LIKE '%Land%' AND type_line NOT LIKE '%Token%')",
    "commander": "((type_line LIKE '%Legendary%' AND type_line LIKE '%Creature%') "
                 "OR oracle_all LIKE '%can be your commander%')",
    "vanilla": "(type_line LIKE '%Creature%' AND (oracle_all IS NULL OR oracle_all = ''))",
    "funny": "is_funny = 1",
    "digital": "digital = 1",
    "paper": "digital = 0",
    "arena": "EXISTS (SELECT 1 FROM json_each(cards.games) WHERE json_each.value = 'arena')",
    "mtgo": "EXISTS (SELECT 1 FROM json_each(cards.games) WHERE json_each.value = 'mtgo')",
    # Alchemy rebalances are digital-only and prefixed 'A-'.
    "rebalanced": "(digital = 1 AND name LIKE 'A-%')",
    "reserved": "reserved = 1",
    "gamechanger": "game_changer = 1",
    "reprint": "1 = 1",
    "dfc": "card_faces IS NOT NULL",
    "modal": "layout = 'modal_dfc'",
    "transform": "layout = 'transform'",
    "split": "layout = 'split'",
    "flip": "layout = 'flip'",
    "leveler": "layout = 'leveler'",
    "meld": "layout = 'meld'",
    "adventure": "layout = 'adventure'",
    "saga": "type_line LIKE '%Saga%'",
    "hybrid": "(mana_cost LIKE '%/%' AND mana_cost NOT LIKE '%/P%')",
    "phyrexian": "mana_cost LIKE '%/P%'",
    "split_mana": "mana_cost LIKE '%/%'",
    "creature": "type_line LIKE '%Creature%'",
    "land": "type_line LIKE '%Land%'",
    "artifact": "type_line LIKE '%Artifact%'",
    "historic": "(type_line LIKE '%Legendary%' OR type_line LIKE '%Artifact%' "
                "OR type_line LIKE '%Saga%')",
}

NUMERIC_COLUMNS: dict[str, str] = {
    "mv": "cmc",
    "usd": "usd",
    "edhrec": "edhrec_rank",
    "colors": "length(colors)",
}
# Columns that store numbers as text and may contain '*' or 'X'.
SOFT_NUMERIC: dict[str, str] = {
    "power": "power", "toughness": "toughness", "loyalty": "loyalty",
}

_COMPARISONS = {"<", "<=", ">", ">=", "=", "!=", ":"}
_LIKE_ESCAPE = str.maketrans({"%": r"\%", "_": r"\_", "\\": r"\\"})


@dataclass
class Compiled:
    where: str
    params: list[object]

    @staticmethod
    def always_true() -> "Compiled":
        return Compiled("1 = 1", [])

    @staticmethod
    def always_false() -> "Compiled":
        return Compiled("1 = 0", [])


class QueryCompileError(ValueError):
    pass


# --------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------

def wildcard_to_regex(value: str) -> str:
    r"""Translate a ``_``-wildcard phrase into a regular expression.

    ``Elf_creature`` becomes ``Elf.*?creature``, so it matches
    "Elf Warrior creature" as well as "Elf creature". Every other character is
    escaped, so a phrase can never smuggle in regex metacharacters.
    """
    return ".*?".join(re.escape(part) for part in value.split("_"))


def _contains(column: str, value: str) -> Compiled:
    """Case-insensitive substring match with LIKE metacharacters neutralised."""
    return Compiled(f"{column} LIKE ? ESCAPE '\\'", [f"%{value.translate(_LIKE_ESCAPE)}%"])


def _text_match(column: str, term: Term) -> Compiled:
    if term.has_wildcard:
        return Compiled(f"{column} REGEXP ?", [wildcard_to_regex(term.value)])
    if term.op == "=":
        return Compiled(f"lower({column}) = ?", [term.value.lower()])
    return _contains(column, term.value)


def _numeric(column: str, op: str, raw: str) -> Compiled:
    op = "=" if op == ":" else op
    if op not in _COMPARISONS:
        raise QueryCompileError(f"unsupported operator '{op}'")
    try:
        number = float(raw)
    except ValueError:
        raise QueryCompileError(f"'{raw}' is not a number") from None
    return Compiled(f"({column} IS NOT NULL AND {column} {op} ?)", [number])


def _soft_numeric(column: str, op: str, raw: str) -> Compiled:
    """Compare power/toughness/loyalty, skipping rows holding '*' or 'X'."""
    op = "=" if op == ":" else op
    try:
        number = float(raw)
    except ValueError:
        raise QueryCompileError(f"'{raw}' is not a number") from None
    guard = f"{column} IS NOT NULL AND {column} GLOB '[0-9]*'"
    return Compiled(f"({guard} AND CAST({column} AS REAL) {op} ?)", [number])


def _colors(column: str, term: Term) -> Compiled:
    key = term.value.lower()
    letters = COLOR_WORDS.get(key)
    if letters is None:
        if re.fullmatch(r"[wubrgc]+", key):
            letters = "".join(dict.fromkeys(key.upper().replace("C", "")))
        elif key in ("m", "multicolor", "multicolored", "gold"):
            return Compiled(f"length({column}) >= 2", [])
        else:
            raise QueryCompileError(f"unknown colour '{term.value}'")

    wanted = set(letters)
    op = term.op

    if not wanted:  # colourless
        return Compiled(f"length({column}) = 0", [])

    has_all = " AND ".join(f"instr({column}, '{c}') > 0" for c in sorted(wanted))
    excludes_rest = " AND ".join(
        f"instr({column}, '{c}') = 0" for c in "WUBRG" if c not in wanted
    ) or "1 = 1"

    if op in (":", ">="):
        return Compiled(f"({has_all})", [])
    if op == ">":
        return Compiled(f"({has_all} AND length({column}) > {len(wanted)})", [])
    if op == "=":
        return Compiled(f"({has_all} AND length({column}) = {len(wanted)})", [])
    if op == "!=":
        return Compiled(f"NOT ({has_all} AND length({column}) = {len(wanted)})", [])
    if op == "<=":
        return Compiled(f"({excludes_rest})", [])
    if op == "<":
        return Compiled(f"({excludes_rest} AND length({column}) < {len(wanted)})", [])
    raise QueryCompileError(f"unsupported colour operator '{op}'")


def _rarity(term: Term) -> Compiled:
    key = term.value.lower()
    if key not in RARITY_VALUES:
        raise QueryCompileError(f"unknown rarity '{term.value}'")
    if term.op in (":", "="):
        return Compiled("rarity = ?", [
            next(k for k, v in RARITY_VALUES.items()
                 if v == RARITY_VALUES[key] and len(k) > 1)
        ])
    if term.op == "!=":
        return Compiled(f"{RARITY_ORDER} != ?", [RARITY_VALUES[key]])
    return Compiled(f"{RARITY_ORDER} {term.op} ?", [RARITY_VALUES[key]])


def _format_status(term: Term, status: str) -> Compiled:
    """legal:/banned:/restricted: against the stored legalities blob."""
    fmt = re.sub(r"[^a-z0-9]", "", term.value.lower())
    if not fmt:
        raise QueryCompileError("missing format name")
    # json_extract's path is built from a sanitised token, never raw input.
    return Compiled(f"json_extract(legalities, '$.{fmt}') = ?", [status])


def _json_array_has(column: str, value: str) -> Compiled:
    return Compiled(
        f"EXISTS (SELECT 1 FROM json_each(cards.{column}) WHERE lower(json_each.value) = ?)",
        [value.lower()],
    )


def _price(currency: str, term: Term) -> Compiled:
    if currency == "usd":
        return _numeric("usd", term.op, term.value)
    column = f"CAST(json_extract(prices, '$.{currency}') AS REAL)"
    return _numeric(column, term.op, term.value)


# --------------------------------------------------------------------------
# Term dispatch
# --------------------------------------------------------------------------

def compile_term(term: Term) -> Compiled:
    key, op, value = term.key, term.op, term.value

    if key in ("", "name"):
        return _text_match("name", term)
    if key == "oracle":
        return _text_match("oracle_all", term)
    if key == "fulloracle":
        return _text_match("(name || ' ' || type_line || ' ' || COALESCE(oracle_all, ''))", term)
    if key == "type":
        return _text_match("type_line", term)
    if key == "color":
        return _colors("colors", term)
    if key == "identity":
        return _colors("color_identity", term)
    if key == "mv":
        return _numeric("cmc", op, value)
    if key in SOFT_NUMERIC:
        return _soft_numeric(SOFT_NUMERIC[key], op, value)
    if key == "rarity":
        return _rarity(term)
    if key == "set":
        return Compiled("lower(set_code) = ?", [value.lower()])
    if key == "artist":
        return _contains("artist", value)
    if key == "layout":
        return Compiled("layout = ?", [value.lower()])
    if key == "legal":
        return _format_status(term, "legal")
    if key == "banned":
        return _format_status(term, "banned")
    if key == "restricted":
        return _format_status(term, "restricted")
    if key == "keyword":
        return _json_array_has("keywords", value)
    if key == "produces":
        symbol = COLOR_WORDS.get(value.lower(), value.upper())
        return _json_array_has("produced_mana", symbol)
    if key == "usd":
        return _price("usd", term)
    if key == "eur":
        return _price("eur", term)
    if key == "tix":
        return _price("tix", term)
    if key == "year":
        return _numeric("CAST(substr(released_at, 1, 4) AS INTEGER)", op, value)
    if key == "edhrec":
        return _numeric("edhrec_rank", op, value)
    if key == "mana":
        symbols = re.findall(r"\{[^}]+\}|[0-9]+|[wubrgcxWUBRGCX]", value)
        clauses, params = [], []
        for sym in symbols:
            token = sym if sym.startswith("{") else "{" + sym.upper() + "}"
            clauses.append("mana_cost LIKE ? ESCAPE '\\'")
            params.append(f"%{token.translate(_LIKE_ESCAPE)}%")
        return Compiled("(" + " AND ".join(clauses) + ")", params) if clauses \
            else Compiled.always_true()
    if key == "is":
        predicate = IS_PREDICATES.get(value.lower())
        if predicate is None:
            raise QueryCompileError(f"unknown 'is:' filter '{value}'")
        return Compiled(f"({predicate})", [])
    if key == "otag":
        return Compiled(
            "EXISTS (SELECT 1 FROM tag_cards tc WHERE tc.oracle_id = cards.oracle_id "
            "AND tc.slug = ?)", [value.lower()],
        )

    raise QueryCompileError(f"unknown filter '{key}:'")


def compile_node(node: Node) -> Compiled:
    if isinstance(node, Term):
        return compile_term(node)
    if isinstance(node, Not):
        inner = compile_node(node.child)
        return Compiled(f"NOT ({inner.where})", inner.params)
    if isinstance(node, (And, Or)):
        if not node.children:
            return Compiled.always_true()
        joiner = " AND " if isinstance(node, And) else " OR "
        parts, params = [], []
        for child in node.children:
            compiled = compile_node(child)
            parts.append(f"({compiled.where})")
            params.extend(compiled.params)
        return Compiled(joiner.join(parts), params)
    return Compiled.always_true()
