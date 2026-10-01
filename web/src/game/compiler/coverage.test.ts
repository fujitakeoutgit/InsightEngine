import { describe, expect, it } from 'vitest'

import type { Card } from '../../lib/api'
import { compile } from './compile'
import corpus from './corpus.json'

/** Set by the shell to print the report. Vitest runs in Node. */
declare const process: { env: Record<string, string | undefined> }

type Entry = Card & { decks: string[] }
const cards = corpus as unknown as Entry[]

/** Cards that play themselves entirely, per sample deck, as a share. A floor
 *  just under where each stands: a change to the compiler may raise these,
 *  and must not quietly lower them. */
const FLOOR: Record<string, number> = {
  'Aristocrat': 0.85,
  'Land & Draw': 0.87,
  'Abzan Armor': 0.93,
}

describe('coverage of the sample decks', () => {
  const decks = [...new Set(cards.flatMap((c) => c.decks))]

  it.each(decks)('reads enough of %s', (deck) => {
    const inDeck = cards.filter((c) => c.decks.includes(deck))
    const count = (grade: string) => inDeck.filter((c) => compile(c).coverage === grade).length
    const [auto, partial, manual] = [count('auto'), count('partial'), count('manual')]
    if (process.env.COVERAGE_REPORT) {
      console.log(`${deck.padEnd(12)} ${inDeck.length} cards: auto ${auto}, partial ${partial}, manual ${manual}`)
    }
    expect(auto / inDeck.length).toBeGreaterThanOrEqual(FLOOR[deck])
  })

  /* Every card's grade, as a snapshot: a pattern that starts reading one
   * card and stops reading another shows up here by name, where the totals
   * above would have called it even. */
  it('grades each card as it did', () => {
    expect(Object.fromEntries(cards.map((c) => [c.name, compile(c).coverage]))).toMatchSnapshot()
  })

  it('lists what is still unread, when asked', () => {
    if (!process.env.COVERAGE_REPORT) return
    const unread = new Map<string, number>()
    for (const card of cards) {
      const { spell, triggers, unread: lines } = compile(card)
      for (const line of lines) unread.set(line, (unread.get(line) ?? 0) + 1)
      for (const ability of [spell, ...triggers]) {
        if (ability && !ability.complete) unread.set(`[part] ${ability.text}`, (unread.get(`[part] ${ability.text}`) ?? 0) + 1)
      }
    }
    console.log([...unread].sort((a, b) => b[1] - a[1]).map(([l, n]) => `${n} ${l}`).join('\n'))
  })
})
