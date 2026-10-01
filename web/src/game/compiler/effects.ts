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
import type { Aim, Count, Effect, Signed, TokenSpec } from './ir'
import {
  readAmount, readCount, readFilter, readNumber, readTest, readToken, type Speaking,
} from './read'
import { readKeywords } from './statics'

type Pattern = [RegExp, (m: RegExpExecArray) => Effect[] | null]

/** "~", "it", "itself", "he" — the source. */
const SELF = /^(~|it|itself|he|she|him|her)$/

/** What "it", "that creature" and "they" mean just now, when a sentence
 *  before this one picked something out: the target of "destroy target
 *  creature", in "its controller gains…" after it. Null where nothing was,
 *  and then "it" is the card itself. */
let referent: Aim | null = null

const PRONOUN = /^(it|that creature|that permanent|that land|that artifact|them|they|those creatures|those permanents)$/

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

/** What these effects leave "it" meaning: the last thing targeted. A
 *  sacrifice does not count — nobody says "it" of what is gone. */
function referentOf(effects: readonly Effect[], otherwise: Aim | null): Aim | null {
  return effects.some((effect) => effect.op === 'choose' && !effect.must) ? { kind: 'chosen' } : otherwise
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
  const m = /^(?:(up to )(\w+) )?(?:(\w+) )?(?:other )?target (.+)$/.exec(phrase)
  if (!m) return null
  const [, upTo, upCount, plainCount, noun] = m
  const count = readNumber(upCount ?? plainCount ?? 'one')
  const filter = readFilter(noun)
  if (count === null || !filter) return null
  if (filter.controller === 'opponent') return nothing('Nothing on the other side to target')
  return [{ op: 'choose', filter, count, upTo: Boolean(upTo) }, ...act({ kind: 'chosen' })]
}

/** "~", "each creature you control", "creatures you control", or "target
 *  creature": what an effect that acts on permanents acts on. */
function onPermanents(phrase: string, act: (what: Aim) => Effect[]): Effect[] | null {
  if (referent && PRONOUN.test(phrase)) return act(referent)
  if (SELF.test(phrase)) return act({ kind: 'self' })
  if (/^(that creature|equipped creature|enchanted creature)$/.test(phrase)) return act({ kind: 'event' })
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
  [/^discard cards equal to (?:its|that creature's|the sacrificed creature's) (power|toughness)$/, (m) => (
    [{ op: 'discard', count: { stat: m[1] as 'power' | 'toughness', of: 'event' } }]
  )],
  [/^draw cards equal to (.+)$/, (m) => counted(m[1], (count) => [{ op: 'draw', count }])],
  [/^(?:you )?draw a card for each (.+)$/, (m) => {
    const filter = readFilter(m[1])
    return filter ? [{ op: 'draw', count: { per: filter } }] : null
  }],
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

  [/^(?:you )?(gain|lose) life equal to (.+)$/, (m) => (
    counted(m[2], (count) => [{ op: 'life', who: 'you', sign: m[1] === 'gain' ? 1 : -1, count }])
  )],
  [/^(?:each opponent|target opponent|target player) loses life equal to (.+)$/, (m) => (
    counted(m[1], (count) => [{ op: 'life', who: 'opponent', sign: -1, count }])
  )],

  // --- damage --------------------------------------------------------------
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
      const filter = readFilter(m[4])
      return filter && count === 1 ? [makes(token, { per: filter }, Boolean(m[2]))] : null
    }
    return [makes(token, count, Boolean(m[2]))]
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
  [/^(?:its controller|that creature's controller|that permanent's controller) creates (.+)$/, (m) => readSentence(`create ${m[1]}`)],
  // The token's own abilities, in quotes. It is made; using them is yours.
  [/^(?:it has|they have|it gains|they gain) ".+"$/, () => []],

  // --- counters ------------------------------------------------------------
  [/^put (\w+) ([+-]\d\/[+-]\d|[a-z]+) counters? on (.+)$/, (m) => {
    const count = readCount(m[1])
    if (count === null) return null
    const counter = m[2]
    return onPermanents(m[3], (to) => [{ op: 'counters', to, count, counter }])
  }],
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
  // Cultivate and Kodama's Reach: one to the battlefield, one to hand.
  [/^search your library for up to two (.+?) cards, reveal those cards, put one onto the battlefield( tapped)? and the other into your hand,? then shuffle$/, (m) => {
    const filter = readFilter(m[1])
    return filter ? [{ op: 'search', filter, count: 2, upTo: true, to: 'battlefield', tapped: Boolean(m[2]), restToHand: true }] : null
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
  [/^reveal cards from the top of your library until you reveal an? (.+?) card, put that card (into your hand|onto the battlefield) and the rest (.+)$/, (m) => {
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

  // --- permanents ----------------------------------------------------------
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
  [/^return (.+?) to (?:its owner's hand|their owner's hand|their owners' hands)$/, (m) => {
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
  [/^return (up to (\w+) )?(?:target )?(.+?) cards? from your graveyard to (your hand|the battlefield)(?: tapped)?$/, (m) => {
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

  [/^pay ((?:\{[^}]+\})+)$/, (m) => [{ op: 'pay', cost: m[1].toUpperCase() }]],

  // --- the other side of the table -----------------------------------------
  // A threaten, on the only creatures there are: it is yours already, and
  // what is left is what comes after — untapped, and hasty.
  [/^gain control of (target .+?) until end of turn$/, (m) => onTarget(m[1], () => [])],
  [/^gain control of target (?!.*until end of turn)[^.]+$/, () => nothing('Everything here is already yours')],
  [/^(?:that player|each opponent|target opponent|each other player|defending player) sacrifices (?!.* and you )[^.]+$/, () => nothing('Nothing on the other side to sacrifice')],
  [/^(?:it|that creature|they) can't be regenerated$/, () => []],
  // One opponent.
  [/^for each opponent, (?:you )?(.+)$/, (m) => readSentence(m[1])],
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

/** The effects of one sentence, or null. Whole-sentence patterns first, so
 *  "you may play an additional land" is the permission it is rather than a
 *  question; then "you may …", "each player may …" and "if you do, …"; then
 *  "… and …" and "…, then …" as two, when both halves read on their own. */
export function readSentence(sentence: string): Effect[] | null {
  const s = sentence.trim().replace(/\.$/, '')
    // Baldin's "up to one hundred target creatures each get": as many as
    // you like.
    .replace(/^up to one hundred target (.+?) each (?=gets?\b)/, 'up to 100 target $1 ')

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

  for (const [pattern, build] of PATTERNS) {
    const m = pattern.exec(s)
    if (m) {
      const effects = build(m)
      if (effects) return effects
    }
  }
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
    const second = first && after(first, () => referring(referentOf(first, referent), () => readSentence(halves[2])))
    if (first && second) return [...first, ...second]
  }
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
    const leftover = /^(.+?) and the rest (.+)$/.exec(part)
    const body = leftover ? leftover[1] : part
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
  /if it's an? (.+?) card, (you may )?(?:reveal it and )?put it (onto the battlefield( tapped)?|into your hand)\./,
  /(?: (?:otherwise|if you don't put the card (?:onto the battlefield|into your hand)), (you may )?put (?:it|that card) (into your hand|on the bottom of your library|into your graveyard)\.)?$/,
].map((part) => part.source).join(''))

/** Shapes that run across sentences, tried on an ability's whole text before
 *  it is split. */
export function readCompound(text: string): Effect[] | null {
  const top = TOP_CARD.exec(text.trim().toLowerCase().replace(/([^.])$/, '$1.'))
  if (!top) return null
  const match = readFilter(top[1])
  if (!match) return null
  const miss = top[6] === 'into your hand' ? 'hand' : top[6] === 'into your graveyard' ? 'graveyard' : top[6] ? 'bottom' : 'stay'
  return [{
    op: 'topCard', match, hit: top[3] === 'into your hand' ? 'hand' : 'battlefield',
    tapped: Boolean(top[4]), ask: Boolean(top[2]), miss, missAsk: Boolean(top[5]),
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
export function readAbility(text: string): { effects: Effect[]; complete: boolean; once: boolean } {
  const compound = readCompound(text)
  if (compound) return { effects: compound, complete: true, once: false }
  const effects: Effect[] = []
  let complete = true
  let once = false
  let understood = true
  /** What "it" means so far. */
  let it: Aim | null = null
  // A search that says where its cards go in the sentence after is one
  // instruction: "…for up to X basic land cards. Reveal those cards, put
  // them into your hand, then shuffle."
  text = text.replace(/(search your library for [^.]+?)\. (reveal (?:those cards|them|it), put )/i, '$1, $2')
  /** A counterspell has been read: there was no spell, so what the card goes
   *  on to say about that spell and whoever cast it is nothing as well. */
  let countered = false
  // …and so is "reveal cards until you reveal a creature card. Put that
  // card into your hand and the rest into your graveyard."
  text = text.replace(/(until you reveal an? [^.]+? card)\. (put that card )/i, '$1, $2')
  // Looking at the top few cards runs on for as long as the sentences are
  // about them: those are joined to it, to be read as one instruction.
  const parts: string[] = []
  for (const sentence of sentences(text)) {
    const before = parts[parts.length - 1] ?? ''
    const looking = /^(?:[^.;]*, )?(?:look at|reveal) the top \w+ cards of your library\b/i.test(before.split('; ')[0])
    if (looking && /\b(from among them|of them|of those cards|the rest|was kicked)\b/i.test(sentence)) {
      parts[parts.length - 1] = `${before.replace(/\.$/, '')}; ${sentence}`
    } else parts.push(sentence)
  }
  /** Where the sentence before this one's effects begin, for an "instead". */
  let previous = 0
  for (const sentence of parts) {
    let s = sentence.trim().replace(/\.$/, '').toLowerCase()
    if (!s) continue
    if (countered && /\b(that spell|that spell's|its controller|that player)\b/.test(s)) continue

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
    const made = effects[effects.length - 1]
    if (rider && made?.op === 'token') {
      effects[effects.length - 1] = { ...made, token: { ...made.token, text: rider[1] } }
      continue
    }
    // "If you do, …" hangs on the sentence before it. If that one was not
    // understood, neither is this: running it would hand out the reward
    // without the price.
    const read: Effect[] | null = /^if you do,/.test(s) && !understood
      ? null
      : after(effects, () => referring(it, () => readSentence(s)))
    understood = read !== null
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
