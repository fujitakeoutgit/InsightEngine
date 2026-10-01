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
import type { ManaPool, ManaType } from './mana'

export type Zone = 'library' | 'hand' | 'battlefield' | 'graveyard' | 'exile' | 'command' | 'stack'

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
  /** A creature that has not been yours since your turn began: it cannot
   *  attack, or pay a cost with {T}. */
  sick?: boolean
  /** One of the deck's commanders — taxed when cast again, and sent home to
   *  the command zone rather than left in a graveyard. */
  commander?: boolean
  /** Created rather than dealt. Anywhere but the battlefield it ceases to
   *  exist. */
  token?: boolean
}

/** The turn, step by step (CR 500–514). Declare blockers is absent: the
 *  opponent has nothing to block with. */
export type Step =
  | 'untap' | 'upkeep' | 'draw'
  | 'main1'
  | 'combatBegin' | 'combatAttackers' | 'combatEnd'
  | 'main2'
  | 'end' | 'cleanup'

/** A spell waiting on the stack. */
export interface StackItem {
  id: string
  /** The spell's card, in the stack zone while it waits. */
  iid: string
  /** What X was chosen as when it was cast. */
  x: number
}

/** Something the engine cannot do for you yet, with the words to do it by. */
export interface Reminder {
  id: string
  iid: string
  name: string
  text: string
}

/** A choice the game is waiting on before anything else can happen. */
export type Decision =
  /** The opening hand: keep it, or shuffle it away for seven more. */
  | { kind: 'mulligan'; taken: number }
  /** After a mulligan, the cards that go to the bottom. */
  | { kind: 'bottom'; count: number }
  /** Cleanup, holding more than the maximum hand size. */
  | { kind: 'discard'; count: number }

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
  /** The next number for something the game creates — a token, a spell on
   *  the stack, a reminder. */
  serial: number

  /** Play by the rules. Off, the table is the free sandbox it always was:
   *  nothing is checked and nothing is paid. */
  rules: boolean
  step: Step
  pool: ManaPool
  /** Bottom first. */
  stack: StackItem[]
  landsPlayed: number
  pending: Decision | null
  reminders: Reminder[]
  /** Times each commander has been cast from the command zone — its tax. */
  casts: Record<string, number>
  /** Why the game was lost, once it has been. Play carries on regardless:
   *  this is a goldfish, and the turn you died on is worth knowing, not the
   *  end of the session. */
  lost: string | null
}

export type Action =
  /** A new game: shuffle, deal seven. */
  | { type: 'deal'; deck: readonly DeckCard[]; seed: number }
  | { type: 'draw'; count?: number }
  /** Sandbox: untap, then draw. */
  | { type: 'nextTurn' }
  /** Play from hand or the command zone. With the rules on a land is played
   *  and anything else is cast; off, permanents go straight down. */
  | { type: 'play'; iid: string; x?: number }
  /** Dropped on the mat at a particular spot. */
  | { type: 'place'; iid: string; at: Spot }
  /** Dropped on a pile, the hand or the library. */
  | { type: 'move'; iid: string; zone: Exclude<Zone, 'battlefield' | 'stack'> }
  /** Turn a permanent sideways or back, by hand. */
  | { type: 'tap'; iid: string }
  /** Tap a permanent for mana, which goes to the pool: its `ability`th mana
   *  ability, with `kinds` picking a kind for each mana it makes where it
   *  could make more than one. */
  | { type: 'mana'; iid: string; ability?: number; kinds?: ManaType[] }
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
  /** Pass priority. The opponent always passes too, so the top of the stack
   *  resolves — or, with the stack empty, the game moves on to the next
   *  step that needs you. */
  | { type: 'pass' }
  /** Keep passing until this step, resolving whatever is on the stack. The
   *  next one of these, which may be next turn's. */
  | { type: 'passTo'; step: Step }
  | { type: 'keep' }
  | { type: 'mulligan' }
  /** The cards answering a pending bottom or discard. */
  | { type: 'choose'; iids: string[] }
  /** Done resolving a reminder by hand. */
  | { type: 'done'; id: string }
  | { type: 'rules'; on: boolean }
