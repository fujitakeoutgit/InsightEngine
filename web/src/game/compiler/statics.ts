/**
 * Static abilities: the lines that are simply true while the permanent is
 * there. The ones read here are those the engine applies — extra land drops,
 * counters on arrival, and changes to size and keywords — plus a list of
 * those that are true and make no difference at a table with one player.
 */

import type { ManaType } from '../mana'
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

  if (/^lands you control are every basic land type in addition to their other types$/.test(l)) {
    return { kind: 'everyLandType' }
  }
  if (/^ascend$/.test(l)) return { kind: 'ascend' }
  if (/^~ can't attack or block unless you have the city's blessing$/.test(l)) return { kind: 'needsBlessing' }
  if (/^if damage would be dealt to ~ while it has a \+1\/\+1 counter on it, prevent that damage and remove a \+1\/\+1 counter from ~$/.test(l)) {
    return { kind: 'counterShield' }
  }
  const echo = /^echo ((?:\{[^}]+\})+)$/.exec(l)
  if (echo) return { kind: 'echo', cost: echo[1].toUpperCase() }

  // "Whenever you tap a Forest for mana, add an additional {G}."
  const more = /^whenever you tap an? (.+?) for (mana|\{c\}), add an additional \{([wubrgc])\}$/.exec(l)
  if (more) {
    const tapped = readFilter(more[1])
    return tapped && {
      kind: 'extraMana', tapped, adds: more[3].toUpperCase() as ManaType,
      ...(more[2] === 'mana' ? {} : { of: 'C' as ManaType }),
    }
  }

  // Anger: a standing ability that works from the graveyard.
  const buried = /^as long as ~ is in your graveyard and you control an? (.+?), (.+)$/.exec(l)
  if (buried) {
    const needs = readFilter(buried[1])
    const inner = readStatic(buried[2])
    return needs && inner?.kind === 'boost' && !inner.condition
      ? { ...inner, from: 'graveyard', condition: { atLeast: 1, filter: { ...needs, controller: 'you' } } }
      : null
  }

  if (/^as ~ enters, choose a creature type$/.test(l)) return { kind: 'chooseType' }
  if (/^~ is the chosen type in addition to its other types$/.test(l)) return { kind: 'isChosenType' }
  if (/^creatures you control are every creature type\b/.test(l)) return { kind: 'everyCreatureType' }

  // "Blue spells you cast cost {1} less to cast", "creature spells you cast
  // of the chosen type cost {1} less", and Morophon's five colors.
  const cheaper = /^(?:(.+?) )?spells (?:you cast( of the chosen type)?|of the chosen type you cast) cost ((?:\{[^}]+\})+) less to cast(?:\. this effect reduces only the amount of colored mana you pay)?$/.exec(l)
  if (cheaper) {
    const read = cheaper[1] ? readFilter(cheaper[1]) : {}
    const generic = /^\{(\d+)\}$/.exec(cheaper[3])
    const colored = /^(?:\{[wubrg]\})+$/.test(cheaper[3]) ? cheaper[3].replace(/[{}]/g, '').toUpperCase() : null
    if (!read || (!generic && !colored)) return null
    const filter = / of the chosen type/.test(l) ? { ...read, chosenType: true } : read
    return { kind: 'costLess', filter, amount: generic ? Number(generic[1]) : 0, ...(colored ? { colored } : {}) }
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
  const anthem = /^(.+?) you control( of the chosen type)? (?:get ([+-]\d+)\/([+-]\d+)(?: and have (.+))?|have (.+))$/.exec(l)
  if (anthem) {
    const filter = readFilter(anthem[1])
    if (filter) {
      const boost: Boost = {
        power: Number(anthem[3] ?? 0),
        toughness: Number(anthem[4] ?? 0),
        keywords: readKeywords(anthem[5] ?? anthem[6] ?? ''),
      }
      return { kind: 'boost', to: { ...filter, controller: 'you', ...(anthem[2] ? { chosenType: true } : {}) }, boost }
    }
  }

  // "Each creature you control that's a Food or a Golem gets +2/+2 and has
  // trample."
  const those = /^each creature you control that's an? (.+?) gets ([+-]\d+)\/([+-]\d+)(?: and has (.+))?$/.exec(l)
  if (those) {
    const kinds = readFilter(those[1].replace(/ or an? /g, ' or '))
    if (kinds?.subtypes && !kinds.types) {
      return {
        kind: 'boost',
        to: { types: ['creature'], subtypes: kinds.subtypes, controller: 'you' },
        boost: { power: Number(those[2]), toughness: Number(those[3]), keywords: readKeywords(those[4] ?? '') },
      }
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
