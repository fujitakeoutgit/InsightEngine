/**
 * Small operations on a game that every part of the engine needs: find a
 * card, move it, draw, shuffle, write to the record. Each takes a state and
 * returns a new one.
 */

import { shuffle } from './random'
import type { GameState, Instance, Spot, Zone } from './types'

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
      ...(zone !== 'battlefield' ? { sick: false } : {}),
      ...(loyalty !== null ? { loyalty } : {}),
      ...(at ?? {}),
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

export function draw(state: GameState, count: number): GameState {
  const drawn = inZone(state, 'library').slice(0, count).map((c) => c.iid)
  let next = state
  if (drawn.length) {
    const taking = new Set(drawn)
    const cards = state.cards.map((c) => (taking.has(c.iid) ? { ...c, zone: 'hand' as Zone } : c))
    next = noted({ ...state, cards, drawn }, drawn.length === 1 ? 'Drew a card' : `Drew ${drawn.length} cards`)
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
