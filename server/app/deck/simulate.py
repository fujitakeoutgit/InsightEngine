"""Monte Carlo mana simulation.

Shuffles the deck, draws an opening hand, and plays out the first several turns
many times over, recording what mana was available and when. It answers the
questions a mana base raises that a static count cannot: not "how many green
sources are in the list" but "on turn three, how often can I actually cast a
green spell".

This is a mana simulation, not a game engine. Nothing attacks, nothing is
countered, no opponent exists, and no spell is cast except a mana rock or dork
— which are the only spells that change how much mana you have. Everything
else about a card is ignored except its cost, so a deck of Black Lotuses and a
deck of Storm Crows with the same curve simulate identically.

The deliberate simplifications, all of which flatter no deck in particular:

* One land per turn, played whenever the hand holds one. A turn where the hand
  holds no land is a missed land drop, which is the statistic most players
  actually want out of this.
* A land that enters tapped produces nothing the turn it lands.
* Rocks and dorks are cast as soon as the mana is there, cheapest first, one
  per turn. A dork is summoning-sick, so like a tapped land it pays nothing on
  the turn it arrives.
* Colour requirements are never checked when casting a rock — a two-mana rock
  is cast on turn two whatever colours those two lands make. Checking would
  make the simulation depend on a solver, and rocks are overwhelmingly
  generic-costed anyway.
"""

from __future__ import annotations

import random
import sqlite3
from collections import Counter
from dataclasses import dataclass, field
from typing import Any

from .resolver import Resolution
from .stats import COLOURS, _ONE_SHOT, _PERMANENT, _pips

MAX_ITERATIONS = 20000
MAX_TURNS = 20


@dataclass(frozen=True)
class SimCard:
    """Everything the simulation needs about one card, resolved once."""

    name: str
    cmc: int
    pips: tuple[str, ...]
    is_land: bool
    #: Coloured symbols this card can produce, restricted to the scope colours.
    makes: tuple[str, ...]
    #: A permanent that produces mana and is not a land: a rock, dork or similar.
    is_accelerant: bool
    #: Enters tapped, or is a creature and therefore summoning sick.
    enters_slow: bool


@dataclass
class TurnTally:
    """Running totals for one turn number, summed across every game."""

    lands: float = 0.0
    mana: float = 0.0
    colours: float = 0.0
    hand_cmc: float = 0.0
    hand_size: float = 0.0
    accelerants: float = 0.0
    missed: int = 0
    castable_on_curve: int = 0
    #: Weighted sources per colour, so a colour can be traced turn by turn.
    per_colour: Counter = field(default_factory=Counter)


def _weighted(makes: tuple[str, ...], scope: set[str]) -> dict[str, float]:
    """A source split between the colours it serves.

    The same rule the mana base panel uses: a dual is half a source to each of
    its colours, a triome a third, a five-colour land a fifth — or a quarter,
    when the commander allows only four and the fifth colour is dead weight.
    """
    relevant = [c for c in makes if c in scope] if scope else list(makes)
    if not relevant:
        return {}
    share = 1.0 / len(relevant)
    return {c: share for c in relevant}


def _build(conn: sqlite3.Connection, resolutions: list[Resolution]) -> tuple[list[SimCard], set[str]]:
    """The library, and the colours worth measuring.

    The commander is excluded: it starts in the command zone, so shuffling it
    into the library would both understate the deck's real card count and
    occasionally "draw" it.
    """
    scope: set[str] = set()
    for res in resolutions:
        if res.card and res.section == "commander":
            scope |= set(res.card.get("color_identity") or "")

    library: list[SimCard] = []
    for res in resolutions:
        card = res.card
        if not card or res.section not in ("main", "companion"):
            continue

        line = card.get("type_line") or ""
        is_land = "Land" in line
        text = (card.get("oracle_text") or "").lower()
        all_makes = card.get("produced_mana") or []
        makes = tuple(s for s in all_makes if s in COLOURS)
        accelerant = bool(
            not is_land
            and all_makes
            and _PERMANENT.search(line)
            and not _ONE_SHOT.search(line)
        )
        slow = (
            ("enters the battlefield tapped" in text or "enters tapped" in text)
            if is_land
            else ("Creature" in line)
        )
        pip_counter = _pips(card.get("mana_cost"))
        pips = tuple(c for c in COLOURS for _ in range(pip_counter[c]))

        sim = SimCard(
            name=card["name"],
            cmc=int(card.get("cmc") or 0),
            pips=pips,
            is_land=is_land,
            makes=makes,
            is_accelerant=accelerant,
            enters_slow=slow,
        )
        library.extend([sim] * res.quantity)

    return library, scope


def _play_one(
    library: list[SimCard], scope: set[str], turns: int, rng: random.Random,
) -> list[dict[str, Any]]:
    """One game. Returns a per-turn record."""
    deck = library[:]
    rng.shuffle(deck)

    hand: list[SimCard] = [deck.pop() for _ in range(min(7, len(deck)))]
    battlefield: list[SimCard] = []
    # Permanents that arrived this turn and cannot pay for anything yet.
    pending: list[SimCard] = []

    record: list[dict[str, Any]] = []

    for _ in range(1, turns + 1):
        # A card every turn, turn one included.
        if deck:
            hand.append(deck.pop())

        # Anything that arrived last turn is now online.
        battlefield.extend(pending)
        pending = []

        # Land drop. Prefer a land that adds a colour the board cannot yet
        # make; failing that, prefer one that enters untapped. A player picks
        # the land that unlocks something, not the first one they see.
        have: set[str] = set()
        for card in battlefield:
            have.update(c for c in card.makes if not scope or c in scope)

        lands = [c for c in hand if c.is_land]
        missed = not lands
        if lands:
            def land_key(card: SimCard) -> tuple[int, int]:
                new = len({c for c in card.makes if (not scope or c in scope)} - have)
                return (-new, 1 if card.enters_slow else 0)

            chosen = min(lands, key=land_key)
            hand.remove(chosen)
            (pending if chosen.enters_slow else battlefield).append(chosen)

        # Mana available this turn: everything already online.
        available = sum(1 for c in battlefield if c.is_land or c.is_accelerant)

        # Cast one accelerant, cheapest first, if the mana is there. It arrives
        # tapped or sick, so it pays from next turn.
        affordable = sorted(
            (c for c in hand if c.is_accelerant and c.cmc <= available),
            key=lambda c: c.cmc,
        )
        if affordable:
            rock = affordable[0]
            hand.remove(rock)
            (pending if rock.enters_slow else battlefield).append(rock)
            if not rock.enters_slow:
                available += 1

        weights: Counter = Counter()
        for card in battlefield:
            for colour, share in _weighted(card.makes, scope).items():
                weights[colour] += share

        # A colour counts as "available" when the board can actually produce
        # it — one whole source's worth, however that source is split.
        variety = sum(1 for c in COLOURS if weights[c] >= 1.0)

        nonlands = [c for c in hand if not c.is_land]
        # Lands and accelerants are in play the moment they arrive, even when
        # they arrive tapped or sick. `pending` is about what can pay for
        # something this turn, not about where the permanent is: reporting a
        # tapped land as absent showed 0.53 lands on turn one against a 3%
        # missed-drop rate, which cannot both be true.
        in_play = battlefield + pending
        record.append({
            "lands": sum(1 for c in in_play if c.is_land),
            "mana": available,
            "colours": variety,
            "missed": missed,
            "hand_cmc": (sum(c.cmc for c in nonlands) / len(nonlands)) if nonlands else 0.0,
            "hand_size": len(hand),
            "accelerants": sum(1 for c in in_play if c.is_accelerant),
            "weights": weights,
            # Could the most expensive castable-looking spell in hand actually
            # be paid for this turn? A cheap proxy for "did the deck function".
            "on_curve": any(c.cmc <= available for c in nonlands) if nonlands else False,
        })

    return record


def simulate(
    conn: sqlite3.Connection,
    resolutions: list[Resolution],
    iterations: int = 1000,
    turns: int = 10,
    seed: int | None = None,
) -> dict[str, Any]:
    """Run `iterations` games and average what happened."""
    iterations = max(1, min(iterations, MAX_ITERATIONS))
    turns = max(1, min(turns, MAX_TURNS))

    library, scope = _build(conn, resolutions)
    if len(library) < 8:
        return {
            "empty": True,
            "reason": "Not enough resolved cards to shuffle a deck.",
        }

    rng = random.Random(seed)
    tallies = [TurnTally() for _ in range(turns)]
    # How many games missed a drop at all, and when the first one came.
    games_missing = 0
    first_miss_total = 0

    for _ in range(iterations):
        game = _play_one(library, scope, turns, rng)
        missed_this_game = None
        for index, turn in enumerate(game):
            tally = tallies[index]
            tally.lands += turn["lands"]
            tally.mana += turn["mana"]
            tally.colours += turn["colours"]
            tally.hand_cmc += turn["hand_cmc"]
            tally.hand_size += turn["hand_size"]
            tally.accelerants += turn["accelerants"]
            tally.castable_on_curve += 1 if turn["on_curve"] else 0
            for colour, share in turn["weights"].items():
                tally.per_colour[colour] += share
            if turn["missed"]:
                tally.missed += 1
                if missed_this_game is None:
                    missed_this_game = index + 1
        if missed_this_game is not None:
            games_missing += 1
            first_miss_total += missed_this_game

    def mean(total: float) -> float:
        return round(total / iterations, 2)

    return {
        "empty": False,
        "iterations": iterations,
        "turns": turns,
        "library_size": len(library),
        "commander_identity": "".join(c for c in COLOURS if c in scope),
        "games_missing_a_drop": round(games_missing / iterations, 4),
        "avg_first_missed_turn": round(first_miss_total / games_missing, 2) if games_missing else None,
        "by_turn": [
            {
                "turn": index + 1,
                "lands": mean(t.lands),
                "mana": mean(t.mana),
                "accelerants": mean(t.accelerants),
                "colours": mean(t.colours),
                "hand_size": mean(t.hand_size),
                "avg_cmc_in_hand": mean(t.hand_cmc),
                "missed_land_drop": round(t.missed / iterations, 4),
                "on_curve": round(t.castable_on_curve / iterations, 4),
                "sources": {
                    c: round(t.per_colour[c] / iterations, 2)
                    for c in COLOURS
                    if (not scope or c in scope) and t.per_colour[c]
                },
            }
            for index, t in enumerate(tallies)
        ],
    }
