/**
 * How much of a list of cards the rules engine reads, card by card.
 *
 *   npx vite-node scripts/coverage.ts <cards.json> [--all | --dump]
 *
 * The cards are an array of card objects, each optionally with `decks`, the
 * names of the decks it is in — what `packaging/export-rules-corpus.py`
 * writes. Prints every card that is not fully automatic with the lines still
 * in words, then totals overall and per deck. `--all` lists the automatic
 * ones too; `--dump` prints what each card compiled to instead, as JSON, to
 * diff one version of the compiler against another.
 */

import { readFileSync } from 'node:fs'

import { compile } from '../src/game/compiler/compile'
import type { Card } from '../src/lib/api'

declare const process: { argv: string[] }

type Entry = Card & { decks?: string[] }

const [path, flag] = process.argv.slice(2)
const cards = JSON.parse(readFileSync(path, 'utf8')) as Entry[]

if (flag === '--dump') {
  console.log(JSON.stringify(Object.fromEntries(cards.map((c) => [c.name, compile(c)])), null, 1))
} else {
  const blank = () => ({ auto: 0, partial: 0, manual: 0 })
  const total = blank()
  const perDeck = new Map<string, ReturnType<typeof blank>>()
  const out: string[] = []
  for (const card of cards) {
    const compiled = compile(card)
    total[compiled.coverage] += 1
    for (const deck of card.decks ?? []) {
      const tally = perDeck.get(deck) ?? blank()
      tally[compiled.coverage] += 1
      perDeck.set(deck, tally)
    }
    if (compiled.coverage === 'auto' && flag !== '--all') continue
    const partly = [compiled.spell, ...compiled.triggers, ...compiled.activated]
      .filter((ability) => ability && !ability.complete)
      .map((ability) => `  [part] ${ability!.text}`)
    out.push(`${compiled.coverage.toUpperCase()} ${card.name} (${(card.decks ?? []).join(', ')}) — ${card.type_line}`)
    for (const line of compiled.unread) out.push(`  [unread] ${line}`)
    out.push(...new Set(partly))
  }
  console.log(out.join('\n'))
  console.log(`\nTOTAL ${cards.length} ${JSON.stringify(total)}`)
  for (const [deck, tally] of perDeck) console.log(deck, JSON.stringify(tally))
}
