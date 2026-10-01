/**
 * Copies: the card a copy is, given what it copies and what the effect says
 * is different about it.
 *
 * A copy is a card of its own — the same name, cost, types, text and size,
 * with the exceptions written in — so everything that reads cards reads a
 * copy the same way: its abilities compile, its type line answers filters,
 * its arrival triggers what the original's would.
 */

import type { Card } from '../lib/api'
import type { CopyChange } from './compiler/ir'

const CARD_TYPES = ['Artifact', 'Creature', 'Enchantment', 'Land', 'Planeswalker', 'Battle']

const sentenceCase = (text: string) =>
  `${text.charAt(0).toUpperCase()}${text.slice(1)}${/[.!?"]$/.test(text) ? '' : '.'}`

const has = (line: string, word: string) => new RegExp(`\\b${word}\\b`, 'i').test(line)

const SUPERTYPES = ['Legendary', 'Basic', 'Snow', 'World', 'Kindred']

/** The type line with a type added: supertypes first, then card types,
 *  before the dash; anything else after it. */
function withType(line: string, type: string): string {
  if (has(line, type)) return line
  const [left, right] = line.split(/\s+—\s+/)
  const words = left.split(/\s+/).filter(Boolean)
  const supers = words.filter((w) => SUPERTYPES.includes(w))
  const kinds = words.filter((w) => !SUPERTYPES.includes(w))
  if (SUPERTYPES.includes(type)) return [[...supers, type, ...kinds].join(' '), right].filter(Boolean).join(' — ')
  if (CARD_TYPES.includes(type)) return [[...supers, type, ...kinds].join(' '), right].filter(Boolean).join(' — ')
  return `${left} — ${[right, type].filter(Boolean).join(' ')}`
}

export function copyOf(card: Card, change: CopyChange): Card {
  let line = card.type_line ?? ''
  if (change.notLegendary) line = line.replace(/\bLegendary\s+/, '')
  for (const type of change.types ?? []) line = withType(line, type)
  const [power, toughness] = change.pt ? change.pt.split('/') : [card.power, card.toughness]
  const added = change.text ? sentenceCase(change.text.split('~').join(card.name)) : null
  return {
    ...card,
    type_line: line,
    power,
    toughness,
    keywords: [...(card.keywords ?? []), ...(change.keywords ?? [])],
    oracle_text: [card.oracle_text ?? card.card_faces?.[0]?.oracle_text, added].filter(Boolean).join('\n') || null,
  }
}
