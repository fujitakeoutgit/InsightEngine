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
  /** Card types it must have as well: an "artifact creature" is a creature
   *  that is also an artifact. */
  also?: string[]
  /** Any one of these: "creature or Vehicle", a type on one side and a
   *  subtype on the other, which `types` and `subtypes` together cannot say. */
  either?: Filter[]
  /** Card types it must not have: "nonland" is `['land']`. */
  not?: string[]
  /** Subtypes, any of: `['Forest']`, `['Plant']`. */
  subtypes?: string[]
  /** Subtypes it must not have: "non-Spirit". */
  notSubtypes?: string[]
  basic?: boolean
  /** A token. */
  token?: boolean
  /** "That shares a creature type with it": with the card the ability is
   *  about, what this is attached to, this card itself — or `yours`, any
   *  creature you control. Worked out into `subtypes` as it is asked. */
  sharesType?: 'it' | 'host' | 'self' | 'yours'
  /** Color letters, any of: "blue" is `['U']`. */
  colors?: string[]
  colorless?: boolean
  /** Declared as an attacker this combat. */
  attacking?: boolean
  /** Untapped, or tapped. */
  tapped?: boolean
  /** The only attacker: "that's attacking alone". */
  alone?: boolean
  /** "Of the chosen type": the creature type chosen for the permanent whose
   *  ability this is, as it entered. */
  chosenType?: boolean
  /** "That aren't of the chosen type." */
  notChosenType?: boolean
  /** One of your commanders — or, false, anything but: "except for
   *  commanders". */
  commander?: boolean
  /** "Named ~": the same name as the permanent whose ability this is. */
  sameName?: boolean
  /** A name, exactly. What `sameName` becomes once it is known whose. */
  name?: string
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
export type Whose = 'chosen' | 'event' | 'self' | 'each' | 'kept'

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
  /** The difference between two cards' numbers: "between that spell's mana
   *  value and that nonland card's mana value". */
  | { between: [Stat, Stat] }

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
  /** Times an Assassin or a commander of yours dealt combat damage to a
   *  player: what freerunning asks after. */
  | 'struck'

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
  /** What an earlier `choose` picked and `keep` set aside, for an effect
   *  with two targets. */
  | { kind: 'kept' }
  /** Every permanent matching that was not chosen: "sacrifices all other
   *  creatures". */
  | { kind: 'others'; filter: Filter }
  /** The cards the source has exiled: "a card exiled with ~". */
  | { kind: 'exiled' }
  /** One card, by its id: worked out as the effect before it happened. */
  | { kind: 'one'; iid: string }

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
  /** Counters of other kinds it arrives with: a shield counter. */
  enterWith?: Record<string, number>
  /** "Except it has this ability": it keeps the ability that made it a
   *  copy. */
  keepAbility?: boolean
  /** "Except his name is ~": it keeps the name it had. */
  keepName?: boolean
  /** Color letters it is instead: an embalmed token is white. */
  colors?: string
  /** "…has no mana cost." */
  noCost?: boolean
  /** "…and he's a legendary Human Mercenary Villain creature": its type
   *  line, whatever the copied card's was. */
  typeLine?: string
}

/** What a permanent is once it has lost everything else: its type line,
 *  less any supertypes, and the one ability it is left with. */
export interface Plain { typeLine: string; text: string; colorless?: boolean }

/** Something that is so or is not, as the game stands: what follows "if". */
export type Test =
  /** "If you control a Bird", "…three or more creatures". */
  | { control: Filter; atLeast: number }
  /** Threshold: this many cards in your graveyard — or this many of a
   *  kind, for spell mastery's instants and sorceries. */
  | { graveyard: number; filter?: Filter }
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
  /** That this is not so. */
  | { not: Test }
  /** "You control three or more creatures that share a creature type." */
  | { sharedType: number }
  /** "If three or more cards have been exiled with ~." */
  | { exiled: number }
  /** "If you have a full party": this many creatures in it. */
  | { party: number }
  /** "If ~ was kicked", "if its additional cost was paid", "if a Dragon was
   *  beheld": the spell was cast with the cost that is asked about. */
  | { kicked: true }

/** A limit on a pick, by what the picked add up to. */
export interface Budget { stat: 'power' | 'toughness'; max: number }

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
  /** Counters of one kind on permanents with a name: the slime counters on
   *  Gutter Grime, for the Oozes it makes. */
  | { counters: string; named: string }
  /** Cards in your graveyard or hand: "each land card in your graveyard". */
  | { zone: 'hand' | 'graveyard'; filter?: Filter }
  /** Several of these, added up. */
  | { plus: Measure[] }

export type Effect = (
  /** Pick permanents for the effects after it. A target may be declined —
   *  nobody has to aim removal at their own board — but `must` is a cost or
   *  an instruction, like sacrificing a land, and is not optional. */
  | {
    op: 'choose'
    filter: Filter
    count: number
    upTo: boolean
    must?: boolean
    /** Cards in your graveyard rather than permanents — or, in exile, the
     *  ones the source put there. */
    zone?: 'graveyard' | 'exile'
    /** A party: at most one each of Cleric, Rogue, Warrior and Wizard. */
    party?: boolean
    /** Not the card the ability is about: "another target creature", of a
     *  creature something was just attached to. */
    apart?: 'event'
    /** "…or creature card in a graveyard": those as well. */
    orGraveyard?: boolean
    /** Picked, not aimed at: "untap up to three lands" targets nothing, and
     *  nothing that watches for being targeted sees it. */
    untargeted?: boolean
    /** "With total power 4 or less": what the ones picked may add up to. */
    budget?: Budget
  }
  /** Exile cards from the top of your library: they are what was chosen,
   *  for what the card says of them next. */
  | { op: 'exileTop'; count: Count }
  /** Exile cards from the top of your library until one matches: that one
   *  is what was chosen. */
  | { op: 'exileUntil'; filter: Filter }
  /** Cast a copy of the source, from where it waits in exile: paradigm. */
  | { op: 'castCopy' }
  /** Cards in exile that you may play, for a while: this turn, through the
   *  end of your next, or for as long as they stay there — `free`, without
   *  paying their mana costs. */
  | {
    op: 'mayPlay'; who: Aim; until: 'end' | 'nextEnd' | 'exiled'; free?: boolean
    /** Plotted: not this turn, and only when a sorcery could be cast. */
    plotted?: boolean
  }
  /** "You may cast a spell from your hand without paying its mana cost" —
   *  or any number, from among the cards just exiled; what is not cast is
   *  what stays chosen. */
  | { op: 'castFree'; from: 'hand' | 'chosen' | 'event'; filter: Filter; count: number; haste?: boolean }
  /** The cards the source has exiled leave exile — all but the one the
   *  ability is about, with `except`. */
  | { op: 'unexile'; to: 'graveyard' | 'battlefield'; except?: boolean }
  /** "Choose a number between 0 and 10": it is X for the rest. */
  | { op: 'number'; min: number; max: number }
  /** Exile, and return at once: it arrives as a new permanent. */
  | { op: 'flicker'; what: Aim }
  /** "It doesn't untap during its controller's next untap step." */
  | { op: 'freeze'; what: Aim }
  /** A card at random from your library that matches, into your hand —
   *  `prevalent`, of the commonest creature type there. No shuffle. */
  | { op: 'seek'; filter: Filter; prevalent?: boolean }
  /** The source returns from your graveyard to the battlefield: persist,
   *  with a -1/-1 counter. */
  | { op: 'revive'; counter?: string }
  | { op: 'draw'; count: Count }
  | { op: 'life'; who: 'you' | 'opponent'; sign: 1 | -1; count: Count }
  | { op: 'damage'; to: Aim; count: Count }
  | { op: 'scry'; count: Count }
  | { op: 'surveil'; count: Count }
  | { op: 'mill'; count: Count }
  /** `size` is for a token printed as X/X: how big, worked out as it is
   *  made. */
  | {
    op: 'token'; count: Count; token: TokenSpec; tapped: boolean; size?: Count; fleeting?: boolean
    /** "…then attach this to it": the Equipment that made it goes on it. */
    equip?: boolean
  }
  /** Tokens that are copies of a card. `fleeting` ones are exiled as the
   *  end step begins. */
  | { op: 'copy'; of: Aim; count: Count; change: CopyChange; tapped: boolean; fleeting: boolean; attacking?: boolean }
  /** A permanent arrives — as a copy of what was chosen, if anything was. */
  | { op: 'enterAs'; change: CopyChange }
  /** A mutating creature spell merges with the creature chosen: `over` it,
   *  and that creature becomes this one with the abilities of both; or under
   *  it, and it stays what it is and gains this one's. */
  | { op: 'merge'; over: boolean }
  /** Set what was chosen aside, so the next `choose` can pick something
   *  else and both be spoken of. */
  | { op: 'keep' }
  /** Permanents become copies of what was chosen — for good, until end of
   *  turn, until your next turn, for as long as the source stays attached
   *  to them, or for as long as it stays on the battlefield. */
  | { op: 'become'; who: Aim; change: CopyChange; until?: 'end' | 'turn' | 'attached' | 'source' }
  /** Permanents lose what they were and are this instead: a plain land, a
   *  Treasure. Their name and supertypes stay. */
  | { op: 'transform'; who: Aim; to: Plain; until?: 'attached' | 'source' }
  /** "Copy that spell": a permanent spell's copy arrives as a token; any
   *  other resolves a second time. */
  | { op: 'copySpell' }
  /** Permanents become something else while staying what they are: a land
   *  that is a 2/2 Elemental creature as well, a Vehicle that is a creature
   *  until end of turn. The change is to the card they already are. */
  | { op: 'animate'; who: Aim; change: CopyChange; until?: 'end' | 'turn' }
  /** "You get an emblem with …": its words, standing for the rest of the
   *  game. */
  | { op: 'emblem'; text: string }
  /** Put cards onto the battlefield from wherever they are — `attach`ed to
   *  the card the ability is about: an Aura coming back to its creature. */
  | { op: 'put'; what: Aim; tapped?: boolean; attach?: boolean }
  /** "…at the beginning of the next end step": these, then. */
  | { op: 'later'; effects: Effect[] }
  /** "When target creature is put into your graveyard this turn, return
   *  that card to the battlefield": marked now, returned if it dies. */
  | { op: 'saveFromGrave'; who: Aim }
  /** "Choose a creature type", of a spell as it resolves: asked, and what
   *  the spell goes on to call "the chosen type". */
  | { op: 'pickType' }
  /** "Until end of turn, whenever a Serpent attacks, draw a card": an
   *  ability that is there for the turn. */
  | { op: 'untilEnd'; when: TriggerEvent[]; effects: Effect[]; text: string }
  /** "There is an additional beginning phase after this phase": untap,
   *  upkeep and draw, once more. */
  | { op: 'extraBeginning' }
  /** The choice made for the source as it entered is asked again. */
  | { op: 'rechoose' }
  /** Cards shuffled into your library: the permanents aimed at, or whole
   *  zones — "shuffle your graveyard and hand into your library". */
  | { op: 'shuffleIn'; what?: Aim; zones?: ('graveyard' | 'hand')[] }
  | { op: 'counters'; to: Aim; count: Count; counter: string }
  /** Connive: draw a card, then discard a card; if it was not a land, a
   *  +1/+1 counter on the creature that connived. "Connives X" is that many
   *  of each. */
  | { op: 'connive'; who: Aim; count?: Count }
  /** "Each creature that convoked ~ connives": one after another. */
  | { op: 'conniveEach' }
  /** "Exile it at the beginning of the next end step": marked to go then. */
  | { op: 'fleeting'; what: Aim }
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
    /** Cultivate: the first this-many found go `to`, the rest into your
     *  hand. */
    first?: number
    /** "With different names": no two alike. */
    distinct?: boolean
  }
  /** The top card of your library, looked at. If it is what the card wants
   *  (`match`) it goes where `hit` says — asked first, when it is a "you
   *  may". Anything else, or a card you turned down, goes where `miss` says,
   *  which may be a question of its own: Coiling Oracle, Into the Wilds,
   *  Parcelbeast, Cabaretti Ascendancy. With `cast` it is cast from there
   *  without paying its mana cost — only `once` a turn, where the card says. */
  | {
    op: 'topCard'
    match: Filter
    hit: 'battlefield' | 'hand' | 'cast'
    tapped: boolean
    ask: boolean
    miss: 'hand' | 'stay' | 'bottom' | 'graveyard'
    missAsk: boolean
    once?: boolean
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
  /** Move permanents: destroy, exile, return to hand, sacrifice. `only`
   *  those still in one place: "exile that card from your graveyard". */
  | { op: 'move'; what: Aim; to: 'graveyard' | 'exile' | 'hand'; only?: 'graveyard' | 'battlefield' }
  /** Return cards from your graveyard: ones you pick, or — `all` — every
   *  one that matches. `until` is for those that go back into exile:
   *  "exile those creatures at the beginning of your next upkeep". */
  | {
    op: 'reanimate'
    filter: Filter
    count: number
    upTo: boolean
    to: 'hand' | 'battlefield'
    all?: boolean
    until?: 'upkeep'
    /** "The top creature card of your graveyard": the one most lately put
     *  there, with nothing to choose. */
    top?: boolean
    budget?: Budget
    /** "…that were put there from the battlefield this turn." */
    fell?: boolean
  }
  /** A Class gains its next level. */
  | { op: 'levelUp' }
  /** Your life total becomes a number. */
  | { op: 'setLife'; count: Count }
  /** Take every counter off: "remove all of them from it". */
  | { op: 'removeCounters'; from: Aim }
  | { op: 'untap'; what: Aim }
  | { op: 'tap'; what: Aim }
  | { op: 'extraLand'; count: number }
  | { op: 'addMana'; makes: ManaType[][] }
  /** "Gets +3/+3 and gains trample until end of turn." */
  | {
    op: 'boost'
    to: Aim
    power: Signed
    toughness: Signed
    keywords: string[]
    types?: string[]
    /** "Has base power and toughness X/X": in place of what is printed. */
    base?: { power: Count; toughness: Count }
    /** "…and gain all creature types." */
    allTypes?: boolean
  }
  /** Attach the source — an Equipment, an Aura — to what was chosen. */
  | { op: 'attach' }
  /** Discard from your hand: your choice of which. */
  | { op: 'discard'; count: Count }
  /** Pay mana, as part of an effect: "you may pay {1}. If you do, …". Paid
   *  the way a spell is; if it cannot be, it counts as declined. */
  | { op: 'pay'; cost: string }
  /** "Choose one —": the modes, each its own little ability. "Choose one
   *  or more" and "choose up to one" set how few and how many. */
  | {
    op: 'mode'
    modes: Ability[]
    min: number
    max: number
    /** More may be taken while this holds: both, with a commander. */
    more?: { test: Test; max: number }
    /** "Choose one that hasn't been chosen this turn." */
    fresh?: boolean
    /** "Choose one at random" — unless this holds, and then it is yours. */
    random?: { unless: Test }
    /** A villainous choice: the opponent's to make, so made for them. */
    who?: 'opponent'
    /** "Up to five {P} worth of modes": what each costs, and the most they
     *  may come to — the same mode as often as it can be afforded. */
    budget?: { max: number; costs: number[] }
  }
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
  /** "If you don't, …": carried out only when it was declined. */
  ifNot?: boolean
  /** "You may … Do this only once each turn": asked until it has been
   *  agreed to once this turn, and not again after. */
  onceIfDone?: boolean
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
  /** `from` narrows it to arrivals from one place: "enters from a
   *  graveyard". */
  | { on: 'enters'; who: 'self'; from?: 'graveyard' }
  | { on: 'enters'; who: Filter; from?: 'graveyard' }
  /** "Whenever one or more cards leave your graveyard." */
  | { on: 'leavesGraveyard' }
  | { on: 'dies'; who: 'self' }
  /** "Whenever equipped creature dies": what this is attached to. */
  | { on: 'dies'; who: 'attached' }
  | { on: 'dies'; who: Filter }
  /** `main` is the first main phase, `main2` the one after combat. */
  | { on: 'step'; step: 'upkeep' | 'main' | 'combat' | 'main2' | 'end' }
  /** "Whenever ~ attacks", "whenever a creature you control attacks". */
  | { on: 'attacks'; who: 'self' | 'attached' | Filter }
  /** "Whenever you attack": once, however many attack. */
  | { on: 'attack' }
  /** "Whenever ~ deals combat damage to a player". */
  | { on: 'combatDamage'; who: 'self' | 'attached' | Filter }
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
  /** "Whenever ~ is dealt damage." */
  | { on: 'damaged'; who: 'self' }
  /** "When this Class becomes level 3." */
  | { on: 'level'; level: number }
  /** "Whenever a creature you control leaves the battlefield." */
  | { on: 'leaves'; who: Filter }
  /** "When the sixth plan counter is put on ~." */
  | { on: 'counters'; counter: string; count: number }
  /** "Whenever one or more land cards are put into your graveyard from your
   *  library": each such card, as it is. */
  | { on: 'milled'; filter: Filter }
  /** "Whenever a card is put into your graveyard from anywhere." */
  | { on: 'buried' }
  /** "Whenever you cast a spell that targets a creature you control." */
  | { on: 'targets'; filter: Filter }
  /** "Whenever ~ becomes attached to a creature": the ability is about that
   *  creature. */
  | { on: 'attached' }
  /** "When ~ becomes the target of a spell or ability." */
  | { on: 'targeted' }

export interface TriggeredAbility extends Ability {
  when: TriggerEvent
  /** It belongs to one side of a card that had you choose as it entered —
   *  Khans, or Dragons — and is there only if that was the side chosen. */
  side?: string
  /** "…, if you control five or more lands, …": checked as it triggers. */
  condition?: Test
  /** It works from the graveyard: "return ~ from your graveyard to your
   *  hand" is no use to a card anywhere else. */
  from?: 'graveyard'
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
  /** "As ~ enters, choose Khans or Dragons." */
  | { kind: 'chooseSide'; sides: string[] }
  /** "You may look at the top card of your library any time." */
  | { kind: 'lookTop' }
  /** "You may play lands and cast spells from the top of your library" —
   *  lands, the spells that match, or both. */
  | { kind: 'playTop'; lands: boolean; spells: Filter | null }
  /** "Once during each of your turns, you may cast a spell from your hand
   *  or the top of your library without paying its mana cost." */
  | { kind: 'freeSpell' }
  /** "~ is the chosen type in addition to its other types." */
  | { kind: 'isChosenType' }
  /** "Creatures you control are every creature type." */
  | { kind: 'everyCreatureType' }
  /** "This spell costs {1} less to cast for each creature on the
   *  battlefield", "…if you control a Spirit": on the spell itself. */
  | {
    kind: 'selfCostLess'
    amount: number
    per?: Filter
    when?: Test
    /** "For each creature type among creatures you control." */
    perType?: boolean
    /** "…can't reduce the amount of mana it costs by more than {5}." */
    max?: number
    /** "For each creature in your party." */
    party?: boolean
  }
  /** "If a triggered ability of another creature you control of the chosen
   *  type triggers, it triggers an additional time." */
  | { kind: 'doubleTriggers'; of: Filter }
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
  | {
    kind: 'boost'
    to: 'self' | 'attached' | Filter
    boost: Boost
    condition?: { atLeast: number; filter: Filter }
    /** Where the card has to be for this to hold, when that is not the
     *  battlefield: "as long as ~ is in your graveyard". */
    from?: 'graveyard'
  }
  /** "Whenever you tap a Forest for mana, add an additional {G}": more mana
   *  from the same tap. `of` narrows it to taps that make only that kind. */
  | { kind: 'extraMana'; tapped: Filter | 'attached'; of?: ManaType; adds: ManaType; per?: Filter }
  /** "If a creature you control would connive, instead you draw a card,
   *  then that creature connives." */
  | { kind: 'conniveDraw' }
  /** "Lands you control are every basic land type in addition to their
   *  other types." */
  | { kind: 'everyLandType' }
  /** Ascend: with ten permanents, you have the city's blessing for good. */
  | { kind: 'ascend' }
  /** "~ can't attack or block unless you have the city's blessing." */
  | { kind: 'needsBlessing' }
  /** "If damage would be dealt to ~ while it has a +1/+1 counter on it,
   *  prevent that damage and remove a +1/+1 counter from ~." */
  | { kind: 'counterShield' }
  /** Echo: pay this at the upkeep after it arrives, or sacrifice it. */
  | { kind: 'echo'; cost: string }
  /** Cumulative upkeep: an age counter each upkeep, and this for each of
   *  them, or it is sacrificed. */
  | { kind: 'cumulativeUpkeep'; cost: string }
  /** A Saga: a lore counter as it enters and after each draw step, and
   *  sacrificed once its last chapter has been told. */
  | { kind: 'saga'; last: number }
  /** Paradigm: exiled as it resolves, to be cast again as a copy at the
   *  beginning of each first main phase. */
  | { kind: 'paradigm' }
  /** Convoke: your creatures can help pay for it. */
  | { kind: 'convoke' }
  /** Aftermath: this half is cast only from your graveyard, and then
   *  exiled. */
  | { kind: 'aftermath' }
  /** "You can't lose the game and your opponents can't win the game." */
  | { kind: 'cantLose' }
  /** "The "legend rule" doesn't apply." */
  | { kind: 'noLegendRule' }
  /** "You may pay {0} rather than pay the mana cost for Zombie creature
   *  spells you cast." */
  | { kind: 'altCost'; filter: Filter; cost: string }
  /** "Nonland cards in your hand have miracle {0}": the first card you
   *  draw each turn may be cast for nothing, if it is not a land. */
  | { kind: 'miracle' }
  /** Abundance: a draw may instead dig for a land, or for a nonland. Which
   *  is chosen for it once, and stands until it is chosen again. */
  | { kind: 'drawsFind' }
  /** "As ~ enters, choose a creature", of an Aura whose creature copies it. */
  | { kind: 'chooseCreature' }
  /** "Enchanted creature is a copy of the chosen creature." */
  | { kind: 'hostCopies' }
  /** "Enchanted permanent is a colorless land with "{T}: Add {C}" and loses
   *  all other card types and abilities." */
  | { kind: 'hostBecomes'; to: Plain }
  /** "As long as you have a full party, prevent all damage that would be
   *  dealt to equipped creature." */
  | { kind: 'shield'; to: 'self' | 'attached'; when: Test }
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
  /** Sacrifice as many of these as you like, none included. */
  sacrificeAny: Filter | null
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
  /** Crew: tap untapped creatures you control with this much power between
   *  them. */
  crew?: number
  /** "Return two lands you control to their owner's hand." */
  bounce?: { filter: Filter; count: number }
  /** Exile the card itself — from the battlefield, or from the graveyard
   *  for an ability used from there. */
  exileSelf?: boolean
  /** Waterbend: untapped artifacts and creatures of yours may each be
   *  tapped to pay {1} of the mana. */
  waterbend?: boolean
}

export interface ActivatedAbility extends Ability {
  cost: AbilityCost
  /** Only when a sorcery could be cast. Loyalty abilities and Equip are. */
  sorcery: boolean
  oncePerTurn: boolean
  /** Activated from your hand rather than the battlefield: cycling. */
  fromHand: boolean
  /** …or from your graveyard: "return ~ from your graveyard to your hand". */
  fromGraveyard?: boolean
  /** "Activate only if you control a Time Lord", and how it was put. */
  only?: { test: Test; text: string }
  /** A mana ability with a cost beyond {T}: it resolves at once, into the
   *  pool, and never touches the stack (CR 605). */
  mana: ManaType[][] | null
}

/** A way to cast a card other than paying what is printed in its corner. */
export type Way =
  /** Evoke: this cost instead, and it is sacrificed when it enters. */
  | { kind: 'evoke'; cost: string }
  /** Kicker: this as well, and the spell "was kicked". */
  | { kind: 'kicker'; cost: string }
  /** Freerunning: this cost instead, on a turn an Assassin or a commander of
   *  yours has dealt combat damage to a player. */
  | { kind: 'freerunning'; cost: string }
  /** Mayhem: from your graveyard for this cost, the turn it was discarded. */
  | { kind: 'mayhem'; cost: string }
  /** Overload: this cost instead, and "each" where the spell says "target". */
  | { kind: 'overload'; cost: string }
  /** Mutate: this cost instead, and it merges with a non-Human creature of
   *  yours rather than arriving as one of its own. */
  | { kind: 'mutate'; cost: string }
  /** "You may exile two green cards from your hand rather than pay ~'s mana
   *  cost." */
  | { kind: 'pitch'; filter: Filter; count: number; text: string }
  /** "As an additional cost, you may behold a Dragon": one you control, or
   *  one in your hand shown. What the spell does may ask whether you did. */
  | { kind: 'behold'; filter: Filter; text: string }

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
  /** Other ways to cast it, offered as it is cast. */
  ways: Way[]
  /** What the spell does when overloaded: its text with "each" for
   *  "target", compiled the same way. */
  overloaded?: Ability
  /** Ways to cast or use the card that the table does not offer — mutate,
   *  overload, flashback. The card plays as printed without them. */
  skipped: string[]
  coverage: Coverage
}
