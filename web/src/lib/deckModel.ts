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

/**
 * Whether offering "make this the commander" makes sense for a card.
 *
 * A hint, not a rule. Nothing in this app enforces legality — the analysis
 * tab reports it — but putting the action on all hundred cards would bury it,
 * and putting it on a Forest is noise. Planeswalkers and Backgrounds say so in
 * their text rather than their type line, which is why both are checked.
 */
export function canBeCommander(card: Card): boolean {
  if (/\bLegendary\b/.test(card.type_line ?? '')) return true
  const text = [card.oracle_text ?? '', ...(card.card_faces ?? []).map((f) => f.oracle_text ?? '')]
    .join(' ')
    .toLowerCase()
  return text.includes('can be your commander')
}

export function colorGroup(card: Card): string {
  const id = card.color_identity || ''
  if (!id) return 'Colorless'
  if (id.length > 1) return 'Multicolor'
  return COLOR_LABEL[id] ?? id
}

let counter = 0
const nextUid = () => `dc${++counter}`

/** Wrap a bare card as a new single-copy deck entry. */
export function addedCard(card: Card, section: Section = 'main'): DeckCard {
  return { uid: nextUid(), quantity: 1, card, section }
}

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
/**
 * The `(SET) 123` tail of a canonical line, or nothing.
 *
 * One printing is not another: a line naming only the card leaves the edition
 * to whatever the resolver happens to pick, so a list exported today and read
 * back tomorrow can quietly change which art, which set and which price the
 * deck is made of. Writing the printing down is what makes a decklist a record
 * rather than a suggestion — and it is what turns an imported `2x Mountain
 * (MSH)` or a bare `1x Myth Realized` into the same shape as everything else.
 *
 * Both halves or neither: `(FDN)` with no number is not the canonical form and
 * is no more precise than the name on its own. The set code is upper-cased
 * because Scryfall stores it lower and every printed list writes it upper.
 */
function printing(card: { set_code?: string | null; collector_number?: string | null }) {
  const set = card.set_code?.trim()
  const number = card.collector_number?.trim()
  return set && number ? ` (${set.toUpperCase()}) ${number}` : ''
}

export function serialize(cards: DeckCard[], sections = SECTIONS): string {
  const out: string[] = []
  /* `sections` names the headings to write. The binder passes its own — Bulk,
   * Trades, Fav — because it stores an ordinary decklist and its Text view has
   * to show the same three sections its Build view does. The server's parser
   * accepts both sets, so a list written either way reads back correctly. */
  for (const { key, label } of sections) {
    const inSection = cards.filter((c) => c.section === key)
    if (!inSection.length) continue
    if (out.length) out.push('')
    out.push(label)
    for (const entry of inSection) {
      out.push(`${entry.quantity} ${entry.card.name}${printing(entry.card)}`)
    }
  }
  return out.join('\n') + (out.length ? '\n' : '')
}

/**
 * Add one copy of a card to a section of raw decklist text.
 *
 * Works on the text rather than the parsed model because the caller may not
 * have the deck open -- adding to a deck from the Cards page, for instance.
 * An existing entry has its quantity bumped instead of gaining a duplicate
 * line, and a missing section header is appended.
 */
export function addToSection(text: string, name: string, section: Section): string {
  const label = SECTIONS.find((s) => s.key === section)?.label ?? 'Deck'
  const lines = text.replace(/\s+$/, '').split('\n')
  const headers = new Set(SECTIONS.map((s) => s.label.toLowerCase()))

  const start = lines.findIndex((line) => line.trim().toLowerCase() === label.toLowerCase())
  if (start === -1) {
    const body = lines.filter((l) => l.trim()).length ? [...lines, '', label] : [label]
    return [...body, `1 ${name}`].join('\n') + '\n'
  }

  let end = start + 1
  while (end < lines.length && !headers.has(lines[end].trim().toLowerCase())) end += 1

  const folded = name.trim().toLowerCase()
  for (let i = start + 1; i < end; i += 1) {
    const match = lines[i].match(/^\s*(\d+)\s*x?\s+(.*?)\s*$/i)
    if (match && match[2].toLowerCase() === folded) {
      lines[i] = `${Number(match[1]) + 1} ${match[2]}`
      return lines.join('\n') + '\n'
    }
  }

  // Insert before the trailing blank that separates this section from the next.
  let at = end
  while (at > start + 1 && !lines[at - 1].trim()) at -= 1
  lines.splice(at, 0, `1 ${name}`)
  return lines.join('\n') + '\n'
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

export function sortDeckCards(
  cards: DeckCard[], by: SortBy, direction: "asc" | "desc" = "asc",
): DeckCard[] {
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
  const sign = direction === 'desc' ? -1 : 1
  return [...cards].sort((a, b) => {
    const av = value(a)
    const bv = value(b)
    // Name is the tiebreak and stays ascending either way, so equal-valued
    // cards keep a stable, readable order rather than flipping with the arrow.
    if (av === bv) return a.card.name.localeCompare(b.card.name)
    return (av < bv ? -1 : 1) * sign
  })
}

/** Total cards, counting quantities. Commanders count toward the deck. */
export function countCards(cards: DeckCard[], sections: Section[] = ['commander', 'main']): number {
  return cards
    .filter((c) => sections.includes(c.section))
    .reduce((n, c) => n + c.quantity, 0)
}

/** What the deck costs. Same sections `countCards` counts, for the same
 *  reason: the two are printed next to each other, and a total that includes
 *  the maybeboard beside a count that does not is a contradiction on one
 *  line. */
export function deckValue(
  cards: DeckCard[], sections: Section[] = ['commander', 'main'],
): number {
  return cards
    .filter((c) => sections.includes(c.section))
    .reduce((sum, c) => sum + (c.card.usd ?? 0) * c.quantity, 0)
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
