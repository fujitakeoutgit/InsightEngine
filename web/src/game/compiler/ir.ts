/**
 * The effect IR: what a card's text compiles to, and what the engine runs.
 *
 * Small on purpose. Each shape here is one the interpreter knows how to carry
 * out, so adding a pattern to the compiler means producing one of these — and
 * a sentence that produces none stays in words, for you to do by hand.
 *
 * Targets are an explicit step. "Destroy target creature" compiles to a
 * `choose` and then a `move` of what was chosen, so an effect that refers
 * back — "its controller gains life equal to its power" — reads the same
 * choice rather than asking again.
 */

import type { ManaType } from '../mana'

/** Which permanents or cards a phrase means: "creature you control",
 *  "basic land", "another nontoken creature with power 2 or less". Every
 *  field narrows. */
export interface Filter {
  /** Card types, any of: `['creature']`, `['artifact', 'enchantment']`. */
  types?: string[]
  /** Card types it must not have: "nonland" is `['land']`. */
  not?: string[]
  /** Subtypes, any of: `['Forest']`, `['Plant']`. */
  subtypes?: string[]
  /** Subtypes it must not have: "non-Spirit". */
  notSubtypes?: string[]
  basic?: boolean
  nontoken?: boolean
  /** Not the source itself. */
  other?: boolean
  keyword?: string
  /** "with power 2 or less", "with mana value 3 or less". */
  compare?: { stat: 'power' | 'toughness' | 'manaValue'; op: '<=' | '>='; value: number }
  /** Whose. The opponent has no permanents, so a phrase only theirs can
   *  match is one that finds nothing. */
  controller?: 'you' | 'opponent' | 'any'
}

/** A permanent's number, read off the one an effect refers to. */
export interface Stat {
  stat: 'power' | 'toughness'
  /** What was chosen; the card the trigger is about; the source. */
  of: 'chosen' | 'event' | 'self'
}

/** How many. */
export type Count =
  | number
  /** X, as the spell was cast. */
  | 'X'
  /** One for each permanent matching — "for each creature you control". */
  | { per: Filter }
  | Stat

/** Who or what an effect is aimed at. */
export type Aim =
  /** The source itself — "~". */
  | { kind: 'self' }
  | { kind: 'you' }
  /** The virtual opponent: "each opponent", "target opponent", "any target",
   *  and a target player when the effect is a harmful one. */
  | { kind: 'opponent' }
  /** What the last `choose` picked. */
  | { kind: 'chosen' }
  /** The card a trigger is about: "it" in "whenever a creature enters, it
   *  deals damage". */
  | { kind: 'event' }
  /** Every permanent matching. */
  | { kind: 'each'; filter: Filter }

/** A token, as described where it is created. */
export interface TokenSpec {
  name: string
  /** "1/1", or null for a noncreature. */
  pt: string | null
  /** Color letters, "G" or "WB"; empty for colorless. */
  colors: string
  typeLine: string
  keywords: string[]
}

export type Effect = (
  /** Pick permanents for the effects after it. A target may be declined —
   *  nobody has to aim removal at their own board — but `must` is a cost or
   *  an instruction, like sacrificing a land, and is not optional. */
  | { op: 'choose'; filter: Filter; count: number; upTo: boolean; must?: boolean }
  | { op: 'draw'; count: Count }
  | { op: 'life'; who: 'you' | 'opponent'; sign: 1 | -1; count: Count }
  | { op: 'damage'; to: Aim; count: Count }
  | { op: 'scry'; count: Count }
  | { op: 'surveil'; count: Count }
  | { op: 'mill'; count: Count }
  | { op: 'token'; count: Count; token: TokenSpec; tapped: boolean }
  | { op: 'counters'; to: Aim; count: Count; counter: string }
  /** Search your library. */
  | {
    op: 'search'
    filter: Filter
    count: number
    upTo: boolean
    to: 'hand' | 'battlefield' | 'top'
    tapped: boolean
    /** Cultivate: the first found goes `to`, the rest into your hand. */
    restToHand?: boolean
  }
  /** The top card of your library, revealed: a land goes one way, anything
   *  else another — Coiling Oracle, Into the Wilds. */
  | { op: 'topCard'; land: 'battlefield' | 'hand' | 'stay'; other: 'hand' | 'stay'; ask: boolean }
  /** Put a card from your hand onto the battlefield — a land, usually. */
  | { op: 'fromHand'; filter: Filter; count: number; upTo: boolean; tapped: boolean }
  /** Move permanents: destroy, exile, return to hand, sacrifice. */
  | { op: 'move'; what: Aim; to: 'graveyard' | 'exile' | 'hand' }
  /** Return cards from your graveyard. */
  | { op: 'reanimate'; filter: Filter; count: number; upTo: boolean; to: 'hand' | 'battlefield' }
  | { op: 'untap'; what: Aim }
  | { op: 'tap'; what: Aim }
  | { op: 'extraLand'; count: number }
  | { op: 'addMana'; makes: ManaType[][] }
  /** Pay mana, as part of an effect: "you may pay {1}. If you do, …". Paid
   *  the way a spell is; if it cannot be, it counts as declined. */
  | { op: 'pay'; cost: string }
  /** "Choose one —": the modes, each its own little ability. */
  | { op: 'mode'; modes: Ability[] }
  /** Understood, and does nothing at this table: the opponent has no hand,
   *  no graveyard, no spells to counter. Said in the log, so it is clear the
   *  sentence was read rather than skipped. */
  | { op: 'nothing'; why: string }
) & {
  /** "You may …": asked before it happens. */
  optional?: boolean
  /** "If you do, …": skipped when the "you may" before it was declined. */
  ifDone?: boolean
}

export interface Ability {
  /** The words it was compiled from, as printed. */
  text: string
  effects: Effect[]
  /** Every sentence was understood. When false, the ability still runs what
   *  was understood, and its words are posted for you to finish. */
  complete: boolean
}

export type TriggerEvent =
  | { on: 'enters'; who: 'self' }
  | { on: 'enters'; who: Filter }
  | { on: 'dies'; who: 'self' }
  | { on: 'dies'; who: Filter }
  | { on: 'step'; step: 'upkeep' | 'end' }
  | { on: 'cast'; filter: Filter }
  /** "Whenever you gain life". */
  | { on: 'lifeGain' }
  /** "Whenever a player plays a land" — played, not put onto the battlefield. */
  | { on: 'landPlay' }

export interface TriggeredAbility extends Ability {
  when: TriggerEvent
  /** "…, if you control five or more lands, …": checked as it triggers. */
  condition?: { atLeast: number; filter: Filter }
  /** "This ability triggers only once each turn." */
  oncePerTurn?: boolean
}

export type Static =
  /** "You may play an additional land on each of your turns." */
  | { kind: 'extraLand'; count: number }
  /** "~ enters with N +1/+1 counters on it." */
  | { kind: 'entersWithCounters'; counter: string; count: Count }
  /** "If you would gain life, you gain twice that much life instead." */
  | { kind: 'doubleLifeGain' }
  /** "You have no maximum hand size." */
  | { kind: 'noMaxHandSize' }

/** How much of a card the engine carries out for you. */
export type Coverage = 'auto' | 'partial' | 'manual'

export interface Compiled {
  /** What resolving an instant or sorcery does. */
  spell: Ability | null
  triggers: TriggeredAbility[]
  statics: Static[]
  /** Lines nothing reads yet, as printed. */
  unread: string[]
  coverage: Coverage
}
