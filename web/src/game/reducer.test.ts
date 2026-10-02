import { describe, expect, it } from 'vitest'

import type { Card, DeckToken } from '../lib/api'
import { fetchFinds, obviousFetch } from './fetch'
import { deal, reduce } from './reducer'
import {
  BEARS, card, CHECKLAND, COMMANDER, entry, FOREST, game as sandbox, GROWTH, PLAINS, TAPLAND, WALKER,
  WILDS,
} from './testing'
import type { GameState, Instance, Zone } from './types'

/** The sandbox: these tests are the table as it has always behaved. */
const game = (...placed: [Card, Zone, Partial<Instance>?][]) => sandbox(placed)

const zone = (state: GameState, z: Zone) => state.cards.filter((c) => c.zone === z)
const at = (state: GameState, iid: string) => state.cards.find((c) => c.iid === iid)!

describe('deal', () => {
  const deck = [
    entry(COMMANDER, 1, 'commander'), entry(FOREST, 30), entry(BEARS, 20),
    entry(GROWTH, 5, 'sideboard'), entry(WALKER, 1),
  ]

  it('deals seven, keeps the commander out, and leaves the sideboard behind', () => {
    const g = deal(deck, 42, false)
    expect(zone(g, 'hand')).toHaveLength(7)
    expect(zone(g, 'command').map((c) => c.card.name)).toEqual([COMMANDER.name])
    expect(zone(g, 'library')).toHaveLength(44)
    expect(g.cards.some((c) => c.card.name === GROWTH.name)).toBe(false)
    expect(g.drawn).toEqual(zone(g, 'hand').map((c) => c.iid))
    expect(g).toMatchObject({ turn: 1, life: 40, log: ['New game — drew 7'] })
  })

  it('deals the same game from the same seed, and another from another', () => {
    const order = (seed: number) => deal(deck, seed).cards.map((c) => c.iid)
    expect(order(42)).toEqual(order(42))
    expect(order(43)).not.toEqual(order(42))
  })

  it('starts a planeswalker on its printed loyalty', () => {
    expect(deal(deck, 1).cards.find((c) => c.card.name === WALKER.name)?.loyalty).toBe(4)
  })
})

describe('drawing', () => {
  it('takes the top of the library', () => {
    const after = reduce(game([FOREST, 'library'], [PLAINS, 'library']), { type: 'draw' })
    expect(at(after, 'c0').zone).toBe('hand')
    expect(at(after, 'c1').zone).toBe('library')
    expect(after.drawn).toEqual(['c0'])
    expect(after.log[0]).toBe('Drew a card')
  })

  it('says so, and animates nothing, when the library is empty', () => {
    const before = game([FOREST, 'hand'])
    const after = reduce(before, { type: 'draw' })
    expect(after.drawn).toBe(before.drawn)
    expect(after.log[0]).toBe('Drew nothing — the library is empty')
  })

  it('untaps, then draws, on a new turn', () => {
    const after = reduce(
      game([FOREST, 'battlefield', { tapped: true }], [PLAINS, 'library']),
      { type: 'nextTurn' },
    )
    expect(after.turn).toBe(2)
    expect(at(after, 'c0').tapped).toBe(false)
    expect(at(after, 'c1').zone).toBe('hand')
    expect(after.log.slice(0, 2)).toEqual(['Turn 2', 'Drew a card'])
  })
})

describe('playing', () => {
  it('resolves an instant straight to the graveyard', () => {
    const after = reduce(game([GROWTH, 'hand']), { type: 'play', iid: 'c0' })
    expect(at(after, 'c0').zone).toBe('graveyard')
    expect(after.log[0]).toBe('Cast Giant Growth')
  })

  it('deals lands along the bottom and creatures along the top', () => {
    let g = game([FOREST, 'hand'], [PLAINS, 'hand'], [BEARS, 'hand'])
    g = reduce(g, { type: 'play', iid: 'c0' })
    g = reduce(g, { type: 'play', iid: 'c1' })
    g = reduce(g, { type: 'play', iid: 'c2' })
    expect(at(g, 'c0')).toMatchObject({ zone: 'battlefield', x: 0.02, y: 0.52 })
    expect(at(g, 'c1').x).toBeCloseTo(0.125)
    expect(at(g, 'c1').y).toBe(0.52)
    expect(at(g, 'c2')).toMatchObject({ x: 0.02, y: 0.09 })
  })

  it('reuses a square that has been vacated', () => {
    let g = game([FOREST, 'hand'], [PLAINS, 'hand'], [FOREST, 'hand'])
    g = reduce(g, { type: 'play', iid: 'c0' })
    g = reduce(g, { type: 'play', iid: 'c1' })
    g = reduce(g, { type: 'move', iid: 'c0', zone: 'hand' })
    g = reduce(g, { type: 'play', iid: 'c2' })
    expect(at(g, 'c2')).toMatchObject({ x: 0.02, y: 0.52 })
  })

  it('brings a tapland in tapped', () => {
    const after = reduce(game([TAPLAND, 'hand']), { type: 'play', iid: 'c0' })
    expect(at(after, 'c0').tapped).toBe(true)
    expect(after.log[0]).toBe('Played Guildless Commons tapped')
  })

  it('reads a check land against the board', () => {
    const met = reduce(game([CHECKLAND, 'hand'], [FOREST, 'battlefield']), { type: 'play', iid: 'c0' })
    expect(at(met, 'c0').tapped).toBe(false)
    expect(met.log[0]).toBe('Played Sunpetal Grove — you control a forest')

    const unmet = reduce(game([CHECKLAND, 'hand']), { type: 'play', iid: 'c0' })
    expect(at(unmet, 'c0').tapped).toBe(true)
    expect(unmet.log[0]).toBe('Played Sunpetal Grove tapped — no forest or plains')
  })

  it('applies the same rule to a land dropped on the mat', () => {
    const after = reduce(game([TAPLAND, 'hand']), { type: 'place', iid: 'c0', at: { x: 0.3, y: 0.4 } })
    expect(at(after, 'c0')).toMatchObject({ zone: 'battlefield', tapped: true, x: 0.3, y: 0.4 })
    expect(after.log[0]).toBe('Played Guildless Commons tapped')
  })

  it('leaves a permanent tapped when it is only nudged', () => {
    const after = reduce(
      game([FOREST, 'battlefield', { tapped: true }]),
      { type: 'place', iid: 'c0', at: { x: 0.1, y: 0.1 } },
    )
    expect(at(after, 'c0')).toMatchObject({ tapped: true, x: 0.1, y: 0.1 })
    expect(after.log).toEqual([])
  })
})

describe('moving between zones', () => {
  it('untaps, and resets loyalty, on leaving the battlefield', () => {
    const after = reduce(
      game([WALKER, 'battlefield', { tapped: true, loyalty: 1 }]),
      { type: 'move', iid: 'c0', zone: 'graveyard' },
    )
    expect(at(after, 'c0')).toMatchObject({ zone: 'graveyard', tapped: false, loyalty: 4 })
  })

  it('floors loyalty at zero', () => {
    const after = reduce(game([WALKER, 'battlefield', { loyalty: 1 }]), { type: 'loyalty', iid: 'c0', by: -3 })
    expect(at(after, 'c0').loyalty).toBe(0)
  })

  it('puts a card moved to the library on top of it', () => {
    // Laid on the deck, it is the next card drawn — wherever it was dealt from.
    const before = game([FOREST, 'library'], [PLAINS, 'library'], [BEARS, 'hand'], [GROWTH, 'graveyard'])
    const stacked = [{ type: 'move', iid: 'c2', zone: 'library' }, { type: 'move', iid: 'c3', zone: 'library' }] as const
    const after = stacked.reduce(reduce, before)
    expect(zone(after, 'library').map((c) => c.iid)).toEqual(['c3', 'c2', 'c0', 'c1'])
    expect(reduce(after, { type: 'draw', count: 1 }).drawn).toEqual(['c3'])
  })

  it('ignores a card that is not there', () => {
    const before = game([FOREST, 'hand'])
    expect(reduce(before, { type: 'move', iid: 'gone', zone: 'graveyard' })).toBe(before)
    expect(reduce(before, { type: 'tap', iid: 'gone' })).toBe(before)
  })
})

describe('searching', () => {
  it('cracks a fetch into the square it leaves, tapped, and shuffles', () => {
    const before = game(
      [WILDS, 'battlefield', { x: 0.2, y: 0.6 }],
      [CHECKLAND, 'library'], [FOREST, 'library'], [PLAINS, 'library'],
    )
    const after = reduce(before, { type: 'crack', iid: 'c0', pick: 'c2' })
    expect(at(after, 'c0').zone).toBe('graveyard')
    expect(at(after, 'c2')).toMatchObject({ zone: 'battlefield', tapped: true, x: 0.2, y: 0.6 })
    expect(after.seed).not.toBe(before.seed)
    expect(after.log.slice(0, 2)).toEqual([
      'Evolving Wilds: found Forest, sacrificed, then shuffled',
      'Played Forest tapped',
    ])
  })

  it('takes the basic without asking when a fetch names one type', () => {
    const verge = card('Forest Fetch', 'Land', {
      oracle_text: '{T}, Sacrifice this land: Search your library for a Forest card, put it onto the battlefield, then shuffle.',
    })
    const dual = card('Temple Garden', 'Land — Forest Plains')
    const library = game([dual, 'library'], [FOREST, 'library']).cards
    expect(obviousFetch(fetchFinds(verge)!, library)?.card.name).toBe('Forest')
    // Any basic is a choice, so it is asked.
    expect(obviousFetch(fetchFinds(WILDS)!, library)).toBeNull()
  })

  it('tutors to hand and shuffles', () => {
    const before = game([FOREST, 'library'], [BEARS, 'library'], [PLAINS, 'library'])
    const after = reduce(before, { type: 'tutor', iid: 'c1' })
    expect(at(after, 'c1').zone).toBe('hand')
    expect(after.seed).not.toBe(before.seed)
    expect(after.log[0]).toBe('Tutored Grizzly Bears, then shuffled')
  })

  it('shuffles only the library, in the slots it already holds', () => {
    const before = game(
      [FOREST, 'battlefield'], [PLAINS, 'library'], [BEARS, 'hand'], [GROWTH, 'library'], [TAPLAND, 'library'],
    )
    const after = reduce(before, { type: 'shuffle' })
    expect(after.cards.map((c) => c.zone)).toEqual(before.cards.map((c) => c.zone))
    expect(after.cards[0]).toBe(before.cards[0])
    expect(after.cards[2]).toBe(before.cards[2])
    expect(after.log[0]).toBe('Shuffled the library')
  })
})

describe('the rest of the table', () => {
  const soldier: DeckToken = {
    oracle_id: 'soldier', name: 'Soldier', type_line: 'Token Creature — Soldier',
    pt: '1/1', color_identity: 'W', image: null, is_emblem: false,
  }

  it('makes each token its own card', () => {
    let g = reduce(game(), { type: 'token', token: soldier })
    g = reduce(g, { type: 'token', token: soldier })
    expect(new Set(g.cards.map((c) => c.iid)).size).toBe(2)
    expect(g.cards.every((c) => c.zone === 'battlefield')).toBe(true)
    expect(g.log[0]).toBe('Created Soldier')
  })

  it('keeps a running life total', () => {
    expect(reduce(game(), { type: 'life', by: -3 }).life).toBe(37)
  })

  it('records a note and nothing else', () => {
    const before = game([FOREST, 'hand'])
    const after = reduce(before, { type: 'note', line: 'Coin: heads' })
    expect(after.log).toEqual(['Coin: heads'])
    expect(after.cards).toBe(before.cards)
  })
})
