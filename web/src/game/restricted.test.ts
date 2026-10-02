import { describe, expect, it } from 'vitest'

import type { Card } from '../lib/api'
import { activationProblem } from './activate'
import { castWays, checkCast } from './cast'
import { compile } from './compiler/compile'
import { reduce } from './reducer'
import { BEARS, card, FOREST, game, PLAINS, SWAMP } from './testing'
import type { Action, GameState, Instance, Zone } from './types'

const ruled = (placed: [Card, Zone, Partial<Instance>?][], extra: Partial<GameState> = {}) =>
  game(placed, { rules: true, ...extra })
const run = (state: GameState, ...actions: Action[]) => actions.reduce(reduce, state)
const at = (state: GameState, iid: string) => state.cards.find((c) => c.iid === iid)!
const zone = (state: GameState, iid: string) => at(state, iid).zone
const pass: Action = { type: 'pass' }
const cast = (iid: string): Action => ({ type: 'play', iid })
const castable = (state: GameState, iid: string) => !checkCast(state, iid).why
const library: [Card, Zone][] = [[PLAINS, 'library'], [SWAMP, 'library'], [PLAINS, 'library'], [SWAMP, 'library']]
const mountain = card('Mountain', 'Basic Land — Mountain')

describe('mana that may only be spent one way', () => {
  const territory = card('Unclaimed Territory', 'Land', {
    oracle_text: 'As this land enters, choose a creature type.\n{T}: Add {C}.\n{T}: Add one mana of any color. Spend this mana only to cast a creature spell of the chosen type.',
  })
  const elf = card('Elvish Mystic', 'Creature — Elf Druid', { mana_cost: '{G}', power: '1', toughness: '1' })
  const goblin = card('Raging Goblin', 'Creature — Goblin', { mana_cost: '{R}', power: '1', toughness: '1' })
  const growth = card('Giant Growth', 'Instant', { mana_cost: '{G}', oracle_text: 'Draw a card.' })
  const relic = card('Bauble', 'Artifact', { mana_cost: '{1}' })

  it('pays in color for a creature of the chosen type, and only colorless for anything else', () => {
    expect(compile(territory).coverage).toBe('auto')
    const state = ruled([[territory, 'battlefield', { chosenType: 'Elf' }], [elf, 'hand'], [goblin, 'hand'], [growth, 'hand'], [relic, 'hand']])
    expect(['c1', 'c2', 'c3', 'c4'].map((iid) => castable(state, iid))).toEqual([true, false, false, true])
  })

  it('pays for any creature spell where that is all it asks', () => {
    const countryside = card('Abundant Countryside', 'Land', { oracle_text: '{T}: Add {C}.\n{T}: Add one mana of any color. Spend this mana only to cast a creature spell.' })
    const state = ruled([[countryside, 'battlefield'], [goblin, 'hand'], [growth, 'hand']])
    expect([castable(state, 'c1'), castable(state, 'c2')]).toEqual([true, false])
  })

  it('pays for abilities of the right kind of permanent as well', () => {
    const hideout = card('Villainous Hideout', 'Land', { oracle_text: '{T}: Add {C}.\n{T}: Add one mana of any color. Spend this mana only to cast a Villain spell or to activate an ability of a Villain source.' })
    const villain = card('Schemer', 'Creature — Human Villain', { mana_cost: '{B}', power: '1', toughness: '1', oracle_text: '{B}: Draw a card.' })
    const bystander = card('Bystander', 'Creature — Human Citizen', { mana_cost: '{B}', power: '1', toughness: '1', oracle_text: '{B}: Draw a card.' })
    const state = ruled([[hideout, 'battlefield'], [villain, 'battlefield'], [bystander, 'battlefield'], [villain, 'hand'], [bystander, 'hand'], ...library])
    expect([activationProblem(state, 'c1', 0), Boolean(activationProblem(state, 'c2', 0))]).toEqual([null, true])
    expect([castable(state, 'c3'), castable(state, 'c4')]).toEqual([true, false])
    // A cost that is no spell and no ability is not what the mana is for.
    const upkeep = card('Tithe', 'Enchantment', { oracle_text: 'Cumulative upkeep {B}' })
    const owing = ruled([[hideout, 'battlefield'], [upkeep, 'battlefield', { counters: { age: 0 } }], ...library, ...library])
    const asked = reduce(owing, { type: 'passTo', step: 'upkeep' })
    expect(zone(run(asked, { type: 'confirm', yes: true }), 'c1')).toBe('graveyard')
  })
})

describe('counters stored up as mana', () => {
  const crucible = card('Crucible of the Spirit Dragon', 'Land', {
    oracle_text: '{T}: Add {C}.\n{1}, {T}: Put a storage counter on this land.\n{T}, Remove X storage counters from this land: Add X mana in any combination of colors. Spend this mana only to cast Dragon spells or activate abilities of Dragons.',
  })
  const dragon = card('Shivan Dragon', 'Creature — Dragon', { mana_cost: '{4}{R}{R}', power: '5', toughness: '5' })
  const whelp = card('Dragon Whelp', 'Creature — Dragon', { mana_cost: '{R}', power: '2', toughness: '3' })

  it('spends just the counters a Dragon spell needs', () => {
    expect(compile(crucible).coverage).toBe('auto')
    const start = ruled([[crucible, 'battlefield', { counters: { storage: 5 } }], [mountain, 'battlefield'], [mountain, 'battlefield'], [dragon, 'hand'], ...library])
    expect(castable(start, 'c3')).toBe(true)
    const done = run(start, cast('c3'))
    expect(zone(done, 'c3')).toBe('stack')
    expect(at(done, 'c0')).toMatchObject({ tapped: true, counters: { storage: 1 } })
    // Nothing is left floating that was not asked for.
    expect(Object.values(done.pool).reduce((a, b) => a + b, 0)).toBe(0)
  })

  it('keeps its counters where ordinary mana will do, and from anything that is not a Dragon', () => {
    const start = ruled([[crucible, 'battlefield', { counters: { storage: 5 } }], [mountain, 'battlefield'], [whelp, 'hand'], [BEARS, 'hand'], [FOREST, 'battlefield']])
    const done = run(start, cast('c2'))
    expect(at(done, 'c0').counters).toEqual({ storage: 5 })
    // Bears cost {1}{G}: the Forest and the Crucible's {C}, and no counters.
    const bears = run(start, cast('c3'))
    expect([zone(bears, 'c3'), at(bears, 'c0').counters]).toEqual(['stack', { storage: 5 }])
    const short = ruled([[crucible, 'battlefield', { counters: { storage: 5 } }], [BEARS, 'hand']])
    expect(castable(short, 'c1')).toBe(false)
  })
})

describe('overload', () => {
  it('does to each what the spell would do to one', () => {
    const mortars = card('Mizzium Mortars', 'Sorcery', { mana_cost: '{1}{R}', oracle_text: 'Mizzium Mortars deals 4 damage to target creature you control.\nOverload {3}{R}{R}{R}' })
    expect(compile(mortars)).toMatchObject({ coverage: 'auto', skipped: [], ways: [{ kind: 'overload', cost: '{3}{R}{R}{R}' }] })
    const board: [Card, Zone][] = Array.from({ length: 6 }, () => [mountain, 'battlefield'])
    const start = ruled([[mortars, 'hand'], ...board, [BEARS, 'battlefield'], [BEARS, 'battlefield'], ...library])
    expect(castWays(start, at(start, 'c0')).map((way) => way.key)).toEqual(['normal', 'overload'])
    const done = run(start, cast('c0'), { type: 'cast', way: 'overload' }, pass)
    expect([zone(done, 'c7'), zone(done, 'c8'), done.pending]).toEqual(['graveyard', 'graveyard', null])
    const one = run(start, cast('c0'), { type: 'cast', way: 'normal' }, pass)
    expect(one.pending).toMatchObject({ kind: 'pick' })
  })

  it('is set aside where "each" does not read', () => {
    const odd = card('Odd Spell', 'Sorcery', { mana_cost: '{R}', oracle_text: 'Target creature you control fights itself.\nOverload {4}{R}' })
    expect(compile(odd).skipped).toEqual(['Overload {4}{R}'])
  })
})
