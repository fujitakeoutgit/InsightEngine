/**
 * The game's rules, such as they are so far: every change to a game in
 * progress is an `Action` applied here.
 *
 * Pure — the same state and action always give the same next state — which is
 * what makes undo a list of earlier states and a test a list of actions. One
 * gesture at the table is one action, however many things it changes:
 * cracking a fetch plays a land, sacrifices the fetch and shuffles, and undo
 * has to take all of that back in one press.
 */

import type { Card } from '../lib/api'
import type { DeckCard } from '../lib/deckModel'
import { entersTapped } from '../lib/landTiming'
import { fetchFinds } from './fetch'
import { shuffle } from './random'
import { seatFor } from './seat'
import type { Action, GameState, Instance, Spot, Zone } from './types'

/** Lines the record keeps. Enough to answer "what just happened". */
const LOG_LIMIT = 40

/** A planeswalker's printed starting loyalty, or null if it is not one.
 *
 * Scryfall gives loyalty as a string because some of them are not numbers —
 * X on Chandra, Awakened Inferno, and the double-faced walkers that print it
 * on the back only. Those come back as 0 and are then yours to set. */
export function startingLoyalty(card: { type_line?: string | null; loyalty?: string | null }) {
  if (!/\bPlaneswalker\b/.test(card.type_line ?? '')) return null
  const printed = Number.parseInt(card.loyalty ?? '', 10)
  return Number.isFinite(printed) ? printed : 0
}

/** Expand quantities into individual copies. The sideboard and maybeboard
 *  never reach the table. */
function build(deck: readonly DeckCard[]): Instance[] {
  const out: Instance[] = []
  for (const entry of deck) {
    if (entry.section === 'sideboard' || entry.section === 'maybeboard') continue
    const loyalty = startingLoyalty(entry.card)
    for (let i = 0; i < entry.quantity; i += 1) {
      out.push({
        iid: `${entry.uid}-${i}`,
        card: entry.card,
        zone: entry.section === 'commander' ? 'command' : 'library',
        tapped: false,
        x: 0.5,
        y: 0.5,
        ...(loyalty !== null ? { loyalty } : {}),
      })
    }
  }
  return out
}

/** A new game: the library shuffled, seven in hand, the commander waiting. */
export function deal(deck: readonly DeckCard[], seed: number): GameState {
  const [everything, next] = shuffle(build(deck), seed)
  const library = everything.filter((c) => c.zone === 'library')
  const command = everything.filter((c) => c.zone === 'command')
  const hand = library.slice(0, 7).map((c) => ({ ...c, zone: 'hand' as Zone }))
  return {
    cards: [...command, ...hand, ...library.slice(7)],
    turn: 1,
    life: 40,
    log: ['New game — drew 7'],
    drawn: hand.map((c) => c.iid),
    seed: next,
    serial: 0,
  }
}

const noted = (state: GameState, line: string): GameState =>
  ({ ...state, log: [line, ...state.log].slice(0, LOG_LIMIT) })

const find = (state: GameState, iid: string) => state.cards.find((c) => c.iid === iid)

const inZone = (state: GameState, zone: Zone) => state.cards.filter((c) => c.zone === zone)

/** Move a card, keeping its place in the list — which, for the library, is
 *  its place in the deck. */
function relocate(
  cards: readonly Instance[], iid: string, zone: Zone, at?: Spot, tapped?: boolean,
): Instance[] {
  return cards.map((c) => {
    if (c.iid !== iid) return c
    /* Leaving the battlefield resets a planeswalker's loyalty to its printed
     * number. Counters do not travel with a card between zones — the walker
     * that comes back is a new object, and one returning from the graveyard
     * on three loyalty because that is where it died would be quietly wrong
     * every time. */
    const loyalty = zone !== 'battlefield' ? startingLoyalty(c.card) : null
    return {
      ...c,
      zone,
      tapped: zone === 'battlefield' ? (tapped ?? c.tapped) : false,
      ...(loyalty !== null ? { loyalty } : {}),
      ...(at ?? {}),
    }
  })
}

function draw(state: GameState, count: number): GameState {
  const drawn = inZone(state, 'library').slice(0, count).map((c) => c.iid)
  if (!drawn.length) return noted(state, 'Drew nothing — the library is empty')
  const taking = new Set(drawn)
  const cards = state.cards.map((c) => (taking.has(c.iid) ? { ...c, zone: 'hand' as Zone } : c))
  return noted({ ...state, cards, drawn }, drawn.length === 1 ? 'Drew a card' : `Drew ${drawn.length} cards`)
}

/** Reorder the library in place. The shuffled sequence is poured back into
 *  the slots library cards already occupy, so the other zones keep their
 *  order — the battlefield's is the order things were played. */
function shuffleLibrary(state: GameState): GameState {
  const [shuffled, seed] = shuffle(inZone(state, 'library'), state.seed)
  let next = 0
  return { ...state, seed, cards: state.cards.map((c) => (c.zone === 'library' ? shuffled[next++] : c)) }
}

/** What the board says about a land arriving now. */
function tapVerdict(state: GameState, inst: Instance) {
  return entersTapped(
    inst.card,
    inZone(state, 'battlefield').map((c) => c.card),
    inZone(state, 'hand').filter((c) => c.iid !== inst.iid).map((c) => c.card),
  )
}

/** Play a card: instants and sorceries resolve to the graveyard, permanents
 *  are dealt into the region their type belongs to. */
function play(state: GameState, iid: string, forceTapped = false, seat?: Spot): GameState {
  const inst = find(state, iid)
  if (!inst) return state

  // Instants and sorceries resolve and are done; they never sit on a
  // battlefield, and leaving one there inflates the board you are reading.
  if (/\b(Instant|Sorcery)\b/.test(inst.card.type_line ?? '')) {
    return noted({ ...state, cards: relocate(state.cards, iid, 'graveyard') }, `Cast ${inst.card.name}`)
  }

  /* Lands may arrive tapped, and which ones depends on the board you have
   * built by now: a check land coming down untapped on turn four is the whole
   * reason it is in the deck. `forceTapped` is a fetch land talking — "put it
   * onto the battlefield tapped" is an instruction from the card that found
   * it, and overrides what the land would have done under its own steam. */
  const verdict = tapVerdict(state, inst)
  const tapped = forceTapped || verdict.tapped
  const at = seat ?? seatFor(state.cards, inst)
  const cards = state.cards.map((c) => (
    c.iid === iid ? { ...c, zone: 'battlefield' as Zone, tapped, ...at } : c
  ))
  const because = forceTapped ? '' : verdict.why ? ` — ${verdict.why}` : ''
  return noted({ ...state, cards }, tapped
    ? `Played ${inst.card.name} tapped${because}`
    : `Played ${inst.card.name}${because}`)
}

/** Crack a fetch: the land it found arrives (tapped, if the fetch said so),
 *  the fetch itself is sacrificed, and the library is shuffled. */
function crack(state: GameState, iid: string, pick: string): GameState {
  const source = find(state, iid)
  const found = find(state, pick)
  const finds = source && fetchFinds(source.card)
  if (!source || !found || !finds) return state
  /* The land takes the square the fetch is vacating — but only when the
   * fetch actually leaves. One that taps instead of sacrificing is still
   * standing there, so the land is dealt a fresh square. */
  const seat = finds.sacrifices ? { x: source.x, y: source.y } : undefined
  let next = play(state, pick, finds.tapped, seat)
  if (finds.sacrifices) next = { ...next, cards: relocate(next.cards, iid, 'graveyard') }
  next = shuffleLibrary(next)
  return noted(next, `${source.card.name}: found ${found.card.name}${
    finds.sacrifices ? ', sacrificed' : ''}, then shuffled`)
}

export function reduce(state: GameState, action: Action): GameState {
  switch (action.type) {
    case 'deal':
      return deal(action.deck, action.seed)

    case 'draw':
      return draw(state, action.count ?? 1)

    case 'nextTurn': {
      const untapped = state.cards.map((c) => (
        c.zone === 'battlefield' && c.tapped ? { ...c, tapped: false } : c
      ))
      const drawn = draw({ ...state, cards: untapped, turn: state.turn + 1 }, 1)
      return noted(drawn, `Turn ${state.turn + 1}`)
    }

    case 'play':
      return play(state, action.iid)

    case 'place': {
      const inst = find(state, action.iid)
      if (!inst) return state
      /* A land dragged onto the mat obeys its own text exactly as a land
       * clicked in hand does — the same card on the same board must not come
       * down differently depending on the gesture. Only when it is arriving:
       * nudging a permanent already on the battlefield must not re-roll its
       * tapped state. */
      const verdict = inst.zone !== 'battlefield' ? tapVerdict(state, inst) : null
      const moved = { ...state, cards: relocate(state.cards, action.iid, 'battlefield', action.at, verdict?.tapped) }
      return verdict?.tapped
        ? noted(moved, `Played ${inst.card.name} tapped${verdict.why ? ` — ${verdict.why}` : ''}`)
        : moved
    }

    case 'move':
      return find(state, action.iid)
        ? { ...state, cards: relocate(state.cards, action.iid, action.zone) }
        : state

    case 'tap':
      return find(state, action.iid)
        ? { ...state, cards: state.cards.map((c) => (c.iid === action.iid ? { ...c, tapped: !c.tapped } : c)) }
        : state

    case 'crack':
      return crack(state, action.iid, action.pick)

    case 'tutor': {
      const found = find(state, action.iid)
      if (!found) return state
      // Searching your library shuffles it. Skipping that would leave the
      // order you just read still in place, which is not the same game.
      const moved = { ...state, cards: relocate(state.cards, action.iid, 'hand') }
      return noted(shuffleLibrary(moved), `Tutored ${found.card.name}, then shuffled`)
    }

    case 'shuffle':
      return noted(shuffleLibrary(state), 'Shuffled the library')

    case 'life':
      return { ...state, life: state.life + action.by }

    case 'loyalty':
      // Floored at zero: a walker on nought is already gone, and negative
      // loyalty is not a state the game has.
      return {
        ...state,
        cards: state.cards.map((c) => (
          c.iid === action.iid ? { ...c, loyalty: Math.max(0, (c.loyalty ?? 0) + action.by) } : c
        )),
      }

    case 'token': {
      /* Tokens are created, not drawn, so this adds an instance that was never
       * in the library. Each gets its own iid — a deck that makes six Soldiers
       * wants six cards on the mat, not one it has to remember is six — and
       * they land in the middle, to be dragged like anything else. */
      const { token } = action
      const card = {
        oracle_id: token.oracle_id,
        name: token.name,
        type_line: token.type_line,
        image_normal: token.image,
        image_small: token.image,
        mana_cost: null,
        color_identity: token.color_identity,
      } as unknown as Card
      const made: Instance = {
        iid: `token-${token.oracle_id}-${state.serial}`,
        card,
        zone: 'battlefield',
        tapped: false,
        x: 0.5,
        y: 0.5,
      }
      return noted({ ...state, serial: state.serial + 1, cards: [...state.cards, made] }, `Created ${token.name}`)
    }

    case 'note':
      return noted(state, action.line)
  }
}
