/**
 * Whole games, played badly, to find where the rules engine gets stuck or
 * falls over.
 *
 *   npx vite-node scripts/soak.ts <cards.json> [games] [turns]
 *
 * The cards are the same list `coverage.ts` takes. Each deck named in it is
 * dealt and played by `goldfish` — a land, whatever can be cast, a legal
 * answer to every question — for so many turns, so many times over. Prints
 * each game that threw, stuck, or ended in a state no game should be in,
 * with the seed to play it again.
 */

import { readFileSync } from 'node:fs'

import { deckFrom, goldfish } from '../src/game/goldfish'
import type { Card } from '../src/lib/api'

declare const process: { argv: string[] }

type Entry = Card & { decks?: string[] }

const [path, games = '20', turns = '12'] = process.argv.slice(2)
const cards = JSON.parse(readFileSync(path, 'utf8')) as Entry[]
const decks = [...new Set(cards.flatMap((c) => c.decks ?? []))]

let bad = 0
let total = 0
for (const name of decks) {
  const deck = deckFrom(cards, name)
  for (let seed = 1; seed <= Number(games); seed += 1) {
    total += 1
    try {
      const played = goldfish(deck, seed * 7919, Number(turns))
      if (played.stuck) {
        bad += 1
        console.log(`${name} seed ${seed * 7919}: ${played.stuck}`)
        console.log(`  last: ${played.state.log.slice(0, 6).join(' | ')}`)
      }
    } catch (error) {
      bad += 1
      console.log(`${name} seed ${seed * 7919}: threw ${(error as Error).stack?.split('\n').slice(0, 4).join(' / ')}`)
    }
  }
}
console.log(`\n${total} games, ${bad} with something wrong`)
