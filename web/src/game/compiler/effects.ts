/**
 * Rules text → the effects it means, or null.
 *
 * Each pattern is a shape that recurs across thousands of cards — "draw two
 * cards", "search your library for a basic land card, put it onto the
 * battlefield tapped, then shuffle" — and produces IR the interpreter runs. A
 * sentence nothing here matches returns null, and stays in words.
 *
 * Who an effect is aimed at follows from the table having one real player.
 * "Target player draws" means you; "target player loses life" means the
 * opponent, since nobody aims that at themselves. Where only an opponent's
 * permanent would do, the effect is understood and does nothing.
 */

import type { ManaType } from '../mana'
import type { Aim, Count, Effect, Signed, Test, TokenSpec } from './ir'
import { subtypeOf } from './subtypes'
import {
  readAmount, readCount, readFilter, readKeywords, readNumber, readTest, readToken, type Speaking,
} from './read'
import { readExcept } from './copies'

type Pattern = [RegExp, (m: RegExpExecArray) => Effect[] | null]

/** "~", "it", "itself", "he" — the source. */
const SELF = /^(~|it|itself|he|she|him|her|them)$/

/** What "it", "that creature" and "they" mean just now, when a sentence
 *  before this one picked something out: the target of "destroy target
 *  creature", in "its controller gains…" after it. Null where nothing was,
 *  and then "it" is the card itself. */
let referent: Aim | null = null

const PRONOUN = /^(it|that creature|that permanent|that land|that artifact|that card|them|they|those creatures|those permanents|those lands|those cards)$/

/** Read with "it" meaning this. */
function referring<T>(to: Aim | null, read: () => T): T {
  const before = referent
  referent = to
  try {
    return read()
  } finally {
    referent = before
  }
}

/** What these effects leave "it" meaning: the last thing targeted or
 *  picked. A sacrifice does not count — nobody says "it" of what is gone. */
function referentOf(effects: readonly Effect[], otherwise: Aim | null): Aim | null {
  const gone = effects.some((effect) => (
    effect.op === 'move' && effect.what.kind === 'chosen' && effect.to === 'graveyard'
  ))
  // What was taken from the top of the library is "those lands" afterwards
  // — and a card picked out of exile is still "it" in the graveyard.
  const picked = effects.some((effect) => (
    (effect.op === 'choose' && (!effect.must || !gone || Boolean(effect.zone)))
    || effect.op === 'dig' || effect.op === 'exileTop' || effect.op === 'exileUntil' || effect.op === 'reanimate'
  ))
  return picked ? { kind: 'chosen' } : otherwise
}

/** Something was sacrificed by an effect before this one, so "the sacrificed
 *  creature" is what was chosen for that — rather than what paid an
 *  ability's cost, which is the card the ability is about. */
let sacrificed = false

/** Whose numbers "its" and "the sacrificed creature's" are, just now. */
const speaking = (): Speaking => ({
  it: referent?.kind === 'chosen' ? 'chosen' : 'event',
  sacrificed: sacrificed ? 'chosen' : 'event',
})

/** "+2", "-x" → the change it is. */
function readSigned(text: string): Signed {
  const sign = text.startsWith('-') ? -1 : 1
  return /x$/.test(text) ? { sign, count: 'X' } : Number(text)
}

/** Put what "where X is …" says in place of X. */
function withX(effect: Effect, n: Count): Effect {
  const swap = (count: Count): Count => (count === 'X' ? n : count)
  const change = (by: Signed): Signed => (typeof by === 'number' ? by : { ...by, count: swap(by.count) })
  switch (effect.op) {
    case 'draw': case 'life': case 'damage': case 'scry': case 'surveil': case 'mill':
    case 'counters': case 'discard': case 'search': case 'dig':
      return { ...effect, count: swap(effect.count) }
    case 'token':
      return { ...effect, count: swap(effect.count), ...(effect.size ? { size: swap(effect.size) } : {}) }
    case 'boost':
      return { ...effect, power: change(effect.power), toughness: change(effect.toughness) }
    case 'connive':
      return effect.count === undefined ? effect : { ...effect, count: swap(effect.count) }
    default:
      return effect
  }
}

/** A token effect: one printed X/X is sized as it is made. */
const makes = (token: TokenSpec, count: Count, tapped: boolean): Effect =>
  ({ op: 'token', count, token, tapped, ...(token.pt === 'X/X' ? { size: 'X' as Count } : {}) })

/** An effect that takes an amount in words. */
function counted(phrase: string, build: (count: Count) => Effect[] | null): Effect[] | null {
  const count = readAmount(phrase, speaking())
  return count === null ? null : build(count)
}

const nothing = (why: string): Effect[] => [{ op: 'nothing', why }]

/** What a "target …" phrase means, as the steps that carry it out: a
 *  `choose` of what matches, then `act` on what was chosen. Nothing at all
 *  when only an opponent's permanent would do. */
function onTarget(phrase: string, act: (what: Aim) => Effect[]): Effect[] | null {
  const m = /^(?:(up to )(\w+) )?(?:(?!another|other)(\w+) )?(another |other )?target (.+)$/.exec(phrase)
  if (!m) return null
  const [, upTo, upCount, plainCount, other, noun] = m
  const count = readNumber(upCount ?? plainCount ?? 'one')
  const read = readFilter(noun)
  const filter = read && other ? { ...read, other: true } : read
  if (count === null || !filter) return null
  if (filter.controller === 'opponent') return nothing('Nothing on the other side to target')
  return [{ op: 'choose', filter, count, upTo: Boolean(upTo) }, ...act({ kind: 'chosen' })]
}

/** "~", "each creature you control", "creatures you control", or "target
 *  creature": what an effect that acts on permanents acts on. */
function onPermanents(phrase: string, act: (what: Aim) => Effect[]): Effect[] | null {
  if (referent && PRONOUN.test(phrase)) return act(referent)
  if (SELF.test(phrase)) return act({ kind: 'self' })
  if (/^that creature$/.test(phrase)) return act({ kind: 'event' })
  if (/^(equipped|enchanted) (creature|permanent|land)$/.test(phrase)) return act({ kind: 'host' })
  if (/^(?:a|the) cards? exiled with ~$/.test(phrase)) return act({ kind: 'exiled' })
  // The player a spell is aimed at, where it helps, is you.
  if (/^creatures target player controls$/.test(phrase)) return act({ kind: 'each', filter: { types: ['creature'], controller: 'you' } })
  const each = /^(?:each|all) (.+)$/.exec(phrase) ?? /^((?:other )?[a-z]+s you control)$/.exec(phrase)
  if (each) {
    const filter = readFilter(each[1])
    return filter ? act({ kind: 'each', filter }) : null
  }
  return onTarget(phrase, act)
}

const PATTERNS: Pattern[] = [
  // --- cards ---------------------------------------------------------------
  [/^(?:you |target player |each player |that player )?draws? (\w+) cards?$/, (m) => {
    const count = readCount(m[1])
    return count === null ? null : [{ op: 'draw', count }]
  }],
  [/^that creature's controller may draw a card$/, () => [{ op: 'draw', count: 1, optional: true }]],
  // Felothar: as many as the creature that paid for it was tough.
  [/^draw cards equal to (?:the sacrificed creature's|that creature's|its|~'s) (power|toughness)$/, (m) => (
    [{ op: 'draw', count: { stat: m[1] as 'power' | 'toughness', of: 'event' } }]
  )],
  [/^discard (\w+) cards?$/, (m) => {
    const count = readCount(m[1])
    return count === null ? null : [{ op: 'discard', count }]
  }],
  [/^discard (?:your|their) hand$/, () => [{ op: 'discard', count: { zone: 'hand' } }]],
  [/^discard cards equal to (?:its|that creature's|the sacrificed creature's) (power|toughness)$/, (m) => (
    [{ op: 'discard', count: { stat: m[1] as 'power' | 'toughness', of: 'event' } }]
  )],
  [/^draw cards equal to (.+)$/, (m) => counted(m[1], (count) => [{ op: 'draw', count }])],
  [/^(?:you )?draw a card for each (.+)$/, (m) => {
    const filter = readFilter(m[1])
    return filter ? [{ op: 'draw', count: { per: filter } }] : null
  }],
  // After "each other player discards a card": as many as that came to.
  [/^(?:you )?draw a card for each card discarded this way$/, () => [{ op: 'draw', count: 'thatMany' }]],
  [/^(?:you )?scry (\w+)$/, (m) => {
    const count = readCount(m[1])
    return count === null ? null : [{ op: 'scry', count }]
  }],
  [/^(?:you )?surveil (\w+)$/, (m) => {
    const count = readCount(m[1])
    return count === null ? null : [{ op: 'surveil', count }]
  }],
  [/^(?:you |target player )?mills? (\w+) cards?$/, (m) => {
    const count = readCount(m[1])
    return count === null ? null : [{ op: 'mill', count }]
  }],
  [/^each opponent mills (\w+) cards?$/, () => nothing('No library on the other side to mill')],
  [/^(?:each opponent|target opponent|each other player) discards (?:\w+) cards?$/, () => nothing('No hand on the other side to discard from')],
  [/^(?:target (?:opponent|player) reveals (?:their|his or her) hand|look at target (?:opponent|player)'s hand)$/, () => nothing('No hand on the other side to look at')],
  [/^exile target player's graveyard$/, () => nothing('No graveyard on the other side to exile')],

  // --- life ----------------------------------------------------------------
  [/^(?:you )?gain (\w+) life$/, (m) => {
    const count = readCount(m[1])
    return count === null ? null : [{ op: 'life', who: 'you', sign: 1, count }]
  }],
  [/^(?:you )?lose (\w+) life$/, (m) => {
    const count = readCount(m[1])
    return count === null ? null : [{ op: 'life', who: 'you', sign: -1, count }]
  }],
  [/^(?:each opponent|target opponent|target player) loses (\w+) life$/, (m) => {
    const count = readCount(m[1])
    return count === null ? null : [{ op: 'life', who: 'opponent', sign: -1, count }]
  }],
  [/^(?:each opponent|target opponent|target player) loses x life, where x is ~'s (power|toughness)$/, (m) => (
    [{ op: 'life', who: 'opponent', sign: -1, count: { stat: m[1] as 'power' | 'toughness', of: 'self' } }]
  )],
  // Swords to Plowshares, on the only creatures there are: yours.
  [/^its controller gains life equal to its (power|toughness)$/, (m) => (
    [{ op: 'life', who: 'you', sign: 1, count: { stat: m[1] as 'power' | 'toughness', of: 'chosen' } }]
  )],
  // Ikra Shidiqi: the creature the trigger is about.
  [/^(?:you )?gain life equal to that creature's (power|toughness)$/, (m) => (
    [{ op: 'life', who: 'you', sign: 1, count: { stat: m[1] as 'power' | 'toughness', of: 'event' } }]
  )],
  [/^(?:you )?gain life equal to (?:the|its) (power|toughness)(?: of (.+))?$/, (m) => {
    const stat = m[1] as 'power' | 'toughness'
    if (!m[2]) return [{ op: 'life', who: 'you', sign: 1, count: { stat, of: 'self' } }]
    return onTarget(m[2], () => [{ op: 'life', who: 'you', sign: 1, count: { stat, of: 'chosen' } }])
  }],

  [/^(?:have )?your life total becomes? (.+)$/, (m) => counted(m[1], (count) => [{ op: 'setLife', count }])],
  [/^(?:you )?(gain|lose) life equal to (.+)$/, (m) => (
    counted(m[2], (count) => [{ op: 'life', who: 'you', sign: m[1] === 'gain' ? 1 : -1, count }])
  )],
  [/^(?:each opponent|target opponent|target player) loses life equal to (.+)$/, (m) => (
    counted(m[1], (count) => [{ op: 'life', who: 'opponent', sign: -1, count }])
  )],

  // --- damage --------------------------------------------------------------
  [/^(?:(?:~|it) )?deals? damage to target (?:player|opponent) equal to the number of cards in that player's hand$/, () => nothing('No hand on the other side to count')],
  [/^(~|it) deals (?:(\w+) damage|damage equal to its (power|toughness)) to (any target|target opponent|each opponent|target player|target player or planeswalker|target creature or player|target opponent or planeswalker|each player)$/, (m) => {
    const [, who, n, stat, to] = m
    const count: Count | null = stat
      ? { stat: stat as 'power' | 'toughness', of: who === 'it' ? 'event' : 'self' }
      : readCount(n)
    if (count === null) return null
    const opponent: Effect = { op: 'damage', to: { kind: 'opponent' }, count }
    return to === 'each player' ? [opponent, { op: 'damage', to: { kind: 'you' }, count }] : [opponent]
  }],
  [/^~ deals (\w+) damage to (each .+|.*target creature.*)$/, (m) => {
    const count = readCount(m[1])
    return count === null ? null : onPermanents(m[2], (what) => [{ op: 'damage', to: what, count }])
  }],

  // One of yours hits another creature: the first target is set aside
  // while the second is picked.
  [/^(target .+?) deals damage equal to its power to (another target .+)$/, (m) => {
    const first = onTarget(m[1], () => [{ op: 'keep' }])
    const second = onTarget(m[2], (to) => [{ op: 'damage', to, count: { stat: 'power', of: 'kept' } }])
    return first && second && first.some((effect) => effect.op === 'choose') ? [...first, ...second] : null
  }],

  // --- tokens --------------------------------------------------------------
  // Krenko: as many as its power.
  [/^create a number of (.+? tokens?(?: with [a-z, ]+?)?) equal to (?:~'s|its) (power|toughness)$/, (m) => {
    const token = readToken(m[1])
    return token ? [{ op: 'token', count: { stat: m[2] as 'power' | 'toughness', of: 'self' }, token, tapped: false }] : null
  }],
  [/^(?:you )?create (\w+) (tapped )?(.+? tokens?(?: with [a-z, ]+?)?)(?: named [^.]+?)?(?: for each (.+))?$/, (m) => {
    const count = readCount(m[1])
    const token = readToken(m[3])
    if (count === null || !token) return null
    if (m[4]) {
      // "…for each creature you control", or for each thing that has
      // happened this turn.
      const filter = readFilter(m[4])
      const per: Count | null = filter ? { per: filter } : readEach(m[4])
      return per !== null && count === 1 ? [makes(token, per, Boolean(m[2]))] : null
    }
    return [makes(token, count, Boolean(m[2]))]
  }],
  // As many as the effect before it came to: counters removed, damage dealt.
  [/^create that many (.+? tokens?(?: with [a-z, ]+?)?)$/, (m) => {
    const token = readToken(m[1])
    return token && [makes(token, 'thatMany', false)]
  }],
  [/^create a number of (.+? tokens?(?: with [a-z, ]+?)?) equal to (.+)$/, (m) => {
    const token = readToken(m[1])
    return token && counted(m[2], (count) => [makes(token, count, false)])
  }],
  [/^create ([a-z' -]+, an? legendary .+? tokens?(?: with [a-z, ]+?)?)$/, (m) => {
    const token = readToken(m[1])
    return token ? [{ op: 'token', count: 1, token, tapped: false }] : null
  }],
  // On the only creatures there are, its controller is you.
  [/^(?:its controller|that creature's controller|that permanent's controller|target player) creates (.+)$/, (m) => readSentence(`create ${m[1]}`)],
  // "Choose target creature you control": aimed now, spoken of after.
  [/^choose (target .+)$/, (m) => onTarget(m[1], () => [])],
  // Becoming a copy. Who becomes one may be the card itself, everything of
  // a kind, everything but what was chosen, or a target of its own — and
  // then what it copies is a second target.
  // Taskmaster: of a creature, or of a creature card in a graveyard.
  [/^until (your next turn|end of turn), (.+?) becomes? a copy of up to one target creature on the battlefield or creature card in a graveyard(?:, except (.+))?$/, (m) => {
    const change = m[3] ? readExcept(m[3]) : {}
    const until = m[1] === 'your next turn' ? 'turn' as const : 'end' as const
    return change && onPermanents(m[2], (who) => [
      { op: 'choose', filter: { types: ['creature'] }, count: 1, upTo: true, orGraveyard: true },
      { op: 'become', who, change, until },
    ])
  }],
  // Blade of Shared Souls: its bearer, for as long as it bears it.
  [/^for as long as ~ remains attached to it, you may have that creature become a copy of (another target .+)$/, (m) => {
    const aimed = onTarget(m[1], () => [{ op: 'become', who: { kind: 'event' }, change: {}, until: 'attached' }])
    return aimed && aimed.map((effect) => (effect.op === 'choose' ? { ...effect, apart: 'event' as const } : effect))
  }],
  // Kitesail Larcenist: one of yours, at most — there is nobody else's.
  [/^for each player, choose (up to one other target .+?) that player controls$/, (m) => onTarget(`${m[1]} you control`, () => [])],
  [/^for as long as ~ remains on the battlefield, the chosen permanents? becomes? treasure artifacts? with "\{t\}, sacrifice ~: add one mana of any color" and loses? all other abilities$/, () => [{
    op: 'transform', who: referent ?? { kind: 'chosen' }, until: 'source',
    to: { typeLine: 'Artifact — Treasure', text: '{T}, Sacrifice this artifact: Add one mana of any color.' },
  }]],
  // Ultima: a land with a blight counter makes colorless, and nothing else.
  [/^for as long as that land has a blight counter on it, it loses all land types and abilities and has "\{t\}: add \{c\}\.?"$/, () => [{
    op: 'transform', who: referent ?? { kind: 'chosen' }, to: { typeLine: 'Land', text: '{T}: Add {C}.' },
  }]],
  [/^(.+?) becomes? (?:a copy|copies) of (that creature|that permanent|it|target .+?)( until end of turn| until your next turn)?(?:, except (.+))?$/, (m) => {
    const change = m[4] ? readExcept(m[4]) : {}
    if (!change) return null
    const until = m[3] ? (/end of turn/.test(m[3]) ? 'end' as const : 'turn' as const) : undefined
    const becoming = (who: Aim): Effect[] => [{ op: 'become', who, change, ...(until ? { until } : {}) }]
    const others = /^each (.+?) other than the chosen (?:creature|permanent)$/.exec(m[1])
    const rest = others && readFilter(others[1])
    // What is copied: already chosen, or a target named here.
    const copied = /^target /.test(m[2]) ? onTarget(m[2], () => []) : []
    if (!copied) return null
    if (others) return rest ? [...copied, ...becoming({ kind: 'others', filter: rest })] : null
    if (/^target /.test(m[1])) {
      // Two targets: the first is set aside while the second is picked.
      const first = onTarget(m[1], () => [{ op: 'keep' }])
      return first && first.some((effect) => effect.op === 'choose') ? [...first, ...copied, ...becoming({ kind: 'kept' })] : null
    }
    const who = onPermanents(m[1], (aim) => becoming(aim))
    return who && [...copied, ...who]
  }],
  [/^copy that spell(?:\. you may choose new targets for the copy)?$/, () => [{ op: 'copySpell' }]],
  // A token that is a copy of something, with what is different about it.
  [/^create (an?|\w+) (tapped (?:and attacking )?)?tokens? that(?:'s| are) (?:a copy|copies) of (.+?)(?:, except (.+))?$/, (m) => {
    const count = readCount(m[1])
    const change = m[4] ? readExcept(m[4]) : {}
    if (count === null || !change) return null
    return onPermanents(m[3], (of) => [{
      op: 'copy', of, count, change, tapped: Boolean(m[2]), fleeting: false,
      ...(/attacking/.test(m[2] ?? '') ? { attacking: true } : {}),
    }])
  }],
  // "For each card you've discarded this turn, create a token…": one of
  // them, that many times.
  [/^for each (?!opponent\b)(.+?), create (an? .+)$/, (m) => {
    const filter = readFilter(m[1])
    const count: Count | null = filter ? { per: filter } : readEach(m[1])
    const made = count === null ? null : readSentence(`create ${m[2]}`)
    return made && made.map((effect) => (effect.op === 'token' || effect.op === 'copy' ? { ...effect, count: count! } : effect))
  }],
  // The token's own abilities, in quotes. It is made; using them is yours.
  [/^(?:it has|they have|it gains|they gain) ".+"$/, () => []],

  // --- counters ------------------------------------------------------------
  [/^put (\w+) ([+-]\d\/[+-]\d|[a-z]+) counters? on (.+)$/, (m) => {
    const count = readCount(m[1])
    if (count === null) return null
    const counter = m[2]
    return onPermanents(m[3], (to) => [{ op: 'counters', to, count, counter }])
  }],
  [/^remove all (?:of them|[a-z+/\d-]+ counters) from (~|it)$/, () => [{ op: 'removeCounters', from: { kind: 'self' } }]],
  [/^(.+?) connives (\w+)$/, (m) => {
    const count = readCount(m[2])
    return count === null ? null : onPermanents(m[1], (who) => [{ op: 'connive', who, count }])
  }],
  // Convoke is not offered, so nothing convoked it.
  [/^each creature that convoked ~ connives$/, () => []],
  [/^(.+?) connives?$/, (m) => onPermanents(m[1], (who) => [{ op: 'connive', who }])],
  [/^have (it|~|that creature) connive$/, (m) => onPermanents(m[1], (who) => [{ op: 'connive', who }])],
  [/^double the number of ([+-]\d\/[+-]\d|[a-z]+) counters on ~$/, (m) => (
    [{ op: 'counters', to: { kind: 'self' }, count: { counters: m[1], of: 'self' }, counter: m[1] }]
  )],
  [/^proliferate$/, () => [{ op: 'proliferate' }]],
  [/^put a number of ([+-]\d\/[+-]\d|[a-z]+) counters on (.+?) equal to (.+)$/, (m) => (
    counted(m[3], (count) => onPermanents(m[2], (to) => {
      // On each of several, "that creature's toughness" is its own.
      const own = to.kind === 'each' && typeof count === 'object' && 'of' in count && count.of === 'event'
      return [{ op: 'counters', to, count: own ? { ...count, of: 'each' } as Count : count, counter: m[1] }]
    }))
  )],

  // --- the library ---------------------------------------------------------
  [/^search your library for (up to (\w+) |(\w+) )?(.+?) cards?(?:, reveal (?:it|them|that card|those cards))?,? (?:and )?put (?:it|them|that card|those cards) (into your hand|onto the battlefield( tapped)?|on top of your library)(?:,? then shuffle)?$/, (m) => {
    const [, , upCount, plainCount, noun, where, tapped] = m
    const count = readCount(upCount ?? plainCount ?? 'one')
    const filter = readFilter(noun)
    if (count === null || !filter) return null
    return [{
      op: 'search', filter, count, upTo: Boolean(upCount),
      to: where === 'into your hand' ? 'hand' : where.startsWith('onto') ? 'battlefield' : 'top',
      tapped: Boolean(tapped),
    }]
  }],
  // Cultivate and Kodama's Reach: one to the battlefield, one to hand —
  // and Viewpoint Synchronization, two and one.
  [/^search your library for up to (\w+) (.+?) cards?(?:, reveal those cards,| and reveal them,) put (\w+)(?: of them)? onto the battlefield( tapped)? and the others? into your hand,? then shuffle$/, (m) => {
    const count = readNumber(m[1])
    const filter = readFilter(m[2])
    const first = readNumber(m[3])
    return filter && count !== null && first !== null
      ? [{ op: 'search', filter, count, upTo: true, to: 'battlefield', tapped: Boolean(m[4]), first }]
      : null
  }],
  [/^put (an?|up to (\w+)) (.+?) cards? from your hand onto the battlefield( tapped)?$/, (m) => {
    const filter = readFilter(m[3])
    const count = readNumber(m[2] ?? 'one')
    return filter && count !== null
      ? [{ op: 'fromHand', filter, count, upTo: Boolean(m[2]), tapped: Boolean(m[4]) }]
      : null
  }],

  // Looking at the top few: the sentences that say what is taken and where
  // the rest goes were joined to this one with semicolons by `readAbility`.
  [/^(?:look at|reveal) the top (\w+) cards of your library; (.+)$/, (m) => readDig(m[1], m[2])],
  [/^reveal cards from the top of your library until you reveal an? (.+?), put that card (into your hand|onto the battlefield) and the rest (.+)$/, (m) => {
    const filter = readFilter(m[1])
    const rest = readRest(m[3])
    return filter && rest && rest !== 'top'
      ? [{ op: 'digUntil', filter, to: m[2] === 'into your hand' ? 'hand' : 'battlefield', rest }]
      : null
  }],
  [/^put (\w+) cards? from your hand on top of your library(?: in any order)?$/, (m) => {
    const count = readNumber(m[1])
    return count === null ? null : [{ op: 'putBack', count }]
  }],

  // --- becoming something else ---------------------------------------------
  // "All lands you control become 2/2 Elemental creatures with reach": what
  // they already are, and this as well.
  [/^(?:until (your next turn|end of turn), )?(.+?) becomes? (?:an? )?(\d+)\/(\d+) ([a-z ]+?) creatures?(?: with (.+?))?( until end of turn)?(?: that's still a land| that are still lands)?$/, (m) => {
    const until = m[1] === 'your next turn' ? 'turn' as const : m[1] || m[7] ? 'end' as const : undefined
    const types = ['Creature', ...m[5].split(/\s+/).map((word) => word[0].toUpperCase() + word.slice(1))]
    return onPermanents(m[2], (who) => [{
      op: 'animate', who, change: { types, pt: `${m[3]}/${m[4]}`, keywords: readKeywords(m[6] ?? '') }, ...(until ? { until } : {}),
    }])
  }],
  // Druid Class: a creature, with words of its own for how big.
  [/^(.+?) becomes? a creature with ([a-z, ]+?) and "(.+?)\.?"$/, (m) => (
    onPermanents(m[1], (who) => [{ op: 'animate', who, change: { types: ['Creature'], keywords: readKeywords(m[2]), text: m[3] } }])
  )],
  [/^(?:they're still lands|it's still a land)$/, () => []],
  // Haste matters on the turn it arrives, which is this one.
  [/^(it|they|that creature|those creatures) gains? haste$/, (m) => (
    onPermanents(m[1], (to) => [{ op: 'boost', to, power: 0, toughness: 0, keywords: ['Haste'] }])
  )],

  // --- coming back ---------------------------------------------------------
  [/^return (that card|it|them) to the battlefield(?: under (?:its|their) owners?'s? control)?( tapped)?$/, (m) => [{
    op: 'put', what: referent ?? { kind: 'event' }, ...(m[2] ? { tapped: true } : {}),
  }]],
  [/^put (it|them|that card|those cards) onto the battlefield( tapped)?$/, (m) => [{
    op: 'put', what: referent ?? { kind: 'event' }, ...(m[2] ? { tapped: true } : {}),
  }]],
  [/^return ~ to the battlefield attached to (?:that creature|it)$/, () => [{ op: 'put', what: { kind: 'self' }, attach: true }]],
  [/^return to the battlefield all (.+?) cards in your graveyard that were put there from the battlefield this turn$/, (m) => {
    const filter = readFilter(m[1])
    return filter && [{ op: 'reanimate', filter, count: 0, upTo: false, all: true, to: 'battlefield', fell: true }]
  }],
  [/^when (target .+?) is put into (?:your|a) graveyard this turn, return that card to the battlefield$/, (m) => (
    onTarget(m[1], (who) => [{ op: 'saveFromGrave', who }])
  )],
  // The opponent's choice between two evils, each read as its own ability.
  [/^(?:that player|each opponent|target opponent|an opponent) faces a villainous choice — (.+?), or (.+)$/, (m) => {
    const modes = [m[1], m[2]].map((option) => {
      const said = option
        .replace(/ of their choice\b/, '')
        .replace(/^they sacrifice /, 'that player sacrifices ')
        .replace(/^they lose /, 'target opponent loses ')
        .replace(/^they discard /, 'target opponent discards ')
        .replace(/^that player (loses|discards) /, 'target opponent $1 ')
      return { text: option[0].toUpperCase() + option.slice(1), ...readAbility(said) }
    })
    return modes.some((mode) => mode.effects.length)
      ? [{ op: 'mode', min: 1, max: 1, who: 'opponent', modes: modes.map(({ text, effects, complete }) => ({ text, effects, complete })) }]
      : null
  }],
  [/^search your library for up to (\w+) (.+?) cards and\/or (.+?) cards with different names, put them (into your hand|onto the battlefield( tapped)?),? then shuffle$/, (m) => {
    const count = readNumber(m[1])
    const [one, other] = [readFilter(m[2]), readFilter(m[3])]
    return count !== null && one && other ? [{
      op: 'search', filter: { either: [one, other] }, count, upTo: true, distinct: true,
      to: m[4] === 'into your hand' ? 'hand' : 'battlefield', tapped: Boolean(m[5]),
    }] : null
  }],

  // --- playing from elsewhere ----------------------------------------------
  [/^exile the top (?:(\w+) )?cards? of your library$/, (m) => {
    const count = readCount(m[1] ?? 'one')
    return count === null ? null : [{ op: 'exileTop', count }]
  }],
  [/^exile cards from the top of your library until you exile an? (.+?) card$/, (m) => {
    const filter = readFilter(m[1])
    return filter && [{ op: 'exileUntil', filter }]
  }],
  // Lady Loki: the spell she took, against the card she found.
  [/^~ deals damage to each opponent equal to the difference between that spell's mana value and that nonland card's mana value$/, () => [{
    op: 'damage', to: { kind: 'opponent' },
    count: { between: [{ stat: 'manaValue', of: 'event' }, { stat: 'manaValue', of: 'chosen' }] },
  }]],
  [/^you may cast (?:that card|it) without paying its mana cost$/, () => (
    [{ op: 'castFree', from: 'chosen', count: 1, filter: { not: ['land'] } }]
  )],
  // Extract Power: yours is the only library there is.
  [/^look at the top card of each player's library, then exile those cards face down$/, () => [{ op: 'exileTop', count: 1 }]],
  [/^exile that card from your graveyard$/, () => [{ op: 'move', what: { kind: 'event' }, to: 'exile', only: 'graveyard' }]],
  // A permission rather than a choice: the card may be played from exile,
  // for as long as this says.
  [/^(?:(until end of turn|until the end of your next turn), )?you may play (?:that card|those cards|them|it)( this turn)?( without paying (?:its|their) mana costs?)?( for as long as (?:it|they) remains? exiled)?$/, (m) => {
    const until = m[4] ? 'exiled' as const
      : m[1] === 'until the end of your next turn' ? 'nextEnd' as const
        : m[1] || m[2] ? 'end' as const : null
    return until && [{ op: 'mayPlay', who: referent ?? { kind: 'event' }, until, ...(m[3] ? { free: true } : {}) }]
  }],
  [/^you may cast a spell with mana value (\d+) or less from your hand without paying its mana cost$/, (m) => [{
    op: 'castFree', from: 'hand', count: 1,
    filter: { not: ['land'], compare: { stat: 'manaValue', op: '<=', value: Number(m[1]) } },
  }]],
  [/^you may cast any number of spells from among them without paying their mana costs$/, () => (
    [{ op: 'castFree', from: 'chosen', count: 99, filter: { not: ['land'] } }]
  )],
  // …and what was not cast.
  [/^put the rest into your hand$/, () => [{ op: 'move', what: { kind: 'chosen' }, to: 'hand' }]],
  // What a permanent has exiled, and what becomes of it.
  [/^put a card exiled with ~ into its owner's graveyard$/, () => [
    { op: 'choose', filter: {}, count: 1, upTo: false, must: true, zone: 'exile' },
    { op: 'move', what: { kind: 'chosen' }, to: 'graveyard' },
  ]],
  [/^return each other card exiled with ~ to its owner's graveyard$/, () => [{ op: 'unexile', to: 'graveyard', except: true }]],
  [/^return those cards to the battlefield under their owners?'s? control$/, () => [{ op: 'unexile', to: 'battlefield' }]],

  // --- permanents ----------------------------------------------------------
  // Out and straight back: it arrives as a new permanent.
  [/^exile (.+?), then return (?:it|them|that card|those cards) to the battlefield under (?:your|its owner's|their owners') control$/, (m) => (
    onPermanents(m[1], (what) => [{ op: 'flicker', what }])
  )],
  // Keep a party, lose the rest.
  [/^each player chooses a party from among creatures they control, then sacrifices the rest$/, () => [
    { op: 'choose', filter: { types: ['creature'], controller: 'you' }, count: 4, upTo: true, party: true },
    { op: 'move', what: { kind: 'others', filter: { types: ['creature'], controller: 'you' } }, to: 'graveyard' },
  ]],
  [/^shuffle your (graveyard and hand|hand and graveyard|graveyard|hand) into your library$/, (m) => [{
    op: 'shuffleIn', zones: m[1].split(' and ') as ('graveyard' | 'hand')[],
  }]],
  // Keep these, lose the rest: Slaughter the Strong.
  [/^each player chooses any number of (.+?) they control with total (power|toughness) (\d+) or less, then sacrifices all other (.+?) they control$/, (m) => {
    const keep = readFilter(m[1])
    const rest = readFilter(m[4])
    return keep && rest && [
      {
        op: 'choose', filter: { ...keep, controller: 'you' }, count: 99, upTo: true,
        budget: { stat: m[2] as 'power' | 'toughness', max: Number(m[3]) },
      },
      { op: 'move', what: { kind: 'others', filter: { ...rest, controller: 'you' } }, to: 'graveyard' },
    ]
  }],
  [/^choose a number between (\d+) and (\d+)$/, (m) => [{ op: 'number', min: Number(m[1]), max: Number(m[2]) }]],
  [/^(.+?) doesn't untap during (?:its controller's|your) next untap step$/, (m) => onPermanents(m[1], (what) => [{ op: 'freeze', what }])],
  [/^seek an? (.+?) card( of the most prevalent creature type in your library)?$/, (m) => {
    const filter = readFilter(m[1])
    return filter && [{ op: 'seek', filter, ...(m[2] ? { prevalent: true } : {}) }]
  }],
  // A card in your graveyard, exiled: targeted, or simply picked.
  [/^exile (target |an? )(.+?) cards? from your graveyard(?: with (\w+) time counters on it)?$/, (m) => {
    const filter = readFilter(m[2])
    const time = m[3] ? readNumber(m[3]) : 0
    if (!filter || time === null) return null
    const exiled: Effect[] = [
      { op: 'choose', filter, count: 1, upTo: false, zone: 'graveyard', ...(m[1] === 'target ' ? {} : { must: true }) },
      { op: 'move', what: { kind: 'chosen' }, to: 'exile' },
    ]
    // Suspended: the counters come off one an upkeep.
    return time ? [...exiled, { op: 'counters', to: { kind: 'chosen' }, count: time, counter: 'time' }] : exiled
  }],
  [/^(destroy|exile) (.+)$/, (m) => {
    const to = m[1] === 'destroy' ? 'graveyard' : 'exile'
    return onPermanents(m[2], (what) => [{ op: 'move', what, to }])
  }],
  [/^sacrifice (~|it)$/, () => [{ op: 'move', what: { kind: 'self' }, to: 'graveyard' }]],
  [/^sacrifice (an?) (.+)$/, (m) => {
    const filter = readFilter(m[2])
    return filter
      ? [{ op: 'choose', filter: { ...filter, controller: 'you' }, count: 1, upTo: false, must: true },
          { op: 'move', what: { kind: 'chosen' }, to: 'graveyard' }]
      : null
  }],
  // "…except for Krakens, Leviathans, Octopuses, and Serpents."
  [/^return all (.+?) to their owners' hands except for (.+)$/, (m) => {
    const filter = readFilter(m[1])
    const spared = m[2].split(/,\s*(?:and\s+)?|\s+and\s+/).map((word) => subtypeOf(word.trim()))
    return filter && spared.every(Boolean)
      ? [{ op: 'move', what: { kind: 'each', filter: { ...filter, notSubtypes: spared as string[] } }, to: 'hand' }]
      : null
  }],
  [/^return to their owners' hands all (.+)$/, (m) => onPermanents(`all ${m[1]}`, (what) => [{ op: 'move', what, to: 'hand' }])],
  // Nobody else casts anything: "that player" is you.
  [/^that player returns an? (.+?) they control to its owner's hand$/, (m) => readSentence(`return a ${m[1]} you control to its owner's hand`)],
  [/^return (.+?) to (?:its owner's hand|their owner's hand|their owners' hands|your hand)$/, (m) => {
    // Bounce lands: "return a land you control to its owner's hand".
    const owned = /^an? (.+)$/.exec(m[1])
    if (owned) {
      const filter = readFilter(owned[1])
      return filter
        ? [{ op: 'choose', filter, count: 1, upTo: false, must: true }, { op: 'move', what: { kind: 'chosen' }, to: 'hand' }]
        : null
    }
    return onPermanents(m[1], (what) => [{ op: 'move', what, to: 'hand' }])
  }],
  // As many as you like, so long as they add up to no more than this.
  [/^return any number of target (.+?) cards? with total (power|toughness) (\d+) or less from your graveyard to (your hand|the battlefield)$/, (m) => {
    const filter = readFilter(m[1])
    return filter && [{
      op: 'reanimate', filter, count: 99, upTo: true, to: m[4] === 'your hand' ? 'hand' : 'battlefield',
      budget: { stat: m[2] as 'power' | 'toughness', max: Number(m[3]) },
    }]
  }],
  // Itself, from the graveyard: the ability works from there.
  [/^return ~ from your graveyard to your hand$/, () => [{ op: 'move', what: { kind: 'self' }, to: 'hand' }]],
  // The one most lately buried, with nothing to choose.
  [/^return the top (.+?) card of your graveyard to (your hand|the battlefield)$/, (m) => {
    const filter = readFilter(m[1])
    return filter && [{
      op: 'reanimate', filter, count: 1, upTo: false, top: true, to: m[2] === 'your hand' ? 'hand' : 'battlefield',
    }]
  }],
  // Every one of them, with no choosing: Rally the Ancestors.
  [/^return each (.+?)(?: cards?)? from your graveyard to (your hand|the battlefield)$/, (m) => {
    const filter = readFilter(m[1])
    return filter && [{
      op: 'reanimate', filter, count: 0, upTo: false, all: true, to: m[2] === 'your hand' ? 'hand' : 'battlefield',
    }]
  }],
  [/^return (up to (\w+) )?(?:target )?(.+?)(?: cards?)? from your graveyard to (your hand|the battlefield)(?: tapped)?$/, (m) => {
    const [, upTo, upCount, noun, where] = m
    const filter = readFilter(noun.replace(/^(a|an|one|two|three) /, ''))
    const count = readNumber(upCount ?? (/^(two|three)\b/.exec(noun)?.[1]) ?? 'one')
    if (!filter || count === null) return null
    return [{ op: 'reanimate', filter, count, upTo: Boolean(upTo), to: where === 'your hand' ? 'hand' : 'battlefield' }]
  }],
  [/^(untap|tap) (.+)$/, (m) => {
    const op = m[1] as 'untap' | 'tap'
    const lands = /^up to (\w+) (lands?|creatures?)$/.exec(m[2])
    if (lands) {
      const count = readNumber(lands[1])
      const filter = readFilter(lands[2])
      return count === null || !filter
        ? null
        : [{ op: 'choose', filter: { ...filter, controller: 'you' }, count, upTo: true }, { op, what: { kind: 'chosen' } }]
    }
    return onPermanents(m[2], (what) => [{ op, what }])
  }],

  // --- until end of turn --------------------------------------------------
  [/^(.+?) gets? ([+-](?:\d+|x))\/([+-](?:\d+|x))(?: and gains? (.+?))? until end of turn$/, (m) => (
    onPermanents(m[1], (to) => [{
      op: 'boost', to, power: readSigned(m[2]), toughness: readSigned(m[3]), keywords: readKeywords(m[4] ?? ''),
    }])
  )],
  // "+1/+1 until end of turn for each card in your hand".
  [/^(.+?) gets? \+1\/\+1 until end of turn for each (.+?)(?: and can't be blocked this turn)?$/, (m) => {
    const per = readFilter(m[2])
    const count: Count | null = /^cards? in your hand$/.test(m[2]) ? { zone: 'hand' } : per && { per }
    return count && onPermanents(m[1], (to) => [{
      op: 'boost', to, power: { sign: 1, count }, toughness: { sign: 1, count }, keywords: [],
    }])
  }],
  [/^(.+?) gains? your choice of ([a-z ]+?) or ([a-z ]+?) until end of turn$/, (m) => (
    onPermanents(m[1], (to) => [{
      op: 'mode', min: 1, max: 1,
      modes: readKeywords(`${m[2]}, ${m[3]}`).map((keyword) => ({
        text: keyword, complete: true, effects: [{ op: 'boost', to, power: 0, toughness: 0, keywords: [keyword] }],
      })),
    }])
  )],
  // "…have base power and toughness X/X": in place of what is printed.
  [/^until end of turn, (.+?) (?:has|have) base power and toughness (\w+)\/(\w+)(?: and (?:gains? all creature types|becomes? an? ([a-z ]+?) in addition to its other types))?$/, (m) => {
    const [power, toughness] = [readCount(m[2]), readCount(m[3])]
    if (power === null || toughness === null) return null
    return onPermanents(m[1], (to) => [{
      op: 'boost', to, power: 0, toughness: 0, keywords: [], base: { power, toughness },
      ...(m[4] ? { types: m[4].split(/\s+/).map((type) => type[0].toUpperCase() + type.slice(1)) } : {}),
      ...(/all creature types/.test(m[0]) ? { allTypes: true } : {}),
    }])
  }],
  [/^until end of turn, (.+?) becomes? an? ([a-z ]+?) in addition to its other types(?: and gains? (.+))?$/, (m) => (
    onPermanents(m[1], (to) => [{
      op: 'boost', to, power: 0, toughness: 0, keywords: readKeywords(m[3] ?? ''),
      types: m[2].split(/\s+/).map((type) => type[0].toUpperCase() + type.slice(1)),
    }])
  )],
  [/^(.+?) gains? (.+?) until end of turn$/, (m) => (
    onPermanents(m[1], (to) => [{ op: 'boost', to, power: 0, toughness: 0, keywords: readKeywords(m[2]) }])
  )],
  // No blockers at this table: evasion is already total.
  [/^(?:target creature(?: with [a-z0-9 ]+)?|~|it) can't be blocked this turn$/, () => nothing('Nothing blocks at this table')],

  // --- the turn -----------------------------------------------------------
  [/^you may play (an|two|three) additional lands? this turn$/, (m) => {
    const count = readNumber(m[1])
    return count === null ? null : [{ op: 'extraLand', count }]
  }],
  [/^add ((?:\{[wubrgc]\})+)$/, (m) => {
    const makes = [...m[1].matchAll(/\{([wubrgc])\}/g)].map((s) => [s[1].toUpperCase() as ManaType])
    return [{ op: 'addMana', makes }]
  }],
  // Any color: which is worked out as it is added, from what the hand wants.
  [/^add (one|two|three) mana of any (?:one )?color$/, (m) => {
    const count = readNumber(m[1])
    const any: ManaType[] = ['W', 'U', 'B', 'R', 'G']
    return count === null ? null : [{ op: 'addMana', makes: Array.from({ length: count }, () => any) }]
  }],

  [/^pay ((?:\{[^}]+\})+)$/, (m) => [{ op: 'pay', cost: m[1].toUpperCase() }]],
  [/^pay (\w+) life$/, (m) => {
    const count = readCount(m[1])
    return count === null ? null : [{ op: 'life', who: 'you', sign: -1, count }]
  }],

  // --- the other side of the table -----------------------------------------
  // A threaten, on the only creatures there are: it is yours already, and
  // what is left is what comes after — untapped, and hasty.
  [/^gain control of (target .+?) until end of turn$/, (m) => onTarget(m[1], () => [])],
  [/^gain control of target (?!.*until end of turn)[^.]+$/, () => nothing('Everything here is already yours')],
  [/^(?:that player|each opponent|target opponent|each other player|defending player) sacrifices (?!.* and you )[^.]+$/, () => nothing('Nothing on the other side to sacrifice')],
  [/^(?:it|that creature|they) can't be regenerated$/, () => []],
  [/^return target spell you don't control to its owner's hand$/, () => nothing('No spell on the other side to return')],
  // Picked rather than targeted: "choose an artifact or creature you control".
  [/^choose an? (.+ you control)$/, (m) => {
    const filter = readFilter(m[1])
    return filter && [{ op: 'choose', filter, count: 1, upTo: false, must: true }]
  }],
  // One opponent.
  [/^for each opponent, (?:you )?(.+)$/, (m) => readSentence(m[1])],
  [/^any number of target opponents each sacrifice [^.]+? and lose (\w+) life$/, (m) => {
    const count = readCount(m[1])
    return count === null ? null : [{ op: 'life', who: 'opponent', sign: -1, count }]
  }],
  [/^goad (target .+)$/, (m) => onTarget(m[1], () => [])],
  [/^(?:~|he|she|it) gets? [+-]\d+\/[+-]\d+ until end of turn for each [^.]*(?:defending player|an opponent|your opponents) controls?$/, () => nothing('Nothing on the other side to count')],
  // A tempting offer nobody is there to take.
  [/^each opponent may search their library [^.]+$/, () => []],
  [/^for each opponent who [^,]+, [^.]+$/, () => []],
  [/^then each player who searched a library this way shuffles$/, () => []],
  [/^~ fights (?:up to one )?(?:other )?target creature (?:you don't control|an opponent controls)$/, () => nothing('Nothing on the other side to fight')],

  // --- costs ---------------------------------------------------------------
  // Paid as the spell resolves rather than as it is cast: with nobody to
  // respond in between, the two are the same thing.
  [/^as an additional cost to cast (?:~|this spell), (.+)$/, (m) => readSentence(m[1])],

  // --- the stack -----------------------------------------------------------
  [/^counter target [a-z, ]*?(?:spell|ability)(?: unless its controller pays \{\d+\})?$/, () => nothing('No spell on the other side to counter')],
  [/^(?:~|this spell) can't be countered$/, () => []],
]

/** One instruction, by the patterns alone. */
function readPlain(s: string): Effect[] | null {
  for (const [pattern, build] of PATTERNS) {
    const m = pattern.exec(s)
    if (m) {
      const effects = build(m)
      if (effects) return effects
    }
  }
  return null
}

/** The effects of one sentence, or null. Whole-sentence patterns first, so
 *  "you may play an additional land" is the permission it is rather than a
 *  question; then "you may …", "each player may …" and "if you do, …"; then
 *  "… and …" and "…, then …" as two, when both halves read on their own. */
export function readSentence(sentence: string): Effect[] | null {
  const s = sentence.trim().replace(/\.$/, '')
    // Baldin's "up to one hundred target creatures each get": as many as
    // you like.
    .replace(/^up to one hundred target (.+?) each (?=gets?\b)/, 'up to 100 target $1 ')
    .replace(/^search your library for any number of /, 'search your library for up to 99 ')

  // "…, where X is the number of lands you control": the sentence without
  // it, and then that amount wherever it says X. It may sit in the middle —
  // "up to X basic land cards, where X is …, put them onto the battlefield".
  const where = /^(.+?),? where x is ([^,;]+)([,;].+)?$/.exec(s)
  if (where) {
    const n = readAmount(where[2], speaking())
    const inner = n === null ? null : readSentence(where[1] + (where[3] ?? ''))
    return inner && inner.map((effect) => withX(effect, n!))
  }
  // "When you do, …" follows from what the sentence before it had you do.
  const reflexive = /^when you do, (.+)$/.exec(s)
  if (reflexive) return readSentence(reflexive[1])

  const plain = readPlain(s)
  if (plain) return plain
  // "…at the beginning of the next end step": the same thing, then. Only of
  // one instruction, so that "do this and exile it at the end step" is not
  // all put off.
  const later = /^(.+?) at the beginning of the next end step$/.exec(s)
  const then = later && readPlain(later[1])
  if (then) return [{ op: 'later', effects: then }]
  const optional = /^(you|each player) may (?:have ~ )?(.+)$/.exec(s)
  if (optional) {
    // Asked once: the first effect carries the question, and the rest of
    // the sentence follows only if the answer was yes. "Each player may
    // search their library" is you searching yours.
    const inner = readSentence(optional[1] === 'you' ? optional[2] : optional[2].replace(/\btheir library\b/, 'your library'))
    // Nothing to do is not worth a question.
    if (inner?.every((effect) => effect.op === 'nothing')) return inner
    return inner && inner.map((effect, i) => (i === 0 ? { ...effect, optional: true } : { ...effect, ifDone: true }))
  }
  const ifDone = /^if you do, (.+)$/.exec(s)
  if (ifDone) {
    const inner = readSentence(ifDone[1])
    return inner && inner.map((effect) => ({ ...effect, ifDone: true }))
  }
  for (const joint of [/^(.+?),? and (.+)$/, /^(.+?), then (.+)$/]) {
    const halves = joint.exec(s)
    if (!halves) continue
    const first = readSentence(halves[1])
    // "Put a +1/+1 counter on that creature and a plan counter on ~": the
    // second half borrows the first's verb.
    const elided = /^put /.test(halves[1]) && /^(an?|\w+) ([+-]\d\/[+-]\d|[a-z]+) counters? on /.test(halves[2])
    const rest = elided ? `put ${halves[2]}` : halves[2]
    const second = first && after(first, () => referring(referentOf(first, referent), () => readSentence(rest)))
    if (first && second) return [...first, ...second]
  }
  return null
}

/** "For each" of something that has happened this turn rather than
 *  something on the battlefield. */
function readEach(phrase: string): Count | null {
  if (/^creature put into your graveyard from the battlefield this turn$/.test(phrase)) return { tally: 'died' }
  if (/^creature that died this turn$/.test(phrase)) return { tally: 'died' }
  if (/^card you've discarded this turn$/.test(phrase)) return { tally: 'discarded' }
  if (/^card you've drawn this turn$/.test(phrase)) return { tally: 'drawn' }
  // What paid the cost: itself, and whatever went with it.
  if (/^creature sacrificed this way$/.test(phrase)) return 'thatMany'
  return null
}

/** Read what follows these effects: if one of them was a sacrifice, "the
 *  sacrificed creature" is what it chose. */
function after<T>(effects: readonly Effect[], read: () => T): T {
  const before = sacrificed
  sacrificed = before || effects.some((effect) => effect.op === 'choose' && effect.must === true)
  try {
    return read()
  } finally {
    sacrificed = before
  }
}

/** Where the cards not taken go: "on the bottom of your library in a random
 *  order", "into your graveyard". */
function readRest(phrase: string): 'bottom' | 'graveyard' | 'top' | null {
  if (/^on the bottom(?: of your library)?(?: in (?:any|a random) order)?$/.test(phrase)) return 'bottom'
  if (/^into your graveyard$/.test(phrase)) return 'graveyard'
  if (/^(?:back )?on top(?: of your library)?(?: in any order)?$/.test(phrase)) return 'top'
  return null
}

/** "Look at the top N cards", and what the sentences after it say to do
 *  with them. */
function readDig(howMany: string, tail: string): Effect[] | null {
  const count = readCount(howMany)
  if (count === null) return null
  let take: Extract<Effect, { op: 'dig' }> | null = null
  let rest: 'bottom' | 'graveyard' | 'top' | null = null
  const blank = { op: 'dig' as const, count, tapped: false, rest: 'top' as const }

  for (const part of tail.split('; ')) {
    // Kicker is not offered: the unkicked half is what happens.
    if (/^if ~ was kicked, .+ instead$/.test(part)) continue
    // Call to the Kindred: "if you do, you may put …, then you put the rest
    // of those cards on the bottom". The looking was what was optional.
    const said = part.replace(/^if you do, /, '')
    const leftover = /^(.+?) and the rest (.+)$/.exec(said)
      ?? /^(.+?), then (?:you )?put the rest(?: of those cards)? (.+)$/.exec(said)
    const body = leftover ? leftover[1] : said
    if (leftover) rest = readRest(leftover[2])
    if (leftover && !rest) return null

    const all = /^put all (.+?) from among them (onto the battlefield( tapped)?|into your hand)$/.exec(body)
    const some = all ? null : /^(you may )?(?:reveal|put) (an?|up to (\w+)|(\w+)) (.+?) from among them(?: and put (?:it|them|that card))? (into your hand|onto the battlefield( tapped)?)$/.exec(body)
    const any = /^put (\w+) of (?:them|those cards) (into your hand|onto the battlefield)$/.exec(body)
    const away = /^(?:then )?put the rest (.+)$/.exec(body)
    if (some) {
      const filter = readFilter(some[5])
      const n = readNumber(some[3] ?? some[4] ?? 'one')
      if (!filter || n === null) return null
      take = {
        ...blank, take: filter, takeCount: n, upTo: Boolean(some[1] || some[3]),
        to: some[6] === 'into your hand' ? 'hand' : 'battlefield', tapped: Boolean(some[7]),
      }
    } else if (any) {
      const n = readNumber(any[1])
      if (n === null) return null
      take = { ...blank, take: null, takeCount: n, upTo: false, to: any[2] === 'into your hand' ? 'hand' : 'battlefield' }
    } else if (all) {
      const filter = readFilter(all[1])
      if (!filter) return null
      take = {
        ...blank, take: filter, takeCount: 'all', upTo: false,
        to: all[2] === 'into your hand' ? 'hand' : 'battlefield', tapped: Boolean(all[3]),
      }
    } else if (away) {
      rest = readRest(away[1])
      if (!rest) return null
    } else return null
  }
  return take && rest ? [{ ...take, rest }] : null
}

/** "Look at the top card of your library. If it's a land card, you may put
 *  it onto the battlefield. If you don't …, put it into your hand." */
const TOP_CARD = new RegExp([
  /^(?:look at|reveal) the top card of your library\. /,
  /if it's an? (.+? )?card( of the chosen type)?, (you may )?(?:reveal it and )?put it (onto the battlefield( tapped)?|into your hand)\./,
  /(?: (?:otherwise|if you don't put the card (?:onto the battlefield|into your hand)), (you may )?put (?:it|that card) (into your hand|on the bottom of your library|into your graveyard)\.)?$/,
].map((part) => part.source).join(''))

/** "Reveal the top card of your library. If it's a creature card that shares
 *  a creature type with a creature you control, you may cast it without
 *  paying its mana cost. If you don't cast it, put it on the bottom." */
const TOP_CAST = new RegExp([
  /^(?:look at|reveal) the top card of your library\. /,
  /(?:if it's an? (.+?), )?you may cast (?:it|that card) without paying its mana cost\./,
  /(?: if you don't cast it, put it (on the bottom of your library|into your graveyard)\.)?/,
  /( do this only once each turn\.)?$/,
].map((part) => part.source).join(''))

/** Shapes that run across sentences, tried on an ability's whole text before
 *  it is split. */
export function readCompound(text: string): Effect[] | null {
  const said = text.trim().toLowerCase().replace(/([^.])$/, '$1.')
  const cast = TOP_CAST.exec(said)
  if (cast) {
    const read = cast[1] ? readFilter(cast[1]) : {}
    // A land is played, not cast, whatever else the card would have of it.
    return read && [{
      op: 'topCard', match: { ...read, not: [...(read.not ?? []), 'land'] }, hit: 'cast', tapped: false, ask: true,
      miss: !cast[2] ? 'stay' : cast[2] === 'into your graveyard' ? 'graveyard' : 'bottom', missAsk: false,
      ...(cast[3] ? { once: true } : {}),
    }]
  }
  // Peer Pressure: whatever type is chosen, they are all yours already.
  if (/^choose a creature type\. if you control more creatures of that type than each other player, you gain control of all creatures of that type\.$/.test(said)) {
    return nothing('Everything here is already yours')
  }
  // Chaos Warp, on the only permanents there are.
  if (/^the owner of target permanent shuffles it into their library, then reveals the top card of their library\. if it's a permanent card, they put it onto the battlefield\.$/.test(said)) {
    return [
      { op: 'choose', filter: {}, count: 1, upTo: false },
      { op: 'shuffleIn', what: { kind: 'chosen' } },
      { op: 'topCard', match: { not: ['instant', 'sorcery'] }, hit: 'battlefield', tapped: false, ask: false, miss: 'stay', missAsk: false },
    ]
  }
  const top = TOP_CARD.exec(said)
  if (!top) return null
  const [, kind, chosen, may, where, tapped, missMay, missWhere] = top
  // "A card of the chosen type" is any card of it; and with neither a kind
  // nor a chosen type there is nothing being looked for.
  const read = kind ? readFilter(kind) : chosen ? {} : null
  if (!read) return null
  const match = chosen ? { ...read, chosenType: true } : read
  const miss = missWhere === 'into your hand' ? 'hand' : missWhere === 'into your graveyard' ? 'graveyard' : missWhere ? 'bottom' : 'stay'
  return [{
    op: 'topCard', match, hit: where === 'into your hand' ? 'hand' : 'battlefield',
    tapped: Boolean(tapped), ask: Boolean(may), miss, missAsk: Boolean(missMay),
  }]
}

/** Riders on a triggered ability rather than effects of it. */
const ONCE = /^(?:this ability triggers|do this) only once each turn$/

/**
 * An ability's text as its sentences. A full stop ends one — or a full stop
 * and the quotation mark that closes what a token says — but not a full stop
 * inside those quotes: `It has "{2}: Draw a card. Activate only as a
 * sorcery."` is one sentence.
 */
export function sentences(text: string): string[] {
  const out: string[] = []
  let quoted = false
  let start = 0
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (ch === '"') quoted = !quoted
    const ends = !quoted && (ch === '.' || (ch === '"' && text[i - 1] === '.'))
    if (ends && /\s/.test(text[i + 1] ?? '')) {
      out.push(text.slice(start, i + 1).trim())
      start = i + 1
    }
  }
  const rest = text.slice(start).trim()
  if (rest) out.push(rest)
  return out.filter(Boolean)
}

/** "Create two of those tokens": the token the sentence before made, again. */
function thoseTokens(body: string, before: readonly Effect[]): Effect[] | null {
  const m = /^create (\w+) of those tokens$/.exec(body)
  const made = before.find((effect) => effect.op === 'token')
  const count = m && readCount(m[1])
  return m && made?.op === 'token' && count !== null ? [{ ...made, count: count! }] : null
}

/**
 * The text of one ability, compiled: every sentence that reads, and whether
 * all of them did. A sentence that does not read leaves the ability
 * incomplete; it still runs what was understood, and its words are posted.
 */
export function readAbility(
  text: string, about: Aim | null = null,
): { effects: Effect[]; complete: boolean; once: boolean } {
  const compound = readCompound(text)
  if (compound) return { effects: compound, complete: true, once: false }
  const effects: Effect[] = []
  let complete = true
  let once = false
  let understood = true
  /** What "it" means so far: to begin with, the card the ability is about,
   *  if it is about one. */
  let it: Aim | null = about
  // A search that says where its cards go in the sentence after is one
  // instruction: "…for up to X basic land cards. Reveal those cards, put
  // them into your hand, then shuffle."
  text = text.replace(/(search your library for [^.]+?)\. (reveal (?:those cards|them|it), put )/i, '$1, $2')
    .replace(/(search your library for [^.]+? and reveal them)\. (put \w+ of them )/i, '$1, $2')
  /** A counterspell has been read: there was no spell, so what the card goes
   *  on to say about that spell and whoever cast it is nothing as well. */
  let countered = false
  // …and so is "reveal cards until you reveal a creature card. Put that
  // card into your hand and the rest into your graveyard."
  text = text.replace(/(until you reveal an? [^.]+?)\. (put that card )/i, '$1, $2')
  // Looking at the top few cards runs on for as long as the sentences are
  // about them: those are joined to it, to be read as one instruction.
  const parts: string[] = []
  for (const sentence of sentences(text)) {
    const before = parts[parts.length - 1] ?? ''
    const looking = /^(?:[^.;]*, |you may )?(?:look at|reveal) the top \w+ cards of your library\b/i.test(before.split('; ')[0])
    if (looking && /\b(from among them|of them|of those cards|the rest|was kicked)\b/i.test(sentence)) {
      parts[parts.length - 1] = `${before.replace(/\.$/, '')}; ${sentence}`
    } else parts.push(sentence)
  }
  /** Where the sentence before this one's effects begin, for an "instead". */
  let previous = 0
  /** The sentence before aimed at something only the other side could have,
   *  so there is no "it" for what follows to be about. */
  let nobody = false
  for (const sentence of parts) {
    let s = sentence.trim().replace(/\.$/, '').toLowerCase()
    if (!s) continue
    if (countered && /\b(that spell|that spell's|its controller|that player)\b/.test(s)) continue
    if (nobody && /\b(it|its|they|them|that (?:creature|permanent|player)|those creatures)\b/.test(s)) continue

    // Suspend given by the effect that exiled it: the counters are the
    // whole of it here.
    if (/^if it doesn't have suspend, it gains suspend$/.test(s)) continue
    // An additional cost that is not offered was not paid.
    if (/^if (?:~|this spell)'s additional cost was paid, /.test(s)) continue
    // An emblem carries its words as printed, to be read when it exists.
    const emblem = /^you get an emblem with "(.+?)\.?"(?: and "(.+?)\.?")?$/i.exec(sentence.trim())
    if (emblem) {
      effects.push({ op: 'emblem', text: [emblem[1], emblem[2]].filter(Boolean).map((line) => `${line}.`).join('\n') })
      continue
    }
    // "If you control a Bird, draw a card": done or not, as it resolves.
    const plain = /^if (?!you do\b|you don't\b)(.+?), (.+)$/.exec(s)
    if (plain && !/\binstead\b/.test(s)) {
      // What it asks about may be what the sentence before did, so one that
      // did not read leaves this in words too.
      const test: Test | null = understood ? referring(it, () => readTest(plain[1], speaking())) : null
      const then: Effect[] | null = test && after(effects, () => referring(it, () => readSentence(plain[2])))
      if (test && then) {
        previous = effects.length
        effects.push({ op: 'if', test, then, otherwise: [] })
      } else complete = false
      understood = Boolean(test && then)
      continue
    }

    // "If that land is a Forest, put two counters on ~ instead": this, in
    // place of what the sentence before it said, when the condition holds.
    if (/\binstead\b/.test(s) && /^if /.test(s)) {
      const m = /^if (.+?), (.+)$/.exec(s)
      const body = m ? m[2].replace(/^instead /, '').replace(/ instead$/, '') : ''
      const was = effects.slice(previous)
      const test = m && referring(it, () => readTest(m[1], speaking()))
      const then = test && was.length
        ? thoseTokens(body, was) ?? after(effects, () => referring(it, () => readSentence(body)))
        : null
      if (test && then) effects.splice(previous, was.length, { op: 'if', test, then, otherwise: was })
      else complete = false
      understood = Boolean(test && then)
      continue
    }

    // What follows a token being made and is about the token: haste, and
    // how long it has.
    const made = effects[effects.length - 1]
    if (made && (made.op === 'copy' || made.op === 'token')) {
      if (/^(?:that token|it|the token|they|those tokens) gains? haste$/.test(s)) {
        effects[effects.length - 1] = made.op === 'copy'
          ? { ...made, change: { ...made.change, keywords: [...(made.change.keywords ?? []), 'Haste'] } }
          : { ...made, token: { ...made.token, keywords: [...made.token.keywords, 'Haste'] } }
        continue
      }
      if (/^(?:exile|sacrifice) (?:it|them|that token|those tokens|the tokens?) at the beginning of the next end step$/.test(s)) {
        effects[effects.length - 1] = { ...made, fleeting: true }
        continue
      }
      if (made.op === 'copy' && /^(?:the tokens?|it|they) enters? tapped and attacking$/.test(s)) {
        effects[effects.length - 1] = { ...made, tapped: true, attacking: true }
        continue
      }
    }
    // …or about what was brought back: "exile those creatures at the
    // beginning of your next upkeep".
    if (made?.op === 'reanimate' && /^exile (?:those creatures|them|it) at the beginning of your next upkeep$/.test(s)) {
      effects[effects.length - 1] = { ...made, until: 'upkeep' }
      continue
    }

    // What a token is made with, in quotes: `…token with "~ can't block."`
    // The token carries those words; here the sentence is read without them.
    const saying = /^(.*\btokens?) with "(.+?)\.?"$/.exec(sentence.trim().replace(/\.$/, ''))
    if (saying) s = saying[1].toLowerCase()
    if (/^counter target [a-z, ]*?(spell|ability)\b/.test(s)) {
      countered = true
      effects.push(...nothing('No spell on the other side to counter'))
      continue
    }
    // Mob Rule: "gain control of all creatures with power 4 or greater" is
    // no change at a table where they are all yours — but it is who "those
    // creatures" are in what follows.
    const all = /^gain control of (all .+?) until end of turn$/.exec(s)
    const everyone = all && readFilter(all[1].replace(/^all /, ''))
    if (everyone) {
      it = { kind: 'each', filter: everyone }
      continue
    }
    if (ONCE.test(s)) {
      once = true
      continue
    }
    // What a token is made with, in quotes after it: "It has "Sacrifice this
    // token: Add {C}."" The token carries those words, and they are compiled
    // when it exists.
    const rider = /^(?:it has|they have) "(.+?)\.?"$/.exec(sentence.trim().replace(/\.$/, ''))
    if (rider && made?.op === 'token') {
      effects[effects.length - 1] = { ...made, token: { ...made.token, text: rider[1] } }
      continue
    }
    // "If you do, …" hangs on the sentence before it. If that one was not
    // understood, neither is this: running it would hand out the reward
    // without the price.
    // …and so does a sentence about "it", when what "it" is was in a
    // sentence that did not read: better left in words than aimed at the
    // wrong thing.
    const dangling = !understood && (
      /^(if|when) you do,/.test(s)
      || /\b(it|its|them|they|those|that (?:creature|card|permanent|land|token))\b/.test(s)
    )
    const read: Effect[] | null = dangling
      ? null
      : after(effects, () => referring(it, () => readSentence(s)))
    understood = read !== null
    nobody = Boolean(read?.length === 1 && read[0].op === 'nothing')
    if (read) {
      previous = effects.length
      effects.push(...read.map((effect) => (
        saying && effect.op === 'token' ? { ...effect, token: { ...effect.token, text: saying[2] } } : effect
      )))
      it = referentOf(read, it)
    } else complete = false
  }
  return { effects, complete, once }
}
