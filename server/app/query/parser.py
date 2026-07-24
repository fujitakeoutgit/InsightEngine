"""Tokenizer and parser for Manafold's search syntax.

The grammar follows Scryfall's shape (``c:red t:creature mv<=3``) plus two
Manafold-only extensions:

* ``q:"free text"``   -- hand the phrase to the local LLM planner.
* ``_`` inside a quoted value -- wildcard matching any run of characters,
  e.g. ``o:"Elf_creature"`` matches "Elf Warrior creature".

Parsing produces an AST rather than a string so the same query can be either
compiled to SQL (local engine) or reassembled for the Scryfall API.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Iterator, Literal

Op = Literal[":", "=", "!=", "<", "<=", ">", ">="]


# --------------------------------------------------------------------------
# AST
# --------------------------------------------------------------------------

@dataclass(frozen=True)
class Term:
    key: str            # normalised field name; "" for a bare name word
    op: Op
    value: str
    quoted: bool = False

    @property
    def has_wildcard(self) -> bool:
        return self.quoted and "_" in self.value


@dataclass
class Not:
    child: "Node"


@dataclass
class And:
    children: list["Node"] = field(default_factory=list)


@dataclass
class Or:
    children: list["Node"] = field(default_factory=list)


Node = Term | Not | And | Or


# --------------------------------------------------------------------------
# Lexer
# --------------------------------------------------------------------------

_TOKEN_RE = re.compile(
    r"""
    (?P<lparen>\()
  | (?P<rparen>\))
  | (?P<minus>-(?=[\w"(]))
  | (?P<pair>(?P<key>[A-Za-z][A-Za-z0-9]*)(?P<op>!=|<=|>=|:|=|<|>)
             (?P<val>"[^"]*"|'[^']*'|[^\s()]+))
  | (?P<bang>!(?P<bangval>"[^"]*"|'[^']*'|[^\s()]+))
  | (?P<phrase>"[^"]*"|'[^']*')
  | (?P<word>[^\s()]+)
    """,
    re.VERBOSE,
)

_BOOL = {"or": "OR", "and": "AND"}


@dataclass(frozen=True)
class Token:
    kind: str
    key: str = ""
    op: str = ":"
    value: str = ""
    quoted: bool = False


def _unquote(raw: str) -> tuple[str, bool]:
    if len(raw) >= 2 and raw[0] == raw[-1] and raw[0] in "\"'":
        return raw[1:-1], True
    return raw, False


def tokenize(source: str) -> list[Token]:
    tokens: list[Token] = []
    for m in _TOKEN_RE.finditer(source):
        if m.group("lparen"):
            tokens.append(Token("LPAREN"))
        elif m.group("rparen"):
            tokens.append(Token("RPAREN"))
        elif m.group("minus"):
            tokens.append(Token("MINUS"))
        elif m.group("pair"):
            value, quoted = _unquote(m.group("val"))
            tokens.append(Token("PAIR", key=m.group("key").lower(),
                                op=m.group("op"), value=value, quoted=quoted))
        elif m.group("bang"):
            # Scryfall's exact-name operator: !"Lightning Bolt"
            value, quoted = _unquote(m.group("bangval"))
            tokens.append(Token("PAIR", key="name", op="=", value=value, quoted=quoted))
        elif m.group("phrase"):
            value, _ = _unquote(m.group("phrase"))
            tokens.append(Token("ATOM", value=value, quoted=True))
        else:
            word = m.group("word")
            upper = _BOOL.get(word.lower())
            tokens.append(Token(upper) if upper else Token("ATOM", value=word))
    return tokens


# --------------------------------------------------------------------------
# Field aliases
# --------------------------------------------------------------------------

FIELD_ALIASES = {
    "c": "color", "color": "color", "colors": "color",
    "id": "identity", "ci": "identity", "identity": "identity",
    "commander": "identity",
    "t": "type", "type": "type",
    "o": "oracle", "oracle": "oracle", "text": "oracle",
    "fo": "fulloracle", "fulloracle": "fulloracle",
    "n": "name", "name": "name",
    "mv": "mv", "cmc": "mv", "manavalue": "mv",
    "m": "mana", "mana": "mana",
    "pow": "power", "power": "power",
    "tou": "toughness", "toughness": "toughness",
    "loy": "loyalty", "loyalty": "loyalty",
    "r": "rarity", "rarity": "rarity",
    "s": "set", "set": "set", "e": "set", "edition": "set",
    "legal": "legal", "banned": "banned", "restricted": "restricted",
    "f": "legal", "format": "legal",
    "is": "is", "has": "is",
    "kw": "keyword", "keyword": "keyword",
    "a": "artist", "artist": "artist",
    "usd": "usd", "price": "usd",
    "eur": "eur", "tix": "tix",
    "year": "year", "date": "year",
    "rank": "edhrec", "edhrec": "edhrec",
    "layout": "layout",
    "produces": "produces",
    "otag": "otag", "function": "otag", "tag": "otag",
    "q": "q", "ask": "q",
}

# Operators that only ever make sense against the local engine.
LOCAL_ONLY_FIELDS = {"q", "otag"}


# --------------------------------------------------------------------------
# Parser (recursive descent)
# --------------------------------------------------------------------------

class QueryParseError(ValueError):
    pass


class _Parser:
    def __init__(self, tokens: list[Token]) -> None:
        self.tokens = tokens
        self.pos = 0

    def peek(self) -> Token | None:
        return self.tokens[self.pos] if self.pos < len(self.tokens) else None

    def next(self) -> Token | None:
        tok = self.peek()
        if tok is not None:
            self.pos += 1
        return tok

    def parse(self) -> Node:
        node = self.parse_or()
        if self.peek() is not None:
            # Unbalanced ')' -- be forgiving and stop rather than 500.
            self.pos = len(self.tokens)
        return node

    def parse_or(self) -> Node:
        branches = [self.parse_and()]
        while (tok := self.peek()) and tok.kind == "OR":
            self.next()
            branches.append(self.parse_and())
        return branches[0] if len(branches) == 1 else Or(branches)

    def parse_and(self) -> Node:
        items: list[Node] = []
        while (tok := self.peek()) and tok.kind not in ("OR", "RPAREN"):
            if tok.kind == "AND":
                self.next()
                continue
            items.append(self.parse_unary())
        if not items:
            return And([])
        return items[0] if len(items) == 1 else And(items)

    def parse_unary(self) -> Node:
        tok = self.peek()
        if tok is None:
            return And([])
        if tok.kind == "MINUS":
            self.next()
            return Not(self.parse_unary())
        if tok.kind == "LPAREN":
            self.next()
            inner = self.parse_or()
            if (nxt := self.peek()) and nxt.kind == "RPAREN":
                self.next()
            return inner
        self.next()
        if tok.kind == "PAIR":
            key = FIELD_ALIASES.get(tok.key, tok.key)
            return Term(key, tok.op, tok.value, tok.quoted)  # type: ignore[arg-type]
        return Term("", ":", tok.value, tok.quoted)


def parse(source: str) -> Node:
    return _Parser(tokenize(source)).parse()


# --------------------------------------------------------------------------
# AST inspection helpers
# --------------------------------------------------------------------------

def walk(node: Node) -> Iterator[Node]:
    yield node
    if isinstance(node, Not):
        yield from walk(node.child)
    elif isinstance(node, (And, Or)):
        for child in node.children:
            yield from walk(child)


def terms(node: Node) -> Iterator[Term]:
    for n in walk(node):
        if isinstance(n, Term):
            yield n


def extract_semantic(node: Node) -> tuple[list[str], Node]:
    """Split ``q:`` prompts out of the tree.

    Returns the natural-language prompts and the tree with those terms removed,
    so the structured half of the query can still be compiled and ANDed against
    whatever the semantic planner produces.
    """
    prompts: list[str] = []

    def strip(n: Node) -> Node | None:
        if isinstance(n, Term):
            if n.key == "q":
                prompts.append(n.value)
                return None
            return n
        if isinstance(n, Not):
            inner = strip(n.child)
            return Not(inner) if inner else None
        if isinstance(n, (And, Or)):
            kept = [c for c in (strip(ch) for ch in n.children) if c is not None]
            if not kept:
                return None
            if len(kept) == 1:
                return kept[0]
            return And(kept) if isinstance(n, And) else Or(kept)
        return n

    remainder = strip(node)
    return prompts, remainder if remainder is not None else And([])


def requires_local_engine(node: Node) -> bool:
    """True when the query uses syntax the Scryfall API cannot express."""
    return any(t.key in LOCAL_ONLY_FIELDS or t.has_wildcard for t in terms(node))


def is_empty(node: Node) -> bool:
    return isinstance(node, (And, Or)) and not node.children
