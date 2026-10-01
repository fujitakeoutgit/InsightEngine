/**
 * How much of a deck the rules engine carries out, card by card: what plays
 * itself, what is left for you to do by hand and in which words, and which
 * ways of casting a card the table does not offer.
 */

import type { Card } from '../../lib/api'
import { compile } from './compile'
import type { Coverage } from './ir'

export interface CardReport {
  name: string
  coverage: Coverage
  /** The rules text left in words: lines nothing reads, and abilities read
   *  only in part. */
  left: string[]
  /** Evoke, kicker and the like: the card is cast as printed without them. */
  skipped: string[]
}

export interface DeckReport {
  /** Different cards, each counted once. */
  total: number
  auto: number
  partial: number
  manual: number
  /** The cards with something to say about them — by hand first, then
   *  partly automatic, then those that only have something not offered —
   *  each group by name. */
  cards: CardReport[]
}

const ORDER: Record<Coverage, number> = { manual: 0, partial: 1, auto: 2 }

export function report(cards: readonly Card[]): DeckReport {
  const seen = new Set<string>()
  const out: DeckReport = { total: 0, auto: 0, partial: 0, manual: 0, cards: [] }
  for (const card of cards) {
    const key = card.oracle_id ?? card.name
    if (seen.has(key)) continue
    seen.add(key)
    const compiled = compile(card)
    out.total += 1
    out[compiled.coverage] += 1
    const partly = [compiled.spell, ...compiled.triggers, ...compiled.activated]
      .filter((ability) => ability && !ability.complete)
      .map((ability) => ability!.text)
    const left = [...new Set([...compiled.unread, ...partly])].map((line) => line.split('~').join(card.name))
    if (left.length || compiled.skipped.length) {
      out.cards.push({ name: card.name, coverage: compiled.coverage, left, skipped: compiled.skipped })
    }
  }
  out.cards.sort((a, b) => ORDER[a.coverage] - ORDER[b.coverage] || a.name.localeCompare(b.name))
  return out
}
