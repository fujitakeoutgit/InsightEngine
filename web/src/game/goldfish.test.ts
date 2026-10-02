import { describe, expect, it } from 'vitest'

import type { Card } from '../lib/api'
import corpus from './compiler/corpus.json'
import { deckFrom, goldfish } from './goldfish'

type Entry = Card & { decks: string[] }
const cards = corpus as unknown as Entry[]
const decks = [...new Set(cards.flatMap((c) => c.decks))]

/* Whole games, played by something with no judgement. They prove nothing
 * about any one card; what they catch is the engine as a whole — a question
 * with no legal answer, a spell left on the stack with nothing to resolve
 * it, a card that has gone missing — which no test of one card would.
 * `scripts/soak.ts` runs the same thing by the hundred. */
describe('whole games', () => {
  it.each(decks)('plays %s through without getting stuck', (name) => {
    const deck = deckFrom(cards, name)
    expect(deck.reduce((n, entry) => n + entry.quantity, 0)).toBe(100)
    for (const seed of [11, 222, 3333, 44444, 555555, 6666666]) {
      const played = goldfish(deck, seed, 12)
      expect(played.stuck, `seed ${seed}`).toBeNull()
      expect(played.state.turn).toBeGreaterThan(12)
    }
  })

  it.each(decks)('plays %s through with the game passing by itself', (name) => {
    const deck = deckFrom(cards, name)
    for (const seed of [11, 222, 3333, 44444]) {
      const played = goldfish(deck, seed, 12, undefined, true)
      expect(played.stuck, `seed ${seed}`).toBeNull()
      expect(played.state.turn).toBeGreaterThan(12)
    }
  })

  it('plays the same game from the same seed', () => {
    const deck = deckFrom(cards, decks[0])
    const [one, two] = [goldfish(deck, 99, 8), goldfish(deck, 99, 8)]
    expect(one.actions).toBe(two.actions)
    expect(one.state.log).toEqual(two.state.log)
  })
})
