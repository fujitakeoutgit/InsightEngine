/**
 * Reading phrases: numbers, the permanents a noun phrase means, the token a
 * creation describes. The patterns in `effects.ts` are built from these.
 *
 * Everything here works on normalized text — lowercase, the card's own name
 * replaced by "~" — so "When Wall of Omens enters" and "When this creature
 * enters" read the same.
 */

import type { Count, Filter, TokenSpec } from './ir'

const NUMBERS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
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

const title = (word: string) => word[0].toUpperCase() + word.slice(1)

const TYPES = ['creature', 'land', 'artifact', 'enchantment', 'planeswalker', 'battle', 'instant', 'sorcery']
const LAND_TYPES = ['plains', 'island', 'swamp', 'mountain', 'forest']

/**
 * The permanents or cards a noun phrase means.
 *
 * "creature you control", "another nontoken creature", "artifact or
 * enchantment", "basic land", "basic plains, swamp, or forest", "creature
 * with defender". Null when the phrase holds a word this does not know, so a
 * filter is never quietly broader than what the card says.
 */
export function readFilter(phrase: string): Filter | null {
  let rest = ` ${phrase.trim().toLowerCase()} `
  const filter: Filter = {}

  const take = (pattern: RegExp) => {
    const hit = pattern.exec(rest)
    if (hit) rest = rest.replace(pattern, ' ')
    return hit
  }

  if (take(/ (you control|under your control)\b/)) filter.controller = 'you'
  else if (take(/ (an opponent controls|your opponents control|you don't control)\b/)) filter.controller = 'opponent'
  if (take(/ (another|other)\b/)) filter.other = true
  if (take(/ nontoken\b/)) filter.nontoken = true
  if (take(/ basic\b/)) filter.basic = true
  const compare = take(/ with (power|toughness|mana value) (\d+) or (less|greater)\b/)
  if (compare) {
    filter.compare = {
      stat: compare[1] === 'mana value' ? 'manaValue' : compare[1] as 'power' | 'toughness',
      op: compare[3] === 'less' ? '<=' : '>=',
      value: Number(compare[2]),
    }
  }
  const keyword = take(/ with ([a-z ]+?) (?=$|\s)/)
  if (keyword) filter.keyword = keyword[1].trim()

  const types: string[] = []
  const subtypes: string[] = []
  const words = rest.replace(/,/g, ' ').split(/\s+/).filter(Boolean)
  for (const [i, word] of words.entries()) {
    const singular = word.replace(/s$/, '')
    if (['or', 'and', 'card', 'cards', 'permanent', 'permanents', 'a', 'an', 'target'].includes(word)) continue
    if (TYPES.includes(singular)) types.push(singular)
    else if (singular.startsWith('non') && TYPES.includes(singular.slice(3))) {
      filter.not = [...(filter.not ?? []), singular.slice(3)]
    } else if (/^non-[a-z]+$/.test(singular)) {
      // "non-Spirit": a creature type it must not have.
      filter.notSubtypes = [...(filter.notSubtypes ?? []), title(singular.slice(4))]
    } else if (LAND_TYPES.includes(word) || LAND_TYPES.includes(singular)) {
      // "Plains" is its own singular.
      subtypes.push(title(LAND_TYPES.includes(word) ? word : singular))
    } else if (/^[a-z]+$/.test(word) && /^(creature|card)s?$/.test(words[i + 1] ?? '')) {
      // "Plant creature", "Eldrazi card": a word just before the type is
      // the creature type it narrows to.
      subtypes.push(title(singular))
    } else return null
  }
  if (types.length) filter.types = types
  if (subtypes.length) filter.subtypes = subtypes
  return filter
}

const COLOR_WORDS: Record<string, string> = {
  white: 'W', blue: 'U', black: 'B', red: 'R', green: 'G',
}

/** Artifact tokens every deck knows by name. */
const NAMED_TOKENS: Record<string, TokenSpec> = {
  treasure: {
    name: 'Treasure', pt: null, colors: '', typeLine: 'Token Artifact — Treasure', keywords: [],
  },
  food: { name: 'Food', pt: null, colors: '', typeLine: 'Token Artifact — Food', keywords: [] },
  clue: { name: 'Clue', pt: null, colors: '', typeLine: 'Token Artifact — Clue', keywords: [] },
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

  const creature = /^(\d+)\/(\d+) ((?:(?:white|blue|black|red|green|colorless)(?:,? and |, | ))*(?:white|blue|black|red|green|colorless)) ((?:artifact |enchantment )*)([a-z ]+?) creature(?: with ([a-z, ]+?))?$/.exec(text)
  if (!creature) return null
  const [, power, toughness, colorWords, more, subtypes, keywords] = creature
  const colors = colorWords.split(/,? and |, | /).map((w) => COLOR_WORDS[w] ?? '').join('')
  const types = more.trim().split(/\s+/).filter(Boolean).map(title)
  const sub = subtypes.trim().split(/\s+/).map(title).join(' ')
  return {
    name: sub,
    pt: `${power}/${toughness}`,
    colors,
    typeLine: `Token ${[...types, 'Creature'].join(' ')} — ${sub}`,
    keywords: keywords ? keywords.split(/,? and |, /).map((k) => title(k.trim())).filter(Boolean) : [],
  }
}
