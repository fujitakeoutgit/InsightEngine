import { describe, expect, it } from 'vitest'

import type { Card } from '../lib/api'
import { abilitiesOf, activationProblem } from './activate'
import { landDrops } from './cast'
import { compile } from './compiler/compile'
import { reduce } from './reducer'
import { card, FOREST, game } from './testing'
import type { Action, GameState, Instance, Zone } from './types'

const ruled = (placed: [Card, Zone, Partial<Instance>?][], extra: Partial<GameState> = {}) =>
  game(placed, { rules: true, ...extra })
const run = (state: GameState, ...actions: Action[]) => actions.reduce(reduce, state)
const at = (state: GameState, iid: string) => state.cards.find((c) => c.iid === iid)!
const pass: Action = { type: 'pass' }

const druid = card('Druid Class', 'Enchantment — Class', {
  mana_cost: '{1}{G}',
  oracle_text: [
    '(Gain the next level as a sorcery to add its ability.)',
    'Whenever a land you control enters, you gain 1 life.',
    '{2}{G}: Level 2',
    'You may play an additional land on each of your turns.',
    '{4}{G}: Level 3',
    'When this Class becomes level 3, you gain 5 life.',
  ].join('\n'),
})
const lands: [Card, Zone][] = Array.from({ length: 8 }, () => [FOREST, 'battlefield'])

describe('a Class', () => {
  it('has only its first level to begin with', () => {
    const compiled = compile(druid)
    expect(compiled.statics).toEqual([])
    expect(compiled.triggers).toHaveLength(1)
    expect(compiled.activated).toMatchObject([{ cost: { mana: '{2}{G}' }, sorcery: true, effects: [{ op: 'levelUp' }] }])
    expect(compiled.coverage).toBe('auto')
    expect(landDrops(ruled([[druid, 'battlefield']]))).toBe(1)
  })

  it('gains a level for its cost, and that level\'s ability with it', () => {
    const start = ruled([[druid, 'battlefield'], ...lands])
    const two = run(start, { type: 'activate', iid: 'c0', index: 0 }, pass)
    expect(landDrops(two)).toBe(2)
    expect(at(two, 'c0').card.name).toBe('Druid Class')
    // What is offered next is the level after.
    expect(abilitiesOf(at(two, 'c0'))).toMatchObject([{ cost: { mana: '{4}{G}' } }])
  })

  it('sets off what happens as it becomes a level', () => {
    const start = ruled([[druid, 'battlefield'], ...lands])
    const two = run(start, { type: 'activate', iid: 'c0', index: 0 }, pass)
    const three = run(two, { type: 'activate', iid: 'c0', index: 0 }, pass)
    expect(three.stack).toHaveLength(1)
    expect(run(three, pass).life).toBe(45)
    expect(abilitiesOf(at(three, 'c0'))).toEqual([])
  })

  it('levels up only when a sorcery could be cast', () => {
    const combat = ruled([[druid, 'battlefield'], ...lands], { step: 'combatBegin' })
    expect(activationProblem(combat, 'c0', 0)).toBe('Only in a main phase, with the stack empty')
  })

  it('is level one again once it has left', () => {
    const two = run(ruled([[druid, 'battlefield'], ...lands]), { type: 'activate', iid: 'c0', index: 0 }, pass)
    const back = reduce(two, { type: 'move', iid: 'c0', zone: 'hand' })
    expect(compile(at(back, 'c0').card).statics).toEqual([])
  })
})
