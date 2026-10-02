import { describe, expect, it } from 'vitest'

import type { Card } from '../lib/api'
import { reduce } from './reducer'
import { BEARS, card, FOREST, game, PLAINS } from './testing'
import type { Action, GameState, Instance, Zone } from './types'

const ruled = (placed: [Card, Zone, Partial<Instance>?][], extra: Partial<GameState> = {}) =>
  game(placed, { rules: true, ...extra })
const run = (state: GameState, ...actions: Action[]) => actions.reduce(reduce, state)
const pass: Action = { type: 'pass' }

const mourner = card('Mourner', 'Enchantment', { oracle_text: 'Whenever a creature you control dies, you gain 1 life.' })
const scribe = card('Scribe', 'Enchantment', { oracle_text: 'Whenever a creature you control dies, draw a card.' })
const library: [Card, Zone][] = [[PLAINS, 'library'], [FOREST, 'library']]

describe('abilities that trigger together', () => {
  const start = ruled([[mourner, 'battlefield'], [scribe, 'battlefield'], [BEARS, 'battlefield'], ...library])
  const died = reduce(start, { type: 'move', iid: 'c2', zone: 'graveyard' })

  it('ask which resolves first', () => {
    expect(died.stack).toHaveLength(2)
    expect(died.pending).toEqual({ kind: 'order', ids: died.stack.map((item) => item.id) })
    // Nothing else moves until that is answered.
    expect(reduce(died, pass)).toBe(died)
  })

  it('go on the stack in the order chosen, the first named on top', () => {
    const [gain, draw] = died.stack.map((item) => item.id)
    const ordered = reduce(died, { type: 'order', ids: [gain, draw] })
    expect(ordered.pending).toBeNull()
    expect(ordered.stack.map((item) => item.id)).toEqual([draw, gain])
    expect(run(ordered, pass).life).toBe(41)
    const other = reduce(died, { type: 'order', ids: [draw, gain] })
    expect(run(other, pass).life).toBe(40)
    expect(run(other, pass, pass).life).toBe(41)
  })

  it('refuse an order that is not of the abilities asked about', () => {
    expect(reduce(died, { type: 'order', ids: ['nope'] })).toBe(died)
    expect(reduce(died, { type: 'order', ids: [died.stack[0].id] })).toBe(died)
  })

  it('do not ask when they all say the same thing', () => {
    const twins = ruled([[mourner, 'battlefield'], [mourner, 'battlefield'], [BEARS, 'battlefield']])
    const both = reduce(twins, { type: 'move', iid: 'c2', zone: 'graveyard' })
    expect(both.stack).toHaveLength(2)
    expect(both.pending).toBeNull()
  })

  it('leave the ones already waiting where they are', () => {
    const waiting = ruled([[mourner, 'battlefield'], [scribe, 'battlefield'], [BEARS, 'battlefield'], [BEARS, 'battlefield'], ...library])
    const first = run(waiting, { type: 'move', iid: 'c2', zone: 'graveyard' })
    const [a, b] = first.stack.map((item) => item.id)
    const second = run(first, { type: 'order', ids: [a, b] }, { type: 'move', iid: 'c3', zone: 'graveyard' })
    expect(second.stack).toHaveLength(4)
    expect(second.stack.slice(0, 2).map((item) => item.id)).toEqual([b, a])
    expect(second.pending).toMatchObject({ kind: 'order', ids: second.stack.slice(2).map((item) => item.id) })
  })
})

