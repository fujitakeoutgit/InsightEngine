"""The structured filter contract the LLM planner emits.

Rather than let the model write SQL or free text, it fills in this closed
schema. Unknown keys are rejected, values are type-checked, and the result is
translated into the *same* AST the text-syntax parser produces -- so both paths
share one compiler and one set of semantics.
"""

from __future__ import annotations

from typing import Any

from .parser import And, Node, Not, Or, Term

# Every accepted key, with its expected Python type.
FILTER_SCHEMA: dict[str, type | tuple[type, ...]] = {
    "name_contains": str,
    "oracle_contains": list,      # AND -- every phrase must appear
    "oracle_any": list,           # OR  -- at least one phrase must appear
    "oracle_excludes": list,
    "type_contains": list,        # AND
    "type_any": list,             # OR
    "type_excludes": list,
    "oracle_tags": list,          # closed vocabulary from Scryfall Tagger
    "keywords": list,
    "colors": str,
    "colors_exclude": str,        # WUBRG letters the card must NOT be
    "color_identity": str,
    "color_identity_exclude": str,
    "color_identity_mode": str,   # subset | exact | contains
    "min_mana_cost": (int, float),
    "max_mana_cost": (int, float),
    "min_power": (int, float),
    "max_power": (int, float),
    "min_toughness": (int, float),
    "max_toughness": (int, float),
    "rarity": list,
    "sets": list,
    "legal_in": str,
    "is": list,
    "produces": list,
    "min_price_usd": (int, float),
    "max_price_usd": (int, float),
    "exclude_funny": bool,
}

VALID_IDENTITY_MODES = {"subset", "exact", "contains"}

_COLOUR_ALIASES = {"white": "W", "blue": "U", "black": "B", "red": "R", "green": "G"}


def _colour_letters(value: str) -> list[str]:
    """Parse 'B', 'wu', 'black' or 'black, red' into WUBRG letters.

    Anything unrecognised is ignored rather than raising: an exclusion the
    planner phrased oddly should narrow the search less, never kill the plan.
    """
    if not value:
        return []
    letters: list[str] = []
    for part in value.replace(",", " ").split():
        if alias := _COLOUR_ALIASES.get(part.lower()):
            letters.append(alias)
            continue
        for char in part.upper():
            if char in "WUBRG":
                letters.append(char)
    return list(dict.fromkeys(letters))


class FilterError(ValueError):
    pass


def validate(filters: dict[str, Any]) -> dict[str, Any]:
    """Reject anything not in the schema; coerce nothing silently."""
    if not isinstance(filters, dict):
        raise FilterError("filters must be an object")

    clean: dict[str, Any] = {}
    for key, value in filters.items():
        if value is None or value == [] or value == "":
            continue
        expected = FILTER_SCHEMA.get(key)
        if expected is None:
            raise FilterError(f"unknown filter key '{key}'")

        # A single phrase where a list belongs is the most common planner slip
        # and means exactly what a one-element list means. Coercing it saves a
        # plan that would otherwise be discarded whole.
        if expected is list and isinstance(value, str):
            value = [value]

        if not isinstance(value, expected):
            raise FilterError(f"filter '{key}' expects {expected}, got {type(value).__name__}")
        if isinstance(value, list):
            if not all(isinstance(v, str) for v in value):
                raise FilterError(f"filter '{key}' must be a list of strings")
            value = [v for v in value if v.strip()]
            if not value:
                continue
        clean[key] = value

    mode = clean.get("color_identity_mode")
    if mode and mode not in VALID_IDENTITY_MODES:
        raise FilterError(f"color_identity_mode must be one of {sorted(VALID_IDENTITY_MODES)}")
    return clean


def _phrase(key: str, value: str) -> Term:
    """Quote the value so an embedded ``_`` is treated as a wildcard.

    ``~`` is Scryfall's placeholder for the card's own name, and planners emit
    it out of habit ("when ~ dies"). The local engine has no such token, so a
    literal search would match nothing at all. Mapping it onto the wildcard is
    both the correct reading -- any text may stand in for the name -- and the
    difference between a plan returning thousands of cards and returning none.
    """
    return Term(key, ":", value.replace("~", "_"), quoted=True)


def to_ast(filters: dict[str, Any]) -> Node:
    """Translate a validated filter dict into a query AST."""
    filters = validate(filters)
    clauses: list[Node] = []

    if v := filters.get("name_contains"):
        clauses.append(_phrase("name", v))

    for phrase in filters.get("oracle_contains", []):
        clauses.append(_phrase("oracle", phrase))
    if any_phrases := filters.get("oracle_any"):
        clauses.append(Or([_phrase("oracle", p) for p in any_phrases]))
    for phrase in filters.get("oracle_excludes", []):
        clauses.append(Not(_phrase("oracle", phrase)))

    for phrase in filters.get("type_contains", []):
        clauses.append(_phrase("type", phrase))
    if any_types := filters.get("type_any"):
        clauses.append(Or([_phrase("type", t) for t in any_types]))
    for phrase in filters.get("type_excludes", []):
        clauses.append(Not(_phrase("type", phrase)))

    if tags := filters.get("oracle_tags"):
        clauses.append(Or([Term("otag", ":", t) for t in tags]))
    for kw in filters.get("keywords", []):
        clauses.append(Term("keyword", ":", kw))

    if v := filters.get("colors"):
        clauses.append(Term("color", ":", v))
    if v := filters.get("color_identity"):
        mode = filters.get("color_identity_mode", "subset")
        op = {"subset": "<=", "exact": "=", "contains": ":"}[mode]
        clauses.append(Term("identity", op, v))  # type: ignore[arg-type]

    # Exclusions get their own keys because there is no way to say "nonblack"
    # with an inclusion filter. Without these a planner will reach for a regex
    # and the plan dies on an unknown-colour error.
    for key, field in (("colors_exclude", "color"), ("color_identity_exclude", "identity")):
        for letter in _colour_letters(filters.get(key, "")):
            clauses.append(Not(Term(field, ":", letter)))

    numeric_map = [
        ("min_mana_cost", "mv", ">="), ("max_mana_cost", "mv", "<="),
        ("min_power", "power", ">="), ("max_power", "power", "<="),
        ("min_toughness", "toughness", ">="), ("max_toughness", "toughness", "<="),
        ("min_price_usd", "usd", ">="), ("max_price_usd", "usd", "<="),
    ]
    for filter_key, field, op in numeric_map:
        if (value := filters.get(filter_key)) is not None:
            clauses.append(Term(field, op, str(value)))  # type: ignore[arg-type]

    if rarities := filters.get("rarity"):
        clauses.append(Or([Term("rarity", ":", r) for r in rarities]))
    if sets := filters.get("sets"):
        clauses.append(Or([Term("set", ":", s) for s in sets]))
    if v := filters.get("legal_in"):
        clauses.append(Term("legal", ":", v))
    for flag in filters.get("is", []):
        clauses.append(Term("is", ":", flag))
    for symbol in filters.get("produces", []):
        clauses.append(Term("produces", ":", symbol))

    if filters.get("exclude_funny"):
        clauses.append(Not(Term("is", ":", "funny")))

    return And(clauses)
