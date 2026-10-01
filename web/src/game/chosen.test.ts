import { describe, expect, it } from 'vitest'

import type { Card } from '../lib/api'
import { costOf } from './cast'
import { compile } from './compiler/compile'
import { reduce } from './reducer'
import { power } from './stats'
import { BEARS, card, FOREST, game, PLAINS } from './testing'
import type { Action, GameState, Instance, Zone } from './types'

const ruled = (placed: [Card, Zone, Partial<Instance>?][], extra: Partial<GameState> = {}) =>
  game(placed, { rules: true, ...extra })
const run = (state: GameState, ...actions: Action[]) => actions.reduce(reduce, state)
const at = (state: GameState, iid: string) => state.cards.find((c) => c.iid === iid)!
const pass: Action = { type: 'pass' }
const cast = (iid: string): Action => ({ type: 'play', iid })
const forests: [Card, Zone][] = [[FOREST, 'battlefield'], [FOREST, 'battlefield'], [FOREST, 'battlefield']]

const elf = card('Elvish Visionary', 'Creature — Elf Shaman', { mana_cost: '{1}{G}', power: '1', toughness: '1', colors: 'G' })
const banner = card('Patchwork Banner', 'Artifact', {
  mana_cost: '{G}',
  oracle_text: 'As Patchwork Banner enters, choose a creature type.\nCreatures you control of the chosen type get +1/+1.\n{T}: Add one mana of any color.',
})

describe('choosing a creature type', () => {
  it('asks as the permanent arrives, offering the types in the deck', () => {
    expect(compile(banner).coverage).toBe('auto')
    const asked = run(ruled([[banner, 'hand'], ...forests, [BEARS, 'battlefield'], [elf, 'library'], [elf, 'library']]), cast('c0'), pass)
    expect(asked.pending).toMatchObject({ kind: 'type', iid: 'c0' })
    // Elves twice, so they come first; then the rest.
    expect(asked.pending).toMatchObject({ options: ['Elf', 'Shaman', 'Bear'] })
    const chose = reduce(asked, { type: 'pickType', subtype: 'Bear' })
    expect(chose.pending).toBeNull()
    expect(at(chose, 'c0').chosenType).toBe('Bear')
  })

  it('pumps the chosen type, and nothing else', () => {
    const state = ruled([[banner, 'battlefield', { chosenType: 'Bear' }], [BEARS, 'battlefield'], [elf, 'battlefield']])
    expect(power(at(state, 'c1'), state)).toBe(3)
    expect(power(at(state, 'c2'), state)).toBe(1)
  })

  it('does nothing until a type is chosen', () => {
    const state = ruled([[banner, 'battlefield'], [BEARS, 'battlefield']], { pending: { kind: 'confirm', prompt: 'busy' } })
    expect(power(at(state, 'c1'), state)).toBe(2)
  })

  it('forgets the choice when the permanent leaves', () => {
    const state = ruled([[banner, 'battlefield', { chosenType: 'Bear' }]])
    expect(at(reduce(state, { type: 'move', iid: 'c0', zone: 'hand' }), 'c0').chosenType).toBeUndefined()
  })

  it('triggers on the chosen type arriving', () => {
    const pretender = card('Bloodline Pretender', 'Artifact Creature — Shapeshifter', {
      power: '2', toughness: '2', keywords: ['Changeling'],
      oracle_text: 'Changeling\nAs Bloodline Pretender enters, choose a creature type.\nWhenever another creature you control of the chosen type enters, put a +1/+1 counter on Bloodline Pretender.',
    })
    expect(compile(pretender).coverage).toBe('auto')
    const start = ruled([[pretender, 'battlefield', { chosenType: 'Elf' }], [elf, 'hand'], [BEARS, 'hand'], ...forests, [FOREST, 'battlefield']])
    const one = run(start, cast('c1'), pass)
    expect(one.stack).toHaveLength(1)
    const two = run(one, pass, cast('c2'), pass)
    expect(two.stack).toEqual([])
    expect(at(two, 'c0').counters).toEqual({ '+1/+1': 1 })
  })

  it('makes spells of the chosen type cheaper', () => {
    const horn = card("Herald's Horn", 'Artifact', {
      oracle_text: "As Herald's Horn enters, choose a creature type.\nCreature spells you cast of the chosen type cost {1} less to cast.\nAt the beginning of your upkeep, look at the top card of your library. If it's a creature card of the chosen type, you may reveal it and put it into your hand.",
    })
    expect(compile(horn).coverage).toBe('auto')
    const state = ruled([[horn, 'battlefield', { chosenType: 'Elf' }], [elf, 'hand'], [BEARS, 'hand']])
    expect(costOf(state, at(state, 'c1')).generic).toBe(0)
    expect(costOf(state, at(state, 'c2')).generic).toBe(1)
  })

  it('looks for the chosen type on top of the library', () => {
    const horn = card("Herald's Horn", 'Artifact', {
      oracle_text: "As Herald's Horn enters, choose a creature type.\nAt the beginning of your upkeep, look at the top card of your library. If it's a creature card of the chosen type, you may reveal it and put it into your hand.",
    })
    const start = ruled([[horn, 'battlefield', { chosenType: 'Elf' }], [elf, 'library'], [PLAINS, 'library'], [PLAINS, 'library']], { step: 'cleanup' })
    const asked = run(start, pass, pass)
    expect(asked.pending).toMatchObject({ kind: 'confirm', prompt: expect.stringContaining('Elvish Visionary') })
    expect(at(reduce(asked, { type: 'confirm', yes: true }), 'c1').zone).toBe('hand')
  })

  it('takes colored mana off Morophon\'s chosen type', () => {
    const morophon = card('Morophon, the Boundless', 'Legendary Creature — Shapeshifter', {
      power: '6', toughness: '6', keywords: ['Changeling'],
      oracle_text: 'Changeling\nAs Morophon enters, choose a creature type.\nSpells of the chosen type you cast cost {W}{U}{B}{R}{G} less to cast. This effect reduces only the amount of colored mana you pay.\nOther creatures you control of the chosen type get +1/+1.',
    })
    expect(compile(morophon).coverage).toBe('auto')
    const state = ruled([[morophon, 'battlefield', { chosenType: 'Elf' }], [elf, 'hand'], [elf, 'battlefield'], [BEARS, 'hand']])
    expect(costOf(state, at(state, 'c1'))).toMatchObject({ generic: 1, pips: [] })
    expect(costOf(state, at(state, 'c3'))).toMatchObject({ generic: 1, pips: [['G']] })
    expect(power(at(state, 'c2'), state)).toBe(2)
    // Itself a changeling, but "other".
    expect(power(at(state, 'c0'), state)).toBe(6)
  })

  it('counts a permanent that is the chosen type as that type', () => {
    const throne = card('Roaming Throne', 'Artifact Creature — Golem', {
      power: '4', toughness: '4',
      oracle_text: 'Ward {2}\nAs Roaming Throne enters, choose a creature type.\nRoaming Throne is the chosen type in addition to its other types.',
    })
    const lord = card('Lord', 'Creature — Elf', { power: '2', toughness: '2', oracle_text: 'Other Elf creatures you control get +1/+1.' })
    const state = ruled([[throne, 'battlefield', { chosenType: 'Elf' }], [lord, 'battlefield']])
    expect(power(at(state, 'c0'), state)).toBe(5)
  })

  it('makes every creature every type under Maskwood Nexus', () => {
    const nexus = card('Maskwood Nexus', 'Artifact', {
      oracle_text: "Creatures you control are every creature type. The same is true for creature spells you control and creature cards you own that aren't on the battlefield.",
    })
    expect(compile(nexus).coverage).toBe('auto')
    const lord = card('Lord', 'Creature — Elf', { power: '2', toughness: '2', oracle_text: 'Other Elf creatures you control get +1/+1.' })
    const without = ruled([[lord, 'battlefield'], [BEARS, 'battlefield']])
    expect(power(at(without, 'c1'), without)).toBe(2)
    const state = ruled([[lord, 'battlefield'], [BEARS, 'battlefield'], [nexus, 'battlefield']])
    expect(power(at(state, 'c1'), state)).toBe(3)
  })
})
