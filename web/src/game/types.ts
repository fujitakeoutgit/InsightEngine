/**
 * The game, as data.
 *
 * Everything the table shows about a game in progress lives in one value,
 * changed only by `reduce` — so a game can be saved by keeping that value,
 * undone by keeping the ones before it, and tested without a browser. What is
 * merely on the table rather than in the game (the dice, the coin, which
 * dialog is open) stays in the component.
 */

import type { Card, DeckToken } from '../lib/api'
import type { DeckCard } from '../lib/deckModel'

export type Zone = 'library' | 'hand' | 'battlefield' | 'graveyard' | 'exile' | 'command'

/** A position on the mat, as fractions of its size, so the board survives a
 *  resize. */
export interface Spot { x: number; y: number }

export interface Instance {
  iid: string
  card: Card
  zone: Zone
  tapped: boolean
  /** Position on the playmat. Only meaningful on the battlefield. */
  x: number
  y: number
  /** Loyalty, for planeswalkers only. Seeded from the printed number when the
   *  game is built, so a walker arrives on the battlefield already carrying
   *  the counters it starts with rather than at zero. */
  loyalty?: number
}

export interface GameState {
  /** Every card in the game. A zone's order is the order of its cards here,
   *  which for the library is the order you will draw them in. */
  cards: Instance[]
  turn: number
  life: number
  /** Newest first, and capped — a record of the last few things, not the
   *  whole game. */
  log: string[]
  /** What the last draw put in hand. The table animates exactly these, and
   *  compares by identity, so an action that draws nothing leaves this
   *  untouched. */
  drawn: string[]
  /** The shuffler's state. See `random.ts`. */
  seed: number
  /** The next number for something the game creates rather than deals —
   *  a token. */
  serial: number
}

export type Action =
  /** A new game: shuffle, deal seven. */
  | { type: 'deal'; deck: readonly DeckCard[]; seed: number }
  | { type: 'draw'; count?: number }
  /** Untap, then draw. */
  | { type: 'nextTurn' }
  /** Play from hand or the command zone: instants and sorceries resolve to
   *  the graveyard, permanents are dealt where their type belongs. */
  | { type: 'play'; iid: string }
  /** Dropped on the mat at a particular spot. */
  | { type: 'place'; iid: string; at: Spot }
  /** Dropped on a pile, the hand or the library. */
  | { type: 'move'; iid: string; zone: Exclude<Zone, 'battlefield'> }
  | { type: 'tap'; iid: string }
  /** A fetch land, cracked for the card it found. */
  | { type: 'crack'; iid: string; pick: string }
  /** A card taken from the library into hand. */
  | { type: 'tutor'; iid: string }
  | { type: 'shuffle' }
  | { type: 'life'; by: number }
  | { type: 'loyalty'; iid: string; by: number }
  | { type: 'token'; token: DeckToken }
  /** A line for the record that changes nothing else — a die, the coin. */
  | { type: 'note'; line: string }
