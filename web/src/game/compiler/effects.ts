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
import type { Aim, Count, Effect } from './ir'
import { readCount, readFilter, readNumber, readToken } from './read'

type Pattern = [RegExp, (m: RegExpExecArray) => Effect[] | null]

/** "~", "it", "itself" — the source. */
const SELF = /^(~|it|itself)$/

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

/** "~", "each creature you control", or "target creature": what an effect
 *  that acts on permanents acts on. */
function onPermanents(phrase: string, act: (what: Aim) => Effect[]): Effect[] | null {
  if (SELF.test(phrase)) return act({ kind: 'self' })
  const each = /^(?:each|all) (.+)$/.exec(phrase)
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
  [/^you lose (\w+) life$/, (m) => {
    const count = readCount(m[1])
    return count === null ? null : [{ op: 'life', who: 'you', sign: -1, count }]
  }],
  [/^(?:each opponent|target opponent|target player) loses (\w+) life$/, (m) => {
    const count = readCount(m[1])
    return count === null ? null : [{ op: 'life', who: 'opponent', sign: -1, count }]
  }],
  // Swords to Plowshares, on the only creatures there are: yours.
  [/^its controller gains life equal to its (power|toughness)$/, (m) => (
    [{ op: 'life', who: 'you', sign: 1, count: { stat: m[1] as 'power' | 'toughness', of: 'chosen' } }]
  )],
  [/^(?:you )?gain life equal to (?:the|its) (power|toughness)(?: of (.+))?$/, (m) => {
    const stat = m[1] as 'power' | 'toughness'
    if (!m[2]) return [{ op: 'life', who: 'you', sign: 1, count: { stat, of: 'self' } }]
    return onTarget(m[2], () => [{ op: 'life', who: 'you', sign: 1, count: { stat, of: 'chosen' } }])
  }],

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
  [/^~ deals (\w+) damage to (.*target creature.*)$/, (m) => {
    const count = readCount(m[1])
    return count === null ? null : onTarget(m[2], (what) => [{ op: 'damage', to: what, count }])
  }],

  // --- tokens --------------------------------------------------------------
  [/^create (\w+) (tapped )?(.+? tokens?(?: with [a-z, ]+?)?)(?: for each (.+))?$/, (m) => {
    const count = readCount(m[1])
    const token = readToken(m[3])
    if (count === null || !token) return null
    if (m[4]) {
      const filter = readFilter(m[4])
      return filter && count === 1 ? [{ op: 'token', count: { per: filter }, token, tapped: Boolean(m[2]) }] : null
    }
    return [{ op: 'token', count, token, tapped: Boolean(m[2]) }]
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

  // --- the library ---------------------------------------------------------
  [/^search your library for (up to (\w+) |(\w+) )?(.+?) cards?(?:, reveal (?:it|them|that card|those cards))?,? (?:and )?put (?:it|them|that card|those cards) (into your hand|onto the battlefield( tapped)?|on top of your library)(?:,? then shuffle)?$/, (m) => {
    const [, , upCount, plainCount, noun, where, tapped] = m
    const count = readNumber(upCount ?? plainCount ?? 'one')
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
  [/^return (.+?) to (?:its|their) owner's hand$/, (m) => {
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

  // --- the stack -----------------------------------------------------------
  [/^counter target (?:spell|creature spell|noncreature spell|activated ability|triggered ability|activated or triggered ability)(?: unless its controller pays \{\d+\})?$/, () => nothing('No spell on the other side to counter')],
  [/^(?:~|this spell) can't be countered$/, () => []],
]

/** The effects of one sentence, or null. Whole-sentence patterns first, so
 *  "you may play an additional land" is the permission it is rather than a
 *  question; then "you may …", "each player may …" and "if you do, …"; then
 *  "… and …" and "…, then …" as two, when both halves read on their own. */
export function readSentence(sentence: string): Effect[] | null {
  const s = sentence.trim().replace(/\.$/, '')
  for (const [pattern, build] of PATTERNS) {
    const m = pattern.exec(s)
    if (m) {
      const effects = build(m)
      if (effects) return effects
    }
  }
  const optional = /^(?:you|each player) may (?:have ~ )?(.+)$/.exec(s)
  if (optional) {
    // Asked once: the first effect carries the question, and the rest of
    // the sentence follows only if the answer was yes.
    const inner = readSentence(optional[1])
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
    const second = readSentence(halves[2])
    if (first && second) return [...first, ...second]
  }
  return null
}

/** Shapes that run across sentences, tried on an ability's whole text before
 *  it is split. */
const COMPOUND: [RegExp, () => Effect[]][] = [
  // Coiling Oracle.
  [/^reveal the top card of your library\. if it's a land card, put it onto the battlefield\. otherwise, put that card into your hand\.?$/,
    () => [{ op: 'topCard', land: 'battlefield', other: 'hand', ask: false }]],
  // Into the Wilds.
  [/^look at the top card of your library\. if it's a land card, you may put it onto the battlefield\.?$/,
    () => [{ op: 'topCard', land: 'battlefield', other: 'stay', ask: true }]],
]

export function readCompound(text: string): Effect[] | null {
  const t = text.trim().toLowerCase()
  for (const [pattern, build] of COMPOUND) {
    if (pattern.test(t)) return build()
  }
  return null
}
