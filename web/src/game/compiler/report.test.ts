import { describe, expect, it } from 'vitest'

import { BEARS, card, FOREST, OMENS } from '../testing'
import { report } from './report'

const half = card('Half Read', 'Sorcery', { oracle_text: 'Draw a card. Then do something nobody has written down.' })
const riddle = card('Riddle', 'Enchantment', { oracle_text: 'Each player shuffles their hand into their library.' })
const drifter = card('Mulldrifter', 'Creature — Elemental', {
  oracle_text: 'Flying\nWhen Mulldrifter enters, draw two cards.\nEvoke {2}{U}',
})

describe('the coverage report', () => {
  it('counts each card once, lands and all', () => {
    const out = report([BEARS, BEARS, FOREST, OMENS, half, riddle])
    expect(out).toMatchObject({ total: 5, auto: 3, partial: 1, manual: 1 })
  })

  it('lists what is left in words, under the card\'s own name', () => {
    const out = report([half, riddle, BEARS])
    expect(out.cards.map((c) => [c.name, c.coverage])).toEqual([['Riddle', 'manual'], ['Half Read', 'partial']])
    expect(out.cards[0].left).toEqual(['Each player shuffles their hand into their library.'])
    expect(out.cards[1].left).toEqual(['Draw a card. Then do something nobody has written down.'])
  })

  it('lists what is not offered apart, for a card that otherwise plays itself', () => {
    const out = report([drifter, BEARS])
    expect(out).toMatchObject({ auto: 2, partial: 0, manual: 0 })
    expect(out.cards).toEqual([{ name: 'Mulldrifter', coverage: 'auto', left: [], skipped: ['Evoke {2}{U}'] }])
  })

  it('puts by-hand cards first, then partly automatic, then the rest, each by name', () => {
    const zebra = card('Zebra Riddle', 'Enchantment', { oracle_text: 'Each player shuffles their hand into their library.' })
    const out = report([drifter, half, zebra, riddle])
    expect(out.cards.map((c) => c.name)).toEqual(['Riddle', 'Zebra Riddle', 'Half Read', 'Mulldrifter'])
  })
})
