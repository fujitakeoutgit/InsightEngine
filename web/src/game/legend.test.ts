import { describe, expect, it } from 'vitest'

import type { Card } from '../lib/api'
import { compile } from './compiler/compile'
import { reduce } from './reducer'
import { card, COMMANDER, FOREST, game } from './testing'
import type { Action, GameState, Instance, Zone } from './types'

const ruled = (placed: [Card, Zone, Partial<Instance>?][], extra: Partial<GameState> = {}) =>
  game(placed, { rules: true, ...extra })
const run = (state: GameState, ...actions: Action[]) => actions.reduce(reduce, state)
const zone = (state: GameState, iid: string) => state.cards.find((c) => c.iid === iid)?.zone
const pass: Action = { type: 'pass' }
const cast = (iid: string): Action => ({ type: 'play', iid })
const forests: [Card, Zone][] = Array.from({ length: 4 }, () => [FOREST, 'battlefield'])

const YUE = card('Yue, the Moon Spirit', 'Legendary Creature — Spirit Ally', { mana_cost: '{G}', power: '2', toughness: '2' })
const KING = card('Old King', 'Legendary Creature — Human Noble', { mana_cost: '{G}', power: '2', toughness: '2' })
const CLONE = card('Clone', 'Creature — Shapeshifter', {
  mana_cost: '{G}', power: '0', toughness: '0',
  oracle_text: 'You may have this creature enter as a copy of any creature on the battlefield.',
})
const DOUBLE = card('Spark Double', 'Creature — Illusion', {
  mana_cost: '{G}', power: '0', toughness: '0',
  oracle_text: "You may have this creature enter as a copy of a creature or planeswalker you control, except it enters with an additional +1/+1 counter on it if it's a creature, it enters with an additional loyalty counter on it if it's a planeswalker, and it isn't legendary.",
})

describe('the legend rule', () => {
  it('asks which to keep when a second one of the same name arrives', () => {
    const asked = run(ruled([[YUE, 'hand'], [YUE, 'battlefield'], ...forests]), cast('c0'), pass)
    expect(asked.pending).toMatchObject({ kind: 'pick', legend: true, options: expect.arrayContaining(['c0', 'c1']), min: 1, max: 1 })
    const kept = reduce(asked, { type: 'choose', iids: ['c0'] })
    expect(kept.pending).toBeNull()
    expect([zone(kept, 'c0'), zone(kept, 'c1')]).toEqual(['battlefield', 'graveyard'])
  })

  it('will not take none, or both', () => {
    const asked = run(ruled([[YUE, 'hand'], [YUE, 'battlefield'], ...forests]), cast('c0'), pass)
    expect(reduce(asked, { type: 'choose', iids: [] })).toBe(asked)
    expect(reduce(asked, { type: 'choose', iids: ['c0', 'c1'] })).toBe(asked)
  })

  it('leaves two legends of different names alone', () => {
    const done = run(ruled([[YUE, 'hand'], [KING, 'battlefield'], ...forests]), cast('c0'), pass)
    expect(done.pending).toBeNull()
  })

  it('is asked of a copy of a legend, and the one not kept is gone', () => {
    const arriving = run(ruled([[CLONE, 'hand'], [YUE, 'battlefield'], ...forests]), cast('c0'), pass)
    // The question says what the choice is for.
    expect(arriving.pending).toMatchObject({ kind: 'pick', prompt: 'Clone: choose up to one creature to enter as a copy of' })
    const asked = reduce(arriving, { type: 'choose', iids: ['c1'] })
    expect(asked.pending).toMatchObject({ kind: 'pick', legend: true, prompt: 'Legend rule — choose the Yue, the Moon Spirit to keep' })
    const kept = reduce(asked, { type: 'choose', iids: ['c1'] })
    expect([zone(kept, 'c0'), zone(kept, 'c1')]).toEqual(['graveyard', 'battlefield'])
    // Back in the graveyard it is the card it was printed as.
    expect(kept.cards.find((c) => c.iid === 'c0')!.card.name).toBe('Clone')
  })

  it('is not asked of a copy that is not legendary', () => {
    const done = run(ruled([[DOUBLE, 'hand'], [YUE, 'battlefield'], ...forests]), cast('c0'), pass, { type: 'choose', iids: ['c1'] })
    expect(done.pending).toBeNull()
    expect(done.cards.filter((c) => c.zone === 'battlefield' && c.card.name === YUE.name)).toHaveLength(2)
  })

  it('sends a commander that is not kept home', () => {
    const asked = run(
      ruled([[CLONE, 'hand'], [COMMANDER, 'battlefield', { commander: true }], ...forests]),
      cast('c0'), pass, { type: 'choose', iids: ['c1'] },
    )
    const kept = reduce(asked, { type: 'choose', iids: ['c0'] })
    expect([zone(kept, 'c0'), zone(kept, 'c1')]).toEqual(['battlefield', 'command'])
  })

  it('does not apply while something says so', () => {
    const gallery = card('Mirror Gallery', 'Artifact', { oracle_text: 'The "legend rule" doesn\'t apply.' })
    const box = card('Mirror Box', 'Artifact', { oracle_text: 'The "legend rule" doesn\'t apply to permanents you control.' })
    expect([compile(gallery).coverage, compile(box).coverage]).toEqual(['auto', 'auto'])
    const done = run(ruled([[YUE, 'hand'], [YUE, 'battlefield'], [gallery, 'battlefield'], ...forests]), cast('c0'), pass)
    expect(done.pending).toBeNull()
  })

  it('is no business of the sandbox', () => {
    const done = reduce(game([[YUE, 'hand'], [YUE, 'battlefield']]), cast('c0'))
    expect(done.pending).toBeNull()
    expect(done.cards.filter((c) => c.zone === 'battlefield')).toHaveLength(2)
  })
})
