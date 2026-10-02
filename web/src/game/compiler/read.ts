/**
 * Reading phrases: numbers, the permanents a noun phrase means, the token a
 * creation describes. The patterns in `effects.ts` are built from these.
 *
 * Everything here works on normalized text — lowercase, the card's own name
 * replaced by "~" — so "When Wall of Omens enters" and "When this creature
 * enters" read the same.
 */

import type { Count, Filter, Test, TokenSpec, Whose } from './ir'
import { subtypeOf } from './subtypes'

const NUMBERS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, twenty: 20,
}

/** "two" → 2, "x" → 'X', "3" → 3; null for anything else. */
export function readCount(word: string): Count | null {
  const w = word.trim().toLowerCase()
  if (w === 'x') return 'X'
  if (/^\d+$/.test(w)) return Number(w)
  return NUMBERS[w] ?? null
}

/** A count that has to be a plain number. */
export function readNumber(word: string): number | null {
  const count = readCount(word)
  return typeof count === 'number' ? count : null
}

/** Who "its" and "the sacrificed creature's" belong to, where the sentence
 *  is being read: the thing targeted, if something was; otherwise the card
 *  the ability is about. */
export interface Speaking { it: Whose; sacrificed: Whose }

const NOBODY: Speaking = { it: 'event', sacrificed: 'event' }

/**
 * An amount in words: "the number of lands you control", "your life total",
 * "the sacrificed creature's toughness". What comes after "where X is" and
 * "equal to". Null for anything else.
 */
export function readAmount(phrase: string, who: Speaking = NOBODY): Count | null {
  const p = phrase.trim().toLowerCase().replace(/\.$/, '')
  const plain = readCount(p)
  if (plain !== null) return plain
  if (p === 'your life total') return 'life'
  // "Choose a number": it is X from then on.
  if (p === 'the chosen number') return 'X'

  const stat = /^(~'s|its|that creature's|that permanent's|that card's|the sacrificed creature's) (power|toughness|mana value)$/.exec(p)
  if (stat) {
    const of = stat[1] === "~'s" ? 'self' : stat[1].startsWith('the sacrificed') ? who.sacrificed : who.it
    return { stat: stat[2] === 'mana value' ? 'manaValue' : stat[2] as 'power' | 'toughness', of }
  }
  if (/^the difference between (?:that creature's|its) power and (?:its )?toughness$/.test(p)) {
    return { stat: 'gap', of: who.it }
  }
  const total = /^the total (power|toughness) of (.+)$/.exec(p)
  if (total) {
    const of = readFilter(total[2])
    return of && { total: total[1] as 'power' | 'toughness', of }
  }

  // What the trigger is about: the damage that set it off.
  if (/^the amount of damage (?:it|~) dealt to that player$/.test(p)) return 'thatMany'
  const life = /^the amount of life you (gained|lost) this turn$/.exec(p)
  if (life) return { tally: life[1] as 'gained' | 'lost' }

  const number = /^the number of (.+)$/.exec(p)
  if (!number) return null
  const what = number[1]
  if (what === 'cards in your hand') return { zone: 'hand' }
  if (what === 'colors among permanents you control') return 'colors'
  // The table has one.
  if (what === 'opponents you have') return 1
  if (/ (destroyed|sacrificed|exiled|discarded|returned) this way$/.test(what)) return 'thatMany'
  const buried = /^(?:(.+?) )?cards in your graveyard$/.exec(what)
  if (buried) {
    const filter = buried[1] ? readFilter(buried[1]) : undefined
    return filter === null ? null : { zone: 'graveyard', ...(filter ? { filter } : {}) }
  }
  const counters = /^([+-]\d\/[+-]\d|[a-z]+) counters on (~|it|that creature)$/.exec(what)
  if (counters) return { counters: counters[1], of: counters[2] === '~' ? 'self' : who.it }
  const per = readFilter(what)
  return per && { per }
}

/**
 * A condition in words — what stands between "if" and the comma: "you
 * control a Bird", "that land is a Forest", "there are seven or more cards
 * in your graveyard". Null for anything else.
 */
export function readTest(phrase: string, who: Speaking = NOBODY): Test | null {
  const p = phrase.trim().toLowerCase()

  const shared = /^you control (\w+) or more creatures that share a creature type$/.exec(p)
  if (shared) {
    const n = readNumber(shared[1])
    return n === null ? null : { sharedType: n }
  }
  const control = /^you control (an?|(\w+) or more) (.+)$/.exec(p)
  if (control) {
    const atLeast = control[2] ? readNumber(control[2]) : 1
    const filter = readFilter(control[3])
    return atLeast !== null && filter ? { control: { ...filter, controller: 'you' }, atLeast } : null
  }
  if (/^you have a full party$/.test(p)) return { party: 4 }
  if (/^~ isn't a token$/.test(p)) return { is: { nontoken: true }, of: 'self' }
  // The spell was cast with the cost that is asked about.
  if (/^(?:~|it|this spell) was kicked$/.test(p) || /^(?:~|this spell)'s additional cost was paid$/.test(p)
    || /^an? [a-z]+(?: creature)? was beheld$/.test(p)) return { kicked: true }
  const exiled = /^(\w+) or more cards have been exiled with ~$/.exec(p)
  if (exiled) {
    const n = readNumber(exiled[1])
    return n === null ? null : { exiled: n }
  }
  // Always so, where every creature is yours — given that there is one.
  if (/^you control each creature on the battlefield with the greatest power$/.test(p)) {
    return { control: { types: ['creature'], controller: 'you' }, atLeast: 1 }
  }
  const graveyard = /^there are (\w+) or more (?:(.+?) )?cards in your graveyard$/.exec(p)
  if (graveyard) {
    const n = readNumber(graveyard[1])
    const filter = graveyard[2] ? readFilter(graveyard[2]) : undefined
    return n === null || filter === null ? null : { graveyard: n, ...(filter ? { filter } : {}) }
  }
  // Of what the sentence before had you pick: "if another Desert was
  // returned this way".
  const done = /^(another |an? )(.+?) was (?:returned|sacrificed|exiled|destroyed|discarded) this way$/.exec(p)
  if (done) {
    const filter = readFilter(done[2])
    return filter && { is: { ...filter, ...(done[1] === 'another ' ? { other: true } : {}) }, of: 'chosen' }
  }
  const is = /^(?:that land|that creature|that card|that permanent|it)(?: is|'s) an? (.+?)(?: card)?$/.exec(p)
  if (is) {
    const filter = readFilter(is[1])
    return filter && { is: filter, of: who.it }
  }
  const stat = /^(?:the creature|that creature|it) had (power|toughness) (\d+) or (greater|less)$/.exec(p)
    ?? /^(?:its|that creature's) (power|toughness) (?:is|was) (\d+) or (greater|less)$/.exec(p)
  if (stat) {
    return {
      stat: stat[1] as 'power' | 'toughness', of: who.it,
      op: stat[3] === 'greater' ? '>=' : '<=', value: Number(stat[2]),
    }
  }
  const counters = /^~ has (\w+) or more ([+-]\d\/[+-]\d|[a-z]+) counters on it$/.exec(p)
  if (counters) {
    const atLeast = readNumber(counters[1])
    return atLeast === null ? null : { counters: counters[2], of: 'self', atLeast }
  }
  const was = /^(?:that creature|it) was an? (.+)$/.exec(p)
  if (was) {
    const filter = readFilter(was[1])
    return filter && { is: filter, of: who.it }
  }
  // What has happened this turn.
  if (/^a permanent left the battlefield under your control this turn$/.test(p)) return { tally: 'left', atLeast: 1 }
  if (/^a creature card was put into your graveyard from anywhere this turn$/.test(p)) return { tally: 'binned', atLeast: 1 }
  if (/^a creature died this turn$/.test(p)) return { tally: 'died', atLeast: 1 }
  if (/^you(?:'ve)? discarded a card this turn$/.test(p)) return { tally: 'discarded', atLeast: 1 }
  if (/^you(?:'ve)? gained life this turn$/.test(p)) return { tally: 'gained', atLeast: 1 }
  return null
}

const title = (word: string) => word[0].toUpperCase() + word.slice(1)

const TYPES = ['creature', 'land', 'artifact', 'enchantment', 'planeswalker', 'battle', 'instant', 'sorcery']

/** "trample and haste", "hexproof", "flying, vigilance, and lifelink". */
export function readKeywords(phrase: string): string[] {
  return phrase.split(/,? and |, /).map((k) => k.trim()).filter(Boolean)
    .map((k) => k[0].toUpperCase() + k.slice(1))
}

/** Keywords a phrase may ask for: "creature with defender". */
const KEYWORDS = new Set([
  'flying', 'first strike', 'double strike', 'deathtouch', 'defender', 'haste', 'hexproof',
  'indestructible', 'lifelink', 'menace', 'reach', 'trample', 'vigilance', 'flash', 'shroud',
  'infect', 'changeling', 'fear', 'intimidate', 'shadow', 'horsemanship', 'skulk', 'prowess',
  'wither', 'islandwalk', 'swampwalk', 'forestwalk', 'mountainwalk', 'plainswalk',
])

const COLOR_WORDS: Record<string, string> = {
  white: 'W', blue: 'U', black: 'B', red: 'R', green: 'G',
}
const COLOR = / (white|blue|black|red|green)\b(?:,| or| and)?/

/**
 * The permanents or cards a noun phrase means.
 *
 * "creature you control", "another nontoken creature", "artifact or
 * enchantment", "basic land", "basic plains, swamp, or forest", "creature
 * with defender". Null when the phrase holds a word this does not know, so a
 * filter is never quietly broader than what the card says.
 */
export function readFilter(phrase: string): Filter | null {
  let rest = ` ${phrase.trim().toLowerCase().replace(/ and\/or /g, ' or ')} `
  const filter: Filter = {}

  const take = (pattern: RegExp) => {
    const hit = pattern.exec(rest)
    if (hit) rest = rest.replace(pattern, ' ')
    return hit
  }

  // "…with mana value less than or equal to the number of lands you
  // control": taken first, before "you control" is read as whose it is.
  const versus = take(/ with (power|toughness|mana value) (less|greater) than or equal to (.+?) $/)
  if (versus) {
    const value = readAmount(versus[3])
    if (value === null) return null
    filter.compare = {
      stat: versus[1] === 'mana value' ? 'manaValue' : versus[1] as 'power' | 'toughness',
      op: versus[2] === 'less' ? '<=' : '>=',
      value,
    }
  }
  // …and so is "a creature you control", where that is whose type it shares.
  if (take(/ that shares? a creature type with a creature you control\b/)) filter.sharesType = 'yours'
  if (take(/ except for commanders\b/)) filter.commander = false
  if (take(/ named ~/)) filter.sameName = true
  // The one player there is to mean is you.
  if (take(/ (you control|under your control|target player controls)\b/)) filter.controller = 'you'
  else if (take(/ (an opponent controls|your opponents control|you don't control|that player controls|defending player controls)\b/)) filter.controller = 'opponent'
  if (take(/ (another|other)\b/)) filter.other = true
  const shares = take(/ that shares? a creature type with (it|~|enchanted creature|equipped creature)\b/)
  if (shares) filter.sharesType = shares[1] === 'it' ? 'it' : shares[1] === '~' ? 'self' : 'host'
  if (take(/ nontoken\b/)) filter.nontoken = true
  if (take(/ nonlegendary\b/)) filter.notSubtypes = [...(filter.notSubtypes ?? []), 'Legendary']
  if (take(/ basic\b/)) filter.basic = true
  if (take(/ that (?:aren't|isn't) of the chosen type\b/)) filter.notChosenType = true
  if (take(/ of the chosen type\b/)) filter.chosenType = true
  if (take(/ that's attacking alone\b/)) {
    filter.attacking = true
    filter.alone = true
  }
  if (take(/ attacking\b/)) filter.attacking = true
  if (take(/ untapped\b/)) filter.tapped = false
  else if (take(/ tapped\b/)) filter.tapped = true
  if (take(/ colorless\b/)) filter.colorless = true
  for (let color = take(COLOR); color; color = take(COLOR)) {
    filter.colors = [...(filter.colors ?? []), COLOR_WORDS[color[1]]]
  }
  const compare = take(/ with (power|toughness|mana value) (\d+|x) or (less|greater)\b/)
  if (compare) {
    filter.compare = {
      stat: compare[1] === 'mana value' ? 'manaValue' : compare[1] as 'power' | 'toughness',
      op: compare[3] === 'less' ? '<=' : '>=',
      // "…X or less": X as the spell was cast.
      value: compare[2] === 'x' ? 'X' : Number(compare[2]),
    }
  }
  const keyword = take(/ with ([a-z ]+?) (?=$|\s)/)
  if (keyword) {
    // "With" a keyword — and not with anything else that follows the word.
    if (!KEYWORDS.has(keyword[1].trim())) return null
    filter.keyword = keyword[1].trim()
  }

  const types: string[] = []
  const subtypes: string[] = []
  // A creature type in two words.
  if (take(/ time lords?\b/)) subtypes.push('Time Lord')
  const either = / or /.test(rest)
  const several = either || / and /.test(rest) || /,/.test(rest)
  const words = rest.replace(/,/g, ' ').split(/\s+/).filter(Boolean)
  for (const word of words) {
    const singular = word.replace(/s$/, '')
    if (['or', 'and', 'card', 'cards', 'a', 'an', 'target'].includes(word)) continue
    if (word === 'permanent' || word === 'permanents') {
      // Among cards, a permanent is anything but an instant or a sorcery.
      filter.not = [...(filter.not ?? []), 'instant', 'sorcery']
      continue
    }
    if (TYPES.includes(singular)) types.push(singular)
    else if (singular.startsWith('non') && TYPES.includes(singular.slice(3))) {
      filter.not = [...(filter.not ?? []), singular.slice(3)]
    } else if (/^non-[a-z]+$/.test(singular)) {
      // "non-Spirit": a creature type it must not have.
      const without = subtypeOf(singular.slice(4))
      if (!without) return null
      filter.notSubtypes = [...(filter.notSubtypes ?? []), without]
    } else if (word === 'legendary') {
      // A supertype, but it sits on the type line like any other word.
      subtypes.push('Legendary')
    } else if (word === 'outlaw' || word === 'outlaws') {
      // Five types under one name.
      subtypes.push('Assassin', 'Mercenary', 'Pirate', 'Rogue', 'Warlock')
    } else {
      // "Plant creature", "Ally you control", "Zombies": a subtype, if it is
      // one there is.
      const subtype = subtypeOf(word)
      if (!subtype) return null
      subtypes.push(subtype)
    }
  }
  // Types are any-of and subtypes are any-of, and a card must answer to
  // both — so "creature or Vehicle" is said as either of two filters, or it
  // would come out as a creature that is also a Vehicle.
  if (either && types.length && subtypes.length) return { ...filter, either: [{ types }, { subtypes }] }
  // "Artifact creatures and Heroes": two kinds of thing, each read on its
  // own.
  if (/ and /.test(rest) && types.length && subtypes.length) {
    const halves = rest.split(' and ').map((half) => readFilter(half))
    return halves.every(Boolean) ? { ...filter, either: halves as Filter[] } : null
  }
  // Two types with nothing between them are both wanted: an "artifact
  // creature" is not any artifact or any creature.
  if (types.length > 1 && !several) {
    filter.types = [types[types.length - 1]]
    filter.also = types.slice(0, -1)
  } else if (types.length) filter.types = types
  if (subtypes.length) filter.subtypes = subtypes
  return filter
}


/** Artifact tokens every deck knows by name. */
const NAMED_TOKENS: Record<string, TokenSpec> = {
  treasure: {
    name: 'Treasure', pt: null, colors: '', typeLine: 'Token Artifact — Treasure', keywords: [],
    text: '{T}, Sacrifice this token: Add one mana of any color.',
  },
  food: {
    name: 'Food', pt: null, colors: '', typeLine: 'Token Artifact — Food', keywords: [],
    text: '{2}, {T}, Sacrifice this token: You gain 3 life.',
  },
  clue: {
    name: 'Clue', pt: null, colors: '', typeLine: 'Token Artifact — Clue', keywords: [],
    text: '{2}, Sacrifice this token: Draw a card.',
  },
  blood: { name: 'Blood', pt: null, colors: '', typeLine: 'Token Artifact — Blood', keywords: [] },
  gold: { name: 'Gold', pt: null, colors: '', typeLine: 'Token Artifact — Gold', keywords: [] },
  map: { name: 'Map', pt: null, colors: '', typeLine: 'Token Artifact — Map', keywords: [] },
  powerstone: {
    name: 'Powerstone', pt: null, colors: '', typeLine: 'Token Artifact — Powerstone', keywords: [],
  },
}

/**
 * The token in "a 1/1 green Saproling creature token", "a Treasure token",
 * "a 0/1 colorless Eldrazi Spawn creature token with flying". Null for
 * anything fancier — a copy, a token with abilities in quotes.
 */
export function readToken(phrase: string): TokenSpec | null {
  const text = phrase.trim().toLowerCase().replace(/ tokens?(?= with |$)/, '')
  const named = NAMED_TOKENS[text]
  if (named) return named

  // "Boo, a legendary 1/1 red Hamster creature token": one with a name.
  const legend = /^([a-z' -]+), an? legendary (.+)$/.exec(text)
  if (legend) {
    const inner = readToken(legend[2])
    return inner && {
      ...inner,
      name: legend[1].split(' ').map(title).join(' '),
      typeLine: inner.typeLine.replace(/^Token /, 'Token Legendary '),
    }
  }

  const creature = /^(?:(\d+|x)\/(\d+|x) )?((?:(?:white|blue|black|red|green|colorless)(?:,? and |, | ))*(?:white|blue|black|red|green|colorless)) ((?:artifact |enchantment )*)([a-z ]+?) ((?:artifact |enchantment )*)creature(?: with ([a-z, ]+?))?$/.exec(text)
  if (!creature) return null
  // "Phyrexian Horror artifact creature" now; "artifact Soldier creature"
  // once. The other types sit on either side of the creature types.
  const [, power, toughness, colorWords, before, subtypes, behind, keywords] = creature
  const colors = colorWords.split(/,? and |, | /).map((w) => COLOR_WORDS[w] ?? '').join('')
  const types = `${before} ${behind}`.trim().split(/\s+/).filter(Boolean).map(title)
  const sub = subtypes.trim().split(/\s+/).map(title).join(' ')
  return {
    name: sub,
    // "X/X" is worked out as it is made; one printed with no size at all
    // has it from its own words.
    pt: power ? `${power}/${toughness}`.toUpperCase() : '*/*',
    colors,
    typeLine: `Token ${[...types, 'Creature'].join(' ')} — ${sub}`,
    keywords: keywords ? keywords.split(/,? and |, /).map((k) => title(k.trim())).filter(Boolean) : [],
  }
}
