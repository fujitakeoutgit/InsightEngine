/**
 * Small operations on a game that every part of the engine needs: find a
 * card, move it, draw, shuffle, write to the record. Each takes a state and
 * returns a new one.
 */

import { compile } from './compiler/compile'
import { shuffle } from './random'
import type { GameEvent, GameState, Instance, Spot, Tally, Zone } from './types'

export const emptyTally = (): Tally =>
  ({ drawn: 0, discarded: 0, died: 0, left: 0, binned: 0, gained: 0, lost: 0, struck: 0 })

/** Note something for the abilities that watch for it. */
export const happen = (state: GameState, event: GameEvent): GameState =>
  ({ ...state, events: [...state.events, event] })

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

export const noted = (state: GameState, line: string): GameState =>
  ({ ...state, log: [line, ...state.log].slice(0, LOG_LIMIT) })

export const find = (state: GameState, iid: string) => state.cards.find((c) => c.iid === iid)

export const inZone = (state: GameState, zone: Zone) => state.cards.filter((c) => c.zone === zone)

/** A fresh id for something the game creates, and the state that has used it. */
export function mint(state: GameState, prefix: string): [string, GameState] {
  return [`${prefix}${state.serial}`, { ...state, serial: state.serial + 1 }]
}

/** Move a card, keeping its place in the list — which, for the library, is
 *  its place in the deck. */
export function relocate(
  cards: readonly Instance[], iid: string, zone: Zone, at?: Spot, tapped?: boolean,
): Instance[] {
  // The top of the graveyard is whatever went there last.
  const buried = zone === 'graveyard' ? Math.max(0, ...cards.map((c) => c.buried ?? 0)) + 1 : undefined
  return cards.map((c) => {
    if (c.iid !== iid) return c
    /* Leaving the battlefield resets a planeswalker's loyalty to its printed
     * number. Counters do not travel with a card between zones — the walker
     * that comes back is a new object, and one returning from the graveyard
     * on three loyalty because that is where it died would be quietly wrong
     * every time. */
    const loyalty = zone !== 'battlefield' ? startingLoyalty(c.original ?? c.was ?? c.card) : null
    // Nor does damage, or any other counter: off the battlefield it is a
    // card again, as printed.
    // …and a copy is itself again.
    const left = zone !== 'battlefield'
      ? {
          sick: false, counters: undefined, damage: undefined, attachedTo: undefined,
          chosenType: undefined, chosenMode: undefined, fleeting: undefined, echo: undefined, frozen: undefined,
          card: c.original ?? c.was ?? c.card, original: undefined, was: undefined, revert: undefined,
          revertBy: undefined, kicked: undefined,
        }
      : {}
    // What a card in exile was allowed, and by what, ends when it leaves.
    const moved = c.zone !== zone
      ? {
          mayPlay: undefined, exiledBy: undefined, fell: undefined, suspended: undefined, paradigm: undefined,
          discarded: undefined,
        }
      : {}
    return {
      ...c,
      zone,
      tapped: zone === 'battlefield' ? (tapped ?? c.tapped) : false,
      ...left,
      ...moved,
      ...(loyalty !== null ? { loyalty } : {}),
      ...(at ?? {}),
      buried: c.zone === 'graveyard' && zone === 'graveyard' ? c.buried : buried,
    }
  })
}

/** Move a card to the bottom of its new zone. The list's order is the zone's
 *  order, so that means the end of the list. */
export function toBottom(cards: readonly Instance[], iid: string, zone: Zone): Instance[] {
  const moving = relocate(cards, iid, zone).find((c) => c.iid === iid)
  if (!moving) return [...cards]
  return [...cards.filter((c) => c.iid !== iid), moving]
}

/** Teferi's Ageless Insight and its kind: each one doubles a draw. */
const drawDoublers = (state: GameState) => inZone(state, 'battlefield')
  .filter((c) => compile(c.card).statics.some((fixed) => fixed.kind === 'drawTwice')).length

/** What Abundance may have a draw look for instead. */
export const DRAWS_FIND = ['Land', 'Nonland']

/** Abundance, and what was chosen for it: each draw is instead a dig for
 *  the next card of that kind, the ones above it going to the bottom. */
function drawFinding(state: GameState, count: number, kind: string): GameState {
  let next = state
  const found: string[] = []
  for (let i = 0; i < count; i += 1) {
    const library = inZone(next, 'library')
    const at = library.findIndex((c) => /\bLand\b/.test(c.card.type_line ?? '') === (kind === 'Land'))
    const revealed = new Set((at < 0 ? library : library.slice(0, at)).map((c) => c.iid))
    const taken = at < 0 ? null : library[at]
    const cards = next.cards.map((c) => (c.iid === taken?.iid ? { ...c, zone: 'hand' as Zone } : c))
    if (taken) found.push(taken.iid)
    next = noted(
      { ...next, cards: [...cards.filter((c) => !revealed.has(c.iid)), ...cards.filter((c) => revealed.has(c.iid))] },
      taken
        ? `Abundance: ${taken.card.name} into your hand${revealed.size ? `, ${revealed.size} to the bottom` : ''}`
        : `Abundance: no ${kind.toLowerCase()} card left to find`,
    )
  }
  return found.length ? { ...next, drawn: found } : next
}

/** Draw cards. `first` is the draw step's own draw, which the cards that
 *  replace draws leave alone. */
export function draw(state: GameState, asked: number, first = false): GameState {
  const count = state.rules && !first ? asked * 2 ** drawDoublers(state) : asked
  const finding = state.rules
    ? inZone(state, 'battlefield').find((c) => (
      DRAWS_FIND.includes(c.chosenMode ?? '') && compile(c.card).statics.some((fixed) => fixed.kind === 'drawsFind')
    ))?.chosenMode
    : undefined
  if (finding) return drawFinding(state, count, finding)
  const drawn = inZone(state, 'library').slice(0, count).map((c) => c.iid)
  let next = state
  if (drawn.length) {
    const taking = new Set(drawn)
    const cards = state.cards.map((c) => (taking.has(c.iid) ? { ...c, zone: 'hand' as Zone } : c))
    const tally = { ...state.tally, drawn: state.tally.drawn + drawn.length }
    next = noted({ ...state, cards, drawn, tally }, drawn.length === 1 ? 'Drew a card' : `Drew ${drawn.length} cards`)
  }
  if (drawn.length === count) return next
  if (!state.rules) return drawn.length ? next : noted(state, 'Drew nothing — the library is empty')
  // Drawing from an empty library loses the game (CR 704.5b). Noted, and play
  // goes on: in a goldfish, the turn it happened is the finding.
  const lost = next.lost ?? `You drew from an empty library on turn ${state.turn}`
  return noted({ ...next, lost }, 'Tried to draw from an empty library')
}

/** Reorder the library in place. The shuffled sequence is poured back into
 *  the slots library cards already occupy, so the other zones keep their
 *  order — the battlefield's is the order things were played. */
export function shuffleLibrary(state: GameState): GameState {
  const [shuffled, seed] = shuffle(inZone(state, 'library'), state.seed)
  let next = 0
  return { ...state, seed, cards: state.cards.map((c) => (c.zone === 'library' ? shuffled[next++] : c)) }
}
