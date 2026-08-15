"""Decklist parsing, name resolution and legality tests."""

from __future__ import annotations

import pytest

from app.db import connect
from app.deck.analysis import analyse
from app.deck.parser import parse_decklist
from app.deck.resolver import CardNameResolver


@pytest.fixture(scope="module")
def conn():
    c = connect()
    yield c
    c.close()


@pytest.fixture(scope="module")
def resolver(conn):
    return CardNameResolver(conn)


# --- parsing ---------------------------------------------------------------

@pytest.mark.parametrize("line,qty,name", [
    ("4 Llanowar Elves", 4, "Llanowar Elves"),
    ("4x Llanowar Elves", 4, "Llanowar Elves"),
    ("4 x Llanowar Elves", 4, "Llanowar Elves"),
    ("x4 Llanowar Elves", 4, "Llanowar Elves"),
    ("Llanowar Elves", 1, "Llanowar Elves"),
    ("1 Llanowar Elves (M21) 178", 1, "Llanowar Elves"),
    ("1 Llanowar Elves (M21) 178 *F*", 1, "Llanowar Elves"),
])
def test_quantity_forms(line, qty, name):
    deck = parse_decklist(line)
    assert len(deck.entries) == 1
    assert deck.entries[0].quantity == qty
    assert deck.entries[0].raw_name == name


def test_set_and_collector_number_captured():
    entry = parse_decklist("3 Opt (STA) 26").entries[0]
    assert entry.set_code == "sta"
    assert entry.collector_number == "26"


@pytest.mark.parametrize("raw", ["Fire // Ice", "Fire//Ice", "Fire / Ice", "Fire|Ice"])
def test_double_faced_separators_unify(raw):
    assert parse_decklist(raw).entries[0].raw_name == "Fire // Ice"


def test_sections_and_commander_flag():
    deck = parse_decklist(
        "Commander\n1 Atraxa, Praetors' Voice\n\nDeck\n1 Sol Ring\n\n"
        "Sideboard\n2 Duress\nSB: 1 Negate\n"
    )
    by_section = {}
    for entry in deck.entries:
        by_section.setdefault(entry.section, []).append(entry.raw_name)
    assert by_section["commander"] == ["Atraxa, Praetors' Voice"]
    assert by_section["main"] == ["Sol Ring"]
    assert sorted(by_section["sideboard"]) == ["Duress", "Negate"]


def test_cmdr_marker():
    entry = parse_decklist("1 Atraxa, Praetors' Voice *CMDR*").entries[0]
    assert entry.is_commander and entry.section == "commander"


# --- resolution ladder -----------------------------------------------------

def test_exact_match(resolver):
    res = resolver.resolve("Llanowar Elves", 1, "main")
    assert res.match == "exact" and res.card["name"] == "Llanowar Elves"


def test_punctuation_and_spacing_are_irrelevant(resolver):
    """The user's example: fire/fall, fire fall and firefall must agree."""
    targets = ["Fire // Ice", "Fire//Ice", "fire ice", "FIREICE", "fire/ice"]
    names = {resolver.resolve(t, 1, "main").card["name"] for t in targets}
    assert names == {"Fire // Ice"}


def test_single_face_of_split_card_resolves(resolver):
    res = resolver.resolve("Fire", 1, "main")
    assert res.resolved
    assert "Fire" in res.card["name"]


def test_case_and_accent_insensitive(resolver):
    res = resolver.resolve("aether vial", 1, "main")
    assert res.resolved
    assert res.card["name"].lower().replace("æ", "ae").startswith("aether vial")


def test_apostrophe_variants(resolver):
    a = resolver.resolve("Atraxa, Praetors' Voice", 1, "main")
    b = resolver.resolve("Atraxa Praetors Voice", 1, "main")
    assert a.resolved and b.resolved
    assert a.card["name"] == b.card["name"]


def test_typo_resolves_fuzzily(resolver):
    res = resolver.resolve("Llanowar Elfs", 1, "main")
    assert res.resolved
    assert res.card["name"] == "Llanowar Elves"
    assert res.match in ("fuzzy", "prefix", "ambiguous")


def test_shorthand_prefix_picks_most_played_and_offers_alternatives(resolver):
    """'1 elf' style shorthand must land somewhere sensible, not nowhere."""
    res = resolver.resolve("Llanowar", 1, "main")
    assert res.resolved
    assert res.card["name"].startswith("Llanowar")
    if res.match == "ambiguous":
        assert res.alternatives


def test_nonsense_stays_unresolved(resolver):
    res = resolver.resolve("Zzzqqxx Nonexistent Cardname", 1, "main")
    assert not res.resolved and res.match == "unresolved"


def test_resolution_reports_its_confidence(resolver):
    assert resolver.resolve("Sol Ring", 1, "main").score == 100.0
    assert resolver.resolve("Llanowar Elfs", 1, "main").score < 100.0


# --- legality --------------------------------------------------------------

def _resolve_list(resolver, text):
    deck = parse_decklist(text)
    return [resolver.resolve(e.raw_name, e.quantity, e.section, e.line_number)
            for e in deck.entries]


def test_too_few_cards_fails_standard(resolver):
    report = analyse(_resolve_list(resolver, "4 Llanowar Elves"))
    standard = next(f for f in report["formats"] if f["format"] == "standard")
    assert not standard["legal"]
    assert any("at least 60" in i for i in standard["issues"])


def test_singleton_violation_detected(resolver):
    report = analyse(_resolve_list(
        resolver, "Commander\n1 Atraxa, Praetors' Voice\nDeck\n2 Sol Ring\n"
    ))
    commander = next(f for f in report["formats"] if f["format"] == "commander")
    assert not commander["legal"]
    assert any("Sol Ring" == p["name"] for p in commander["problem_cards"])


def test_basic_lands_exempt_from_copy_limit(resolver):
    report = analyse(_resolve_list(resolver, "30 Island\n30 Mountain"))
    standard = next(f for f in report["formats"] if f["format"] == "standard")
    islands = [p for p in standard["problem_cards"] if p["name"] == "Island"]
    assert not islands


def test_commander_color_identity_enforced(resolver):
    # Sol Ring is colorless (fine); Lightning Bolt is red and must be flagged
    # under a mono-blue commander.
    report = analyse(_resolve_list(
        resolver, "Commander\n1 Talrand, Sky Summoner\nDeck\n1 Lightning Bolt\n1 Sol Ring\n"
    ))
    commander = next(f for f in report["formats"] if f["format"] == "commander")
    flagged = {p["name"] for p in commander["problem_cards"]}
    assert "Lightning Bolt" in flagged
    assert "Sol Ring" not in flagged


def test_price_totals_multiply_by_quantity(resolver):
    one = analyse(_resolve_list(resolver, "1 Sol Ring"))["price_usd"]
    four = analyse(_resolve_list(resolver, "4 Sol Ring"))["price_usd"]
    assert one > 0
    assert four == pytest.approx(one * 4, rel=0.01)


def test_curve_excludes_lands(resolver):
    report = analyse(_resolve_list(resolver, "10 Island\n4 Llanowar Elves"))
    assert sum(report["curve"].values()) == 4


def test_unresolved_names_are_reported(resolver):
    resolutions = _resolve_list(resolver, "1 Zzzqqxx Nonexistent\n1 Sol Ring")
    report = analyse(resolutions)
    assert report["unresolved_count"] == 1
    assert report["total_cards"] == 1
