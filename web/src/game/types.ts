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
import type { Effect, TallyKey } from './compiler/ir'
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
  /** Counters on it, by kind: `'+1/+1'`, `'charge'`. Loyalty is kept apart,
   *  above, because a planeswalker's is set as it is dealt. */
  counters?: Record<string, number>
  /** Damage marked on it this turn. It wears off in cleanup. */
  damage?: number
  /** The permanent this Equipment or Aura is attached to. */
  attachedTo?: string
  /** When it was put into the graveyard, counted up from one: the highest
   *  is the top card there. */
  buried?: number
  /** The creature type chosen for it as it entered. */
  chosenType?: string
  /** Here for a while only: exiled as the end step begins, or as your next
   *  upkeep does. */
  fleeting?: 'end' | 'upkeep'
  /** Echo is still owed: asked for at your next upkeep. */
  echo?: boolean
  /** It stays tapped through your next untap step. */
  frozen?: boolean
  /** The card this is, while it is on the battlefield as a copy of another.
   *  `card` is then what it copies. */
  original?: Card
  /** What it was before it became a copy for a while, and when it stops
   *  being one: at cleanup, or as your next turn begins. */
  was?: Card
  revert?: 'end' | 'turn'
  /** In exile, and you may play it from there: through this turn — or,
   *  null, for as long as it stays. `free`, without paying its mana cost. */
  mayPlay?: { through: number | null; free?: boolean }
  /** The permanent whose ability exiled it: "a card exiled with ~". */
  exiledBy?: string
  /** The side chosen for it as it entered: Khans, or Dragons. */
  chosenMode?: string
  /** The turn it was put into the graveyard from the battlefield. */
  fell?: number
  /** If it is put into your graveyard this turn, it returns: Saffi. */
  returns?: { turn: number; by: string }
}

/** A change to size and keywords that lasts until end of turn, on the
 *  permanents it was given to. */
export interface TurnBoost {
  iids: string[]
  power: number
  toughness: number
  keywords: string[]
  /** Creature types they are as well, for the turn. */
  types?: string[]
  /** Every creature type, for the turn. */
  allTypes?: boolean
  /** Power and toughness in place of what is printed, for the turn. */
  base?: { power: number; toughness: number }
}

/** Power and toughness as they stood, for an effect that asks after the
 *  card has moved on — "it deals damage equal to its power", of a creature
 *  that just died. */
export interface Known {
  power: number
  toughness: number
  /** Its counters and mana value, for the effects that ask after those. */
  counters?: Record<string, number>
  manaValue?: number
}

/** Something that happened which cannot be read off the board before and
 *  after — a creature connived, you scried — kept until the abilities that
 *  watch for it have seen it. */
export type GameEvent =
  | { on: 'connives'; iid: string }
  | { on: 'scry' }
  | { on: 'level'; iid: string; level: number }
  /** A permanent that left and came straight back: it has entered, though
   *  it is on the battlefield before and after. */
  | { on: 'enters'; iid: string }

/** Counts kept over a turn, for the cards that ask what has happened in it. */
export type Tally = Record<TallyKey, number>

/** The turn, step by step (CR 500–514). Declare blockers is absent: the
 *  opponent has nothing to block with. */
export type Step =
  | 'untap' | 'upkeep' | 'draw'
  | 'main1'
  | 'combatBegin' | 'combatAttackers' | 'combatDamage' | 'combatEnd'
  | 'main2'
  | 'end' | 'cleanup'

/** The other side of the table: totals to bring down, and nothing else. */
export interface Opponent {
  life: number
  poison: number
  /** Combat damage taken from each commander, by its iid. */
  commander: Record<string, number>
}

/** A spell or a triggered ability waiting on the stack. */
export interface StackItem {
  id: string
  /** The spell's card, in the stack zone while it waits — or, for an
   *  ability, the permanent it came from. */
  iid: string
  /** What X was chosen as when it was cast. */
  x: number
  /** A copy of the spell rather than the spell: it resolves, and the card
   *  stays where it is. */
  copy?: boolean
  /** Set when this is a triggered ability rather than a spell. */
  ability?: {
    text: string
    effects: Effect[]
    complete: boolean
    /** The card the trigger is about, when it is about one. */
    event: string | null
    known: Record<string, Known>
    /** An amount the trigger is about: the damage that was dealt, for
     *  "create that many". */
    amount?: number
    /** What had been chosen when this was set up, for an ability that
     *  waited: "exile it at the beginning of the next end step". */
    chosen?: string[]
  }
}

/** An ability part-way through resolving: the game stops here whenever it
 *  needs an answer from you, and picks up from `at` once it has one. */
export interface Resolution {
  /** The card it came from. */
  source: string
  name: string
  /** The words, for the questions it asks. */
  text: string
  effects: Effect[]
  /** The next effect to carry out. */
  at: number
  x: number
  /** What the last `choose` picked. */
  chosen: string[]
  /** What an earlier one picked, set aside for an effect with two targets. */
  kept: string[]
  event: string | null
  known: Record<string, Known>
  /** The "you may" at `at` has been agreed to. */
  agreed: boolean
  /** The last "you may" was declined, so its "if you do" is skipped. */
  declined: boolean
  /** The modes taken so far, of a "choose one or more" still being asked. */
  modes: number[]
  /** Questions the effect at `at` has had answered, for one that asks more
   *  than one. */
  asked: number
  /** How many things the effect before this one acted on — "the number of
   *  creatures destroyed this way". */
  last: number
  /** A spell: its card goes to the graveyard when this is done. */
  spell: boolean
  /** Words left over for you to finish, when not all of it was understood. */
  leftover: string | null
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
  /** "You may …" */
  | { kind: 'confirm'; prompt: string }
  /** Cards to pick for an effect — a target on the battlefield, a land in
   *  your library, a creature in your graveyard. */
  | {
    kind: 'pick'
    prompt: string
    zone: 'battlefield' | 'library' | 'graveyard' | 'hand' | 'exile'
    options: string[]
    min: number
    max: number
    /** Cards looked at with the options that cannot be taken: the rest of
     *  the top five, shown so the choice is made knowing them. */
    seen?: string[]
    /** What the picked may add up to: each option's cost, and the most —
     *  or, with `min`, the least: the power it takes to crew a Vehicle. */
    budget?: { max: number; cost: Record<string, number>; of: string; min?: number }
  }
  /** "Choose a number between 0 and 10." */
  | { kind: 'number'; prompt: string; min: number; max: number }
  /** Scry or surveil: which of these stay on top. */
  | { kind: 'arrange'; mode: 'scry' | 'surveil'; cards: string[] }
  /** Declare attackers: which of these attack. */
  | { kind: 'attack'; options: string[] }
  /** "As ~ enters, choose a creature type": which, for this permanent. With
   *  `side` it is one of the card's own two names instead: Khans or Dragons. */
  | { kind: 'type'; iid: string; options: string[]; side?: boolean }
  /** Abilities that triggered together: the order they go on the stack in
   *  is yours to choose (CR 603.3b). These are their stack ids. */
  | { kind: 'order'; ids: string[] }
  /** "Choose one —". Where more than one may be chosen, they are taken one
   *  at a time: `taken` is what has been so far, and `canStop` whether that
   *  is enough to stop at. */
  | { kind: 'mode'; prompt: string; modes: string[]; taken: number[]; canStop: boolean }

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

  /** The other side of the table. Effects aimed at their permanents find
   *  none. */
  opponent: Opponent
  /** The creatures attacking, from when they are declared until combat
   *  ends. */
  attacking: string[]
  /** The creatures that dealt combat damage this step, once for each time
   *  they did — a double striker is here twice. */
  dealt: string[]
  /** How the opponent was beaten, once they have been. */
  won: string | null
  /** Extra land drops this turn, from effects that grant them. */
  extraLands: number
  /** The ability being carried out, while it waits on you. */
  resolving: Resolution | null
  /** Once-a-turn abilities that have had their turn's trigger. */
  triggered: string[]
  /** "Until end of turn" changes to size and keywords. Gone in cleanup. */
  boosts: TurnBoost[]
  /** An ability being activated, while its cost waits on a choice — what to
   *  sacrifice. */
  paying: { iid: string; index: number; x?: number } | null
  /** A spell being cast, while the game asks whether it is the one cast
   *  without paying this turn. */
  casting: { iid: string; x: number } | null
  /** Abilities waiting for the next end step to begin. */
  delayed: { iid: string; ability: NonNullable<StackItem['ability']> }[]
  /** Pictures for the tokens this deck makes, by name. */
  tokenArt: Record<string, string | null>
  /** What has happened that triggers have yet to be asked about. */
  events: GameEvent[]
  /** This turn's counts. */
  tally: Tally
  /** You have the city's blessing — had ten permanents with something that
   *  ascends — and keep it for the rest of the game. */
  blessing: boolean
  /** Turn 1 draws a card. Off, it is skipped, as the player who goes first
   *  in a two-player game skips theirs (CR 103.8a); in a multiplayer game
   *  nobody does (103.8c). */
  firstDraw: boolean
}

export type Action =
  /** A new game: shuffle, deal seven. */
  | { type: 'deal'; deck: readonly DeckCard[]; seed: number; tokens?: readonly DeckToken[] }
  | { type: 'draw'; count?: number }
  /** Sandbox: untap, then draw. */
  | { type: 'nextTurn' }
  /** Play from hand or the command zone — or from wherever else a card says
   *  it may be played. With the rules on a land is played and anything else
   *  is cast; off, permanents go straight down. `free` says whether this is
   *  the spell cast without paying, where one may be; unsaid, it is asked. */
  | { type: 'play'; iid: string; x?: number; free?: boolean }
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
  /** The cards answering a pending bottom, discard or pick. */
  | { type: 'choose'; iids: string[] }
  /** Yes or no, to a "you may". */
  | { type: 'confirm'; yes: boolean }
  /** Scry or surveil answered: what stays on top, in order, and what goes. */
  | { type: 'arrange'; keep: string[]; away: string[] }
  /** A mode taken — or, with -1, no more of them. */
  | { type: 'mode'; index: number }
  /** The creature type chosen for the permanent that is asking. */
  | { type: 'pickType'; subtype: string }
  /** The number chosen, for "choose a number". */
  | { type: 'number'; value: number }
  /** The order abilities that triggered together resolve in, first first. */
  | { type: 'order'; ids: string[] }
  /** Whether turn 1 has a draw step: it does in a multiplayer game. */
  | { type: 'firstDraw'; on: boolean }
  /** Add or remove counters by hand. */
  | { type: 'counter'; iid: string; counter: string; by: number }
  /** Set the opponent's life by hand. */
  | { type: 'opponentLife'; by: number }
  /** Declare these attackers — none, to attack with nothing. */
  | { type: 'attack'; iids: string[] }
  /** Activate a permanent's ability — or a card's, from hand: cycling. */
  | { type: 'activate'; iid: string; index: number; x?: number }
  /** Done resolving a reminder by hand. */
  | { type: 'done'; id: string }
  | { type: 'rules'; on: boolean }
