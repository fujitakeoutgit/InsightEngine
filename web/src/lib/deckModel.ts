/** Structured deck state for the builder.
 *
 * The decklist text stays the source of truth for saving, analysis and
 * recommendations — everything already speaks it. The editor holds a parsed
 * view of that text and serialises back on every change, so the two never
 * diverge and no existing feature needs to know the editor exists.
 */

import type { Card, Resolution } from './api'

export type Section = 'commander' | 'main' | 'sideboard' | 'maybeboard'
export type GroupBy = 'type' | 'cmc' | 'color' | 'rarity' | 'none'
export type SortBy = 'name' | 'cmc' | 'price' | 'rarity' | 'color'

export const SECTIONS: { key: Section; label: string }[] = [
  { key: 'commander', label: 'Commander' },
  { key: 'main', label: 'Deck' },
  { key: 'sideboard', label: 'Sideboard' },
  { key: 'maybeboard', label: 'Maybeboard' },
]

export interface DeckCard {
  /** Stable across re-renders so drag-and-drop keeps its grip. */
  uid: string
  quantity: number
  card: Card
  section: Section
}

/** Primary card type, in the order players expect to see groups. */
const TYPE_ORDER = [
  'Creature', 'Planeswalker', 'Instant', 'Sorcery', 'Artifact',
  'Enchantment', 'Battle', 'Land',
]

export function primaryType(card: Card): string {
  const line = card.type_line ?? ''
  // Land last: "Artifact Land" is a land in practice, and a creature that is
  // also an artifact belongs under Creature.
  if (/\bLand\b/.test(line)) return 'Land'
  for (const type of TYPE_ORDER) {
    if (type !== 'Land' && new RegExp(`\\b${type}\\b`).test(line)) return type
  }
  return 'Other'
}

const COLOR_LABEL: Record<string, string> = {
  W: 'White', U: 'Blue', B: 'Black', R: 'Red', G: 'Green',
}

export function colorGroup(card: Card): string {
  const id = card.color_identity || ''
  if (!id) return 'Colourless'
  if (id.length > 1) return 'Multicolour'
  return COLOR_LABEL[id] ?? id
}

let counter = 0
const nextUid = () => `dc${++counter}`

export function fromResolutions(resolutions: Resolution[]): DeckCard[] {
  return resolutions
    .filter((r) => r.card)
    .map((r) => ({
      uid: nextUid(),
      quantity: r.quantity,
      card: r.card as Card,
      section: (['commander', 'main', 'sideboard', 'maybeboard'] as Section[])
        .includes(r.section as Section) ? (r.section as Section) : 'main',
    }))
}

/** Render back to decklist text, preserving section headers. */
export function serialize(cards: DeckCard[]): string {
  const out: string[] = []
  for (const { key, label } of SECTIONS) {
    const inSection = cards.filter((c) => c.section === key)
    if (!inSection.length) continue
    if (out.length) out.push('')
    out.push(label)
    for (const entry of inSection) {
      out.push(`${entry.quantity} ${entry.card.name}`)
    }
  }
  return out.join('\n') + (out.length ? '\n' : '')
}

export interface Group {
  key: string
  label: string
  cards: DeckCard[]
  count: number
}

export function groupCards(cards: DeckCard[], by: GroupBy): Group[] {
  if (by === 'none') {
    return [{
      key: 'all', label: 'All',
      cards, count: cards.reduce((n, c) => n + c.quantity, 0),
    }]
  }

  const buckets = new Map<string, DeckCard[]>()
  for (const entry of cards) {
    let key: string
    switch (by) {
      case 'type': key = primaryType(entry.card); break
      case 'cmc': key = entry.card.cmc === null ? '—' : String(Math.min(7, entry.card.cmc)); break
      case 'color': key = colorGroup(entry.card); break
      case 'rarity': key = entry.card.rarity ?? 'unknown'; break
      default: key = 'All'
    }
    const bucket = buckets.get(key)
    if (bucket) bucket.push(entry)
    else buckets.set(key, [entry])
  }

  const order = (key: string): number => {
    if (by === 'type') {
      const i = TYPE_ORDER.indexOf(key)
      return i === -1 ? TYPE_ORDER.length : i
    }
    if (by === 'cmc') return key === '—' ? 99 : Number(key)
    if (by === 'rarity') {
      return ['common', 'uncommon', 'rare', 'mythic', 'special', 'bonus'].indexOf(key)
    }
    return 0
  }

  return [...buckets.entries()]
    .map(([key, list]) => ({
      key,
      label: by === 'cmc' ? (key === '7' ? '7+ mana' : key === '—' ? 'No cost' : `${key} mana`) : key,
      cards: list,
      count: list.reduce((n, c) => n + c.quantity, 0),
    }))
    .sort((a, b) => order(a.key) - order(b.key) || a.label.localeCompare(b.label))
}

export function sortDeckCards(cards: DeckCard[], by: SortBy): DeckCard[] {
  const value = (entry: DeckCard): string | number => {
    switch (by) {
      case 'cmc': return entry.card.cmc ?? 0
      case 'price': return entry.card.usd ?? Number.POSITIVE_INFINITY
      case 'rarity':
        return ['common', 'uncommon', 'rare', 'mythic', 'special', 'bonus']
          .indexOf(entry.card.rarity ?? 'common')
      case 'color': return entry.card.color_identity || 'ZZZ'
      default: return entry.card.name.toLowerCase()
    }
  }
  return [...cards].sort((a, b) => {
    const av = value(a)
    const bv = value(b)
    if (av === bv) return a.card.name.localeCompare(b.card.name)
    return av < bv ? -1 : 1
  })
}

/** Total cards, counting quantities. Commanders count toward the deck. */
export function countCards(cards: DeckCard[], sections: Section[] = ['commander', 'main']): number {
  return cards
    .filter((c) => sections.includes(c.section))
    .reduce((n, c) => n + c.quantity, 0)
}

export function deckValue(cards: DeckCard[]): number {
  return cards.reduce((sum, c) => sum + (c.card.usd ?? 0) * c.quantity, 0)
}

/** Filter by name, type or rules text — the in-deck search box. */
export function filterCards(cards: DeckCard[], query: string): DeckCard[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return cards
  return cards.filter(({ card }) =>
    card.name.toLowerCase().includes(needle) ||
    (card.type_line ?? '').toLowerCase().includes(needle) ||
    (card.oracle_text ?? '').toLowerCase().includes(needle),
  )
}
