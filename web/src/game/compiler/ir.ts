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
  /** Color letters, any of: "blue" is `['U']`. */
  colors?: string[]
  colorless?: boolean
  /** Declared as an attacker this combat. */
  attacking?: boolean
  /** Untapped, or tapped. */
  tapped?: boolean
  /** "Of the chosen type": the creature type chosen for the permanent whose
   *  ability this is, as it entered. */
  chosenType?: boolean
  /** One of your commanders. */
  commander?: boolean
  nontoken?: boolean
  /** Not the source itself. */
  other?: boolean
  keyword?: string
  /** "with power 2 or less", "with mana value 3 or less" — or against an
   *  amount worked out when it is asked: "with mana value less than or equal
   *  to the number of lands you control". */
  compare?: { stat: 'power' | 'toughness' | 'manaValue'; op: '<=' | '>='; value: Count }
  /** Whose. The opponent has no permanents, so a phrase only theirs can
   *  match is one that finds nothing. */
  controller?: 'you' | 'opponent' | 'any'
}

/** Which card an amount is read off: what was chosen, the card the trigger
 *  is about, the source — or `each`, the permanent the effect is acting on,
 *  one at a time: "counters on each creature equal to that creature's
 *  toughness". */
export type Whose = 'chosen' | 'event' | 'self' | 'each'

/** A permanent's number, read off the one an effect refers to. `gap` is the
 *  difference between its power and its toughness. */
export interface Stat {
  stat: 'power' | 'toughness' | 'manaValue' | 'gap'
  of: Whose
}

/** How many. */
export type Count =
  | number
  /** X, as the spell was cast. */
  | 'X'
  /** One for each permanent matching — "for each creature you control". */
  | { per: Filter }
  | Stat
  /** The cards in your hand, or in your graveyard — all, or those matching. */
  | { zone: 'hand' | 'graveyard'; filter?: Filter }
  /** The counters of one kind on a permanent. */
  | { counters: string; of: Whose }
  /** "The total toughness of other creatures you control." */
  | { total: 'power' | 'toughness'; of: Filter }
  /** The colors among permanents you control. */
  | 'colors'
  /** Your life total. */
  | 'life'
  /** As many as the effect before this one acted on: "the number of
   *  creatures destroyed this way". */
  | 'thatMany'
  /** Something counted over the turn: the creatures that died, the life
   *  you gained. */
  | { tally: TallyKey }

/** What the game counts as a turn goes by, for the cards that ask. */
export type TallyKey =
  /** Cards drawn. */
  | 'drawn'
  | 'discarded'
  /** Creatures put into your graveyard from the battlefield. */
  | 'died'
  /** Permanents that left the battlefield. */
  | 'left'
  /** Creature cards put into your graveyard from anywhere. */
  | 'binned'
  /** Life gained, and lost. */
  | 'gained'
  | 'lost'

/** A change to power or toughness: a plain number, or an amount worked out
 *  as the effect happens — "-X/-X, where X is the sacrificed creature's
 *  toughness". */
export type Signed = number | { sign: 1 | -1; count: Count }

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
  /** What the source is attached to: "enchanted creature". */
  | { kind: 'host' }

/** How a copy differs from what it copies: "except it's a Spirit in addition
 *  to its other types and it isn't legendary". */
export interface CopyChange {
  /** Types it has as well: `['Spirit']`, `['Artifact']`. */
  types?: string[]
  keywords?: string[]
  notLegendary?: boolean
  /** "Except the token is 1/1." */
  pt?: string
  /** Text it has as well, as printed in quotes. */
  text?: string
  /** +1/+1 counters it arrives with, if it is a creature. */
  counters?: number
  /** Loyalty it arrives with on top of its own, if it is a planeswalker. */
  loyalty?: number
  /** It enters tapped, if it copies something. */
  tapped?: boolean
}

/** Something that is so or is not, as the game stands: what follows "if". */
export type Test =
  /** "If you control a Bird", "…three or more creatures". */
  | { control: Filter; atLeast: number }
  /** Threshold: this many cards in your graveyard. */
  | { graveyard: number }
  /** "If that land is a Forest", "if it's a creature card". */
  | { is: Filter; of: Whose }
  /** "If the creature had power 4 or greater." */
  | { stat: 'power' | 'toughness'; of: Whose; op: '>=' | '<='; value: number }
  /** "If ~ has five or more charge counters on it." */
  | { counters: string; of: Whose; atLeast: number }
  /** "If a permanent left the battlefield under your control this turn." */
  | { tally: TallyKey; atLeast: number }
  /** Every one of these. */
  | { all: Test[] }

/** A token, as described where it is created. */
export interface TokenSpec {
  name: string
  /** "1/1", or null for a noncreature. */
  pt: string | null
  /** Color letters, "G" or "WB"; empty for colorless. */
  colors: string
  typeLine: string
  keywords: string[]
  /** Rules text it is created with — a Treasure's, or what follows "It has"
   *  in quotes — compiled like any card's once it exists. */
  text?: string
}

/** A change to size and keywords, from a static ability or until end of
 *  turn. */
export interface Boost {
  power: number
  toughness: number
  keywords: string[]
  /** Counted once for each of these: "for each land you control", or for
   *  each color among your permanents. */
  per?: Filter | 'colors' | Measure
}

/** What a standing ability counts. */
export type Measure =
  | { per: Filter }
  | { devotion: string }
  /** Cards in your graveyard or hand: "each land card in your graveyard". */
  | { zone: 'hand' | 'graveyard'; filter?: Filter }
  /** Several of these, added up. */
  | { plus: Measure[] }

export type Effect = (
  /** Pick permanents for the effects after it. A target may be declined —
   *  nobody has to aim removal at their own board — but `must` is a cost or
   *  an instruction, like sacrificing a land, and is not optional. */
  | { op: 'choose'; filter: Filter; count: number; upTo: boolean; must?: boolean; zone?: 'graveyard' }
  | { op: 'draw'; count: Count }
  | { op: 'life'; who: 'you' | 'opponent'; sign: 1 | -1; count: Count }
  | { op: 'damage'; to: Aim; count: Count }
  | { op: 'scry'; count: Count }
  | { op: 'surveil'; count: Count }
  | { op: 'mill'; count: Count }
  /** `size` is for a token printed as X/X: how big, worked out as it is
   *  made. */
  | { op: 'token'; count: Count; token: TokenSpec; tapped: boolean; size?: Count; fleeting?: boolean }
  /** Tokens that are copies of a card. `fleeting` ones are exiled as the
   *  end step begins. */
  | { op: 'copy'; of: Aim; count: Count; change: CopyChange; tapped: boolean; fleeting: boolean }
  /** A permanent arrives — as a copy of what was chosen, if anything was. */
  | { op: 'enterAs'; change: CopyChange }
  | { op: 'counters'; to: Aim; count: Count; counter: string }
  /** Connive: draw a card, then discard a card; if it was not a land, a
   *  +1/+1 counter on the creature that connived. */
  | { op: 'connive'; who: Aim }
  /** One more of each kind of counter already there, on everything of yours
   *  that has any — and a poison counter for an opponent who has one. */
  | { op: 'proliferate' }
  /** Search your library. */
  | {
    op: 'search'
    filter: Filter
    count: Count
    upTo: boolean
    to: 'hand' | 'battlefield' | 'top'
    tapped: boolean
    /** Cultivate: the first found goes `to`, the rest into your hand. */
    restToHand?: boolean
  }
  /** The top card of your library, looked at. If it is what the card wants
   *  (`match`) it goes where `hit` says — asked first, when it is a "you
   *  may". Anything else, or a card you turned down, goes where `miss` says,
   *  which may be a question of its own: Coiling Oracle, Into the Wilds,
   *  Parcelbeast, Cabaretti Ascendancy. */
  | {
    op: 'topCard'
    match: Filter
    hit: 'battlefield' | 'hand'
    tapped: boolean
    ask: boolean
    miss: 'hand' | 'stay' | 'bottom' | 'graveyard'
    missAsk: boolean
  }
  /** Look at the top cards of your library and take some: all that match,
   *  or up to a number of them. The rest go where the card says. */
  | {
    op: 'dig'
    count: Count
    /** What may be taken; null for any card. */
    take: Filter | null
    takeCount: number | 'all'
    /** "You may": fewer than `takeCount`, or none, is allowed. */
    upTo: boolean
    to: 'hand' | 'battlefield'
    tapped: boolean
    rest: 'bottom' | 'graveyard' | 'top'
  }
  /** Reveal cards from the top until one matches; it goes `to`, the others
   *  to `rest`. */
  | { op: 'digUntil'; filter: Filter; to: 'hand' | 'battlefield'; rest: 'bottom' | 'graveyard' }
  /** Put cards from your hand on top of your library, the first on top. */
  | { op: 'putBack'; count: number }
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
  /** "Gets +3/+3 and gains trample until end of turn." */
  | { op: 'boost'; to: Aim; power: Signed; toughness: Signed; keywords: string[] }
  /** Attach the source — an Equipment, an Aura — to what was chosen. */
  | { op: 'attach' }
  /** Discard from your hand: your choice of which. */
  | { op: 'discard'; count: Count }
  /** Pay mana, as part of an effect: "you may pay {1}. If you do, …". Paid
   *  the way a spell is; if it cannot be, it counts as declined. */
  | { op: 'pay'; cost: string }
  /** "Choose one —": the modes, each its own little ability. "Choose one
   *  or more" and "choose up to one" set how few and how many. */
  | { op: 'mode'; modes: Ability[]; min: number; max: number }
  /** One outcome or another: "If that land is a Forest, put two counters on
   *  it instead." */
  | { op: 'if'; test: Test; then: Effect[]; otherwise: Effect[] }
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
  /** "Whenever equipped creature dies": what this is attached to. */
  | { on: 'dies'; who: 'attached' }
  | { on: 'dies'; who: Filter }
  /** `main` is the first main phase. */
  | { on: 'step'; step: 'upkeep' | 'main' | 'combat' | 'end' }
  /** "Whenever ~ attacks", "whenever a creature you control attacks". */
  | { on: 'attacks'; who: 'self' | 'attached' | Filter }
  /** "Whenever you attack": once, however many attack. */
  | { on: 'attack' }
  /** "Whenever ~ deals combat damage to a player". */
  | { on: 'combatDamage'; who: 'self' | Filter }
  | { on: 'cast'; filter: Filter }
  /** "Whenever you gain life". */
  | { on: 'lifeGain' }
  /** "Whenever a player plays a land" — played, not put onto the battlefield. */
  | { on: 'landPlay' }
  /** "Whenever you draw a card" — or, with `nth`, "your second card each
   *  turn". */
  | { on: 'draw'; nth?: number }
  /** "Whenever you discard a card", and cycling one is discarding it. */
  | { on: 'discard'; filter?: Filter }
  /** "Whenever ~ becomes tapped." */
  | { on: 'tapped' | 'untapped'; who: 'self' }
  /** "Whenever you scry or surveil." */
  | { on: 'scry' }
  /** "Whenever a creature you control connives." */
  | { on: 'connives'; who: 'self' | Filter }

export interface TriggeredAbility extends Ability {
  when: TriggerEvent
  /** "…, if you control five or more lands, …": checked as it triggers. */
  condition?: Test
  /** "This ability triggers only once each turn." */
  oncePerTurn?: boolean
  /** "Whenever one or more …": once, however many did it together. */
  batch?: boolean
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
  /** "Blue spells you cast cost {1} less to cast." Generic mana — or, for
   *  Morophon, one colored mana of each of `colored`. */
  | { kind: 'costLess'; filter: Filter; amount: number; colored?: string }
  /** "As ~ enters, choose a creature type." */
  | { kind: 'chooseType' }
  /** "~ is the chosen type in addition to its other types." */
  | { kind: 'isChosenType' }
  /** "Creatures you control are every creature type." */
  | { kind: 'everyCreatureType' }
  /** "This spell costs {1} less to cast for each creature on the
   *  battlefield", "…if you control a Spirit": on the spell itself. */
  | { kind: 'selfCostLess'; amount: number; per?: Filter; when?: Test }
  /** "You may have ~ enter as a copy of any creature on the battlefield." */
  | { kind: 'enterAsCopy'; filter: Filter; change: CopyChange }
  /** "If you would draw a card except the first one you draw in each of
   *  your draw steps, draw two cards instead." */
  | { kind: 'drawTwice' }
  /** "At the beginning of each player's draw step, that player draws an
   *  additional card." */
  | { kind: 'extraDraw'; count: number }
  /** "Each creature you control assigns combat damage equal to its
   *  toughness rather than its power." */
  | { kind: 'toughnessDamage' }
  /** "Creatures you control can attack as though they didn't have defender." */
  | { kind: 'defendersAttack' }
  /** "Creatures you control get +1/+1", "~ gets +1/+1 for each land you
   *  control", "equipped creature has haste": a standing change to size and
   *  keywords, for itself, what it is attached to, or everything matching. */
  | { kind: 'boost'; to: 'self' | 'attached' | Filter; boost: Boost; condition?: { atLeast: number; filter: Filter } }
  /** "~'s power and toughness are each equal to the number of lands you
   *  control": what it is in place of the `*` it prints. */
  | { kind: 'size'; stats: ('power' | 'toughness')[]; plus: number; measure: Measure }

/** What an ability costs to activate, beyond tapping. */
export interface AbilityCost {
  /** A mana cost, as printed: `{2}{G}`. */
  mana: string | null
  tap: boolean
  life: number
  /** Sacrifice the permanent itself. */
  sacrificeSelf: boolean
  /** Sacrifice something else: "a creature", "another creature". */
  sacrifice: Filter | null
  /** Discard this card — cycling, from hand. */
  discardSelf: boolean
  /** Counters taken off the permanent. */
  remove: { counter: string; count: number } | null
  /** Counters put on it: Wall of Roots' -0/-1. */
  add: { counter: string; count: number } | null
  /** Tap another untapped permanent of yours: "tap an untapped legendary
   *  creature you control". */
  tapOther: Filter | null
  /** Loyalty added (or, negative, removed): a planeswalker's ability. */
  loyalty: number | null
}

export interface ActivatedAbility extends Ability {
  cost: AbilityCost
  /** Only when a sorcery could be cast. Loyalty abilities and Equip are. */
  sorcery: boolean
  oncePerTurn: boolean
  /** Activated from your hand rather than the battlefield: cycling. */
  fromHand: boolean
  /** A mana ability with a cost beyond {T}: it resolves at once, into the
   *  pool, and never touches the stack (CR 605). */
  mana: ManaType[][] | null
}

/** How much of a card the engine carries out for you. */
export type Coverage = 'auto' | 'partial' | 'manual'

export interface Compiled {
  /** What resolving an instant or sorcery does. */
  spell: Ability | null
  triggers: TriggeredAbility[]
  activated: ActivatedAbility[]
  /** What an Aura enchants: "Enchant creature". */
  enchant: Filter | null
  statics: Static[]
  /** Lines nothing reads yet, as printed. */
  unread: string[]
  coverage: Coverage
}
