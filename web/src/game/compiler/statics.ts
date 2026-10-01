/**
 * Static abilities: the lines that are simply true while the permanent is
 * there. The ones read here are those the engine applies — extra land drops,
 * counters on arrival, and changes to size and keywords — plus a list of
 * those that are true and make no difference at a table with one player.
 */

import type { Boost, Filter, Measure, Static } from './ir'
import { readExcept } from './copies'
import { readAmount, readCount, readFilter, readKeywords, readNumber, readTest } from './read'

const COLORS: Record<string, string> = { white: 'W', blue: 'U', black: 'B', red: 'R', green: 'G' }

/** "for each land you control" / "for each color among permanents you
 *  control" / "each land you control and each land card in your graveyard"
 *  → what to count. */
function readPer(phrase: string): Filter | 'colors' | Measure | null {
  if (/^color among permanents you control$/.test(phrase)) return 'colors'
  const measure = readMeasure(phrase)
  // A plain "for each land you control" stays the filter it always was.
  return measure && 'per' in measure ? measure.per : measure
}

function readMeasure(phrase: string): Measure | null {
  const both = /^(.+?) and each (.+)$/.exec(phrase)
  if (both) {
    const first = readMeasure(both[1])
    const second = readMeasure(both[2])
    return first && second ? { plus: [first, second] } : null
  }
  const buried = /^(?:(.+?) )?cards? in your graveyard$/.exec(phrase)
  if (buried) {
    const filter = buried[1] ? readFilter(buried[1]) : undefined
    return filter === null ? null : { zone: 'graveyard', ...(filter ? { filter } : {}) }
  }
  const filter = readFilter(phrase)
  return filter && { per: filter }
}

/** Lines that hold and change nothing here: there is nobody to cast
 *  spells in your turn, block, target your things, or take a turn of their
 *  own — so an ability only the opponent could set off never is. */
const INERT = [
  /^(?:whenever|when) (?:an opponent|a player other than you|one or more goaded creatures) /,
  /^(?:whenever|when) an? [a-z ]+? an opponent controls /,
  /^whenever you or a permanent you control becomes the target of a spell or ability an opponent controls, /,
  /^at the beginning of each (?:opponent's|other player's) /,
  /^creatures can't attack you (?:or planeswalkers you control )?unless /,
  /^untap all permanents you control during each other player's untap step\.?$/,
  /^~ can attack players who attacked you during their last turn as though it didn't have defender\.?$/,
  /: [^:]*\bactivate only if it's not your turn\.?$/,
  /^a deck can have any number of cards named ~\.?$/,
  /^~ can't be countered\.?$/,
  /^your opponents can't cast spells during your turn\.?$/,
  /^you(, [^.]+)? have (hexproof|shroud)\.?$/,
  /^you, planeswalkers you control, and other creatures you control have hexproof\.?$/,
  /^creatures your opponents control [^.]* can't block [^.]*\.?$/,
  /^~ can't be blocked( [^.]*)?\.?$/,
  /^(flanking|partner|skulk)$/,
]

export const isInert = (line: string) => INERT.some((pattern) => pattern.test(line))

/** One sentence of a spell's own discount: "~ costs {1} less to cast for
 *  each creature on the battlefield", "it also costs {1} less to cast if you
 *  control an enchantment". */
export function readCostLess(sentence: string): Static | null {
  const m = /^(?:~|it)(?: also)? costs \{(\d+)\} less to cast(?: for each (.+?)(?: on the battlefield)?| if (.+))?$/.exec(sentence.replace(/\.$/, ''))
  if (!m) return null
  const amount = Number(m[1])
  if (m[2]) {
    const per = readFilter(m[2])
    return per && { kind: 'selfCostLess', amount, per }
  }
  if (m[3]) {
    const when = readTest(m[3])
    return when && { kind: 'selfCostLess', amount, when }
  }
  return { kind: 'selfCostLess', amount }
}

export function readStatic(line: string): Static | null {
  const l = line.replace(/\.$/, '')

  const cheaper = /^(.+?) spells you cast cost \{(\d+)\} less to cast$/.exec(l)
  if (cheaper) {
    const filter = readFilter(cheaper[1])
    return filter && { kind: 'costLess', filter, amount: Number(cheaper[2]) }
  }

  if (/^you may play an additional land on each of your turns$/.test(l)) return { kind: 'extraLand', count: 1 }
  if (/^if you would gain life, you gain twice that much life instead$/.test(l)) return { kind: 'doubleLifeGain' }
  if (/^you have no maximum hand size$/.test(l)) return { kind: 'noMaxHandSize' }
  if (/^if you would draw a card except the first one you draw in each of your draw steps, draw two cards instead$/.test(l)) {
    return { kind: 'drawTwice' }
  }
  if (/^at the beginning of each player's draw step, that player draws an additional card$/.test(l)) {
    return { kind: 'extraDraw', count: 1 }
  }
  if (/^(during your turn, )?each creature( you control)? assigns combat damage equal to its toughness rather than its power$/.test(l)) {
    return { kind: 'toughnessDamage' }
  }
  if (/^creatures you control can attack as though they didn't have defender$/.test(l)) {
    return { kind: 'defendersAttack' }
  }

  // Clone and its kind. "On the battlefield" is everything here; what it
  // may copy is the noun, and "except" is how it differs.
  const clone = /^you may have ~ enter( tapped)? as a copy of (?:any|an?) (.+?)(?: on the battlefield)?(?:, except (.+))?$/.exec(l)
  if (clone) {
    const filter = readFilter(clone[2])
    const change = clone[3] ? readExcept(clone[3]) : {}
    return filter && change
      ? { kind: 'enterAsCopy', filter, change: { ...change, ...(clone[1] ? { tapped: true } : {}) } }
      : null
  }

  const counters = /^~ enters with (\w+) ([+-]\d\/[+-]\d|[a-z]+) counters? on it(?:, where x is (.+))?$/.exec(l)
  if (counters) {
    // "…X charge counters on it, where X is your life total."
    const count = counters[3] ? readAmount(counters[3]) : readCount(counters[1])
    if (count !== null && (!counters[3] || counters[1] === 'x')) {
      return { kind: 'entersWithCounters', counter: counters[2], count }
    }
  }

  // "Creatures you control get +1/+1", "Spirits you control get +1/+1 and
  // have trample and haste", "Creatures you control have haste".
  const anthem = /^(.+?) you control (?:get ([+-]\d+)\/([+-]\d+)(?: and have (.+))?|have (.+))$/.exec(l)
  if (anthem) {
    // "Spirits you control": a creature type on its own.
    const tribe = /^(other )?([a-z]+?)s$/.exec(anthem[1])
    const filter = readFilter(anthem[1])
      ?? (tribe ? { subtypes: [tribe[2][0].toUpperCase() + tribe[2].slice(1)], ...(tribe[1] ? { other: true } : {}) } : null)
    if (filter) {
      const boost: Boost = {
        power: Number(anthem[2] ?? 0),
        toughness: Number(anthem[3] ?? 0),
        keywords: readKeywords(anthem[4] ?? anthem[5] ?? ''),
      }
      return { kind: 'boost', to: { ...filter, controller: 'you' }, boost }
    }
  }

  // "~ gets +1/+1 for each land you control", "… as long as you control ten
  // or more lands", "equipped creature gets +1/-1", "… has hexproof and
  // haste".
  const own = /^(~|equipped creature|enchanted creature) (?:gets ([+-]\d+)\/([+-]\d+)(?: and has (.+?))?|has (.+?))(?: for each (.+)| as long as you control (\w+) or more (.+))?$/.exec(l)
  if (own) {
    const to = own[1] === '~' ? 'self' : 'attached'
    const boost: Boost = {
      power: Number(own[2] ?? 0),
      toughness: Number(own[3] ?? 0),
      keywords: readKeywords(own[4] ?? own[5] ?? ''),
    }
    if (own[6]) {
      const per = readPer(own[6])
      return per ? { kind: 'boost', to, boost: { ...boost, per } } : null
    }
    if (own[7]) {
      const atLeast = readNumber(own[7])
      const filter = readFilter(own[8])
      return atLeast !== null && filter
        ? { kind: 'boost', to, boost, condition: { atLeast, filter: { ...filter, controller: 'you' } } }
        : null
    }
    return { kind: 'boost', to, boost }
  }

  // "~'s power and toughness are each equal to 1 plus the number of lands
  // you control."
  const cda = /^~'s power and toughness are each equal to (?:(\w+) plus )?the number of (.+)$/.exec(l)
  if (cda) {
    const plus = cda[1] ? readNumber(cda[1]) : 0
    const filter = readFilter(cda[2])
    if (plus !== null && filter) return { kind: 'size', stats: ['power', 'toughness'], plus, measure: { per: filter } }
  }
  const devotion = /^~'s (power|toughness) is equal to your devotion to (white|blue|black|red|green)$/.exec(l)
  if (devotion) {
    return { kind: 'size', stats: [devotion[1] as 'power' | 'toughness'], plus: 0, measure: { devotion: COLORS[devotion[2]] } }
  }
  return null
}
