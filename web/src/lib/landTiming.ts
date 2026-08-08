/**
 * Does this land come in tapped, given the board?
 *
 * Read off the oracle text rather than a list of card names, so it covers
 * cycles the mirror has never heard of. It is a heuristic and says so: the
 * goldfish is not a rules engine, and the point is that a check land you have
 * earned comes in untapped without you having to remember to fix it.
 *
 * Where a land offers you a choice, the choice is assumed taken — you pay the
 * two life, you reveal the card if it is in your hand. That is what a player
 * testing a deck would do, and the alternative is a prompt in the middle of a
 * goldfish.
 */

import type { Card } from './api'

const NUMBERS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
}

export interface TapVerdict {
  tapped: boolean
  /** Short phrase for the log, present only when something was decided. */
  why?: string
}

const UNTAPPED: TapVerdict = { tapped: false }

/** The sentence that talks about entering tapped, if there is one. */
function tapClause(text: string): string | null {
  for (const raw of text.split(/(?<=\.)\s+/)) {
    const line = raw.trim().toLowerCase()
    // "enters tapped" is the modern wording; older cards say "enters the
    // battlefield tapped". Both, and neither if it is conditional on a
    // trigger rather than on entry.
    if (/enters(?: the battlefield)? tapped/.test(line)) return line
  }
  return null
}

/** Types named in "a Plains or an Island" style lists. */
function namedTypes(fragment: string): string[] {
  return fragment
    .split(/\bor\b|,/)
    .map((part) => part.replace(/\b(an?|the)\b/g, '').trim())
    .map((part) => part.replace(/\bcards?\b/g, '').trim())
    .filter(Boolean)
}

const hasType = (cards: Card[], type: string) =>
  cards.some((c) => (c.type_line ?? '').toLowerCase().includes(type.toLowerCase()))

export function entersTapped(
  card: Card,
  /** Permanents already on the battlefield, this land excluded. */
  board: Card[],
  /** Cards in hand, this land excluded. */
  hand: Card[],
): TapVerdict {
  const type = (card.type_line ?? '').toLowerCase()
  if (!type.includes('land')) return UNTAPPED
  // Basics never have the text, but checking is cheaper than parsing.
  if (type.includes('basic')) return UNTAPPED

  const text = (card.oracle_text ?? '').toLowerCase()
  if (!text) return UNTAPPED

  /* Shock lands and their kin: "you may pay 2 life. If you don't, ~ enters
   * tapped." The offer is always taken. */
  const pay = text.match(/you may pay (\d+) life/)
  if (pay && /if you don't/.test(text)) {
    return { tapped: false, why: `paid ${pay[1]} life` }
  }

  /* Reveal lands: "you may reveal an Island or Swamp card from your hand. If
   * you don't, ~ enters tapped." Met when such a card is actually in hand. */
  const reveal = text.match(/reveal ([^.]*?) card from your hand/)
  if (reveal) {
    const types = namedTypes(reveal[1])
    const held = types.find((t) => hasType(hand, t))
    return held
      ? { tapped: false, why: `revealed ${held}` }
      : { tapped: true, why: `no ${types.join(' or ')} in hand` }
  }

  const clause = tapClause(text)
  if (!clause) return UNTAPPED

  // Unconditional tapland.
  if (!clause.includes('unless')) return { tapped: true }

  const unless = clause.slice(clause.indexOf('unless'))

  /* Fast and slow lands: "unless you control two or fewer other lands",
   * "unless you control two or more other lands". */
  const count = unless.match(/(\w+) or (fewer|less|more) other lands/)
  if (count) {
    const n = NUMBERS[count[1]] ?? Number(count[1])
    const others = board.filter((c) => (c.type_line ?? '').toLowerCase().includes('land')).length
    if (!Number.isNaN(n)) {
      const met = count[2] === 'more' ? others >= n : others <= n
      const why = `${others} other land${others === 1 ? '' : 's'}`
      return met ? { tapped: false, why } : { tapped: true, why }
    }
  }

  /* Check lands: "unless you control a Plains or an Island". */
  const control = unless.match(/unless you control ([^.]*)/)
  if (control) {
    const types = namedTypes(control[1])
    const found = types.find((t) => hasType(board, t))
    return found
      ? { tapped: false, why: `you control a ${found}` }
      : { tapped: true, why: `no ${types.join(' or ')}` }
  }

  // An "unless" we do not understand. Coming in tapped is the safer guess:
  // it is what the card says by default, and the condition is the exception.
  return { tapped: true }
}
