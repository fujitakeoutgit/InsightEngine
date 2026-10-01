import { describe, expect, it } from 'vitest'

import type { Card } from '../lib/api'
import { compile } from './compiler/compile'
import { reduce } from './reducer'
import { isCreature } from './sources'
import { power } from './stats'
import { BEARS, card, FOREST, game, PLAINS, SWAMP } from './testing'
import type { Action, GameState, Instance, Zone } from './types'

const ruled = (placed: [Card, Zone, Partial<Instance>?][], extra: Partial<GameState> = {}) =>
  game(placed, { rules: true, ...extra })
const run = (state: GameState, ...actions: Action[]) => actions.reduce(reduce, state)
const at = (state: GameState, iid: string) => state.cards.find((c) => c.iid === iid)!
const tokens = (state: GameState) => state.cards.filter((c) => c.token)
const pass: Action = { type: 'pass' }
const cast = (iid: string): Action => ({ type: 'play', iid })
const permanent = (name: string, text: string, type = 'Enchantment', extra: Partial<Card> = {}) =>
  card(name, type, { oracle_text: text, ...extra })
const forests: [Card, Zone][] = [[FOREST, 'battlefield'], [FOREST, 'battlefield'], [FOREST, 'battlefield']]
const library: [Card, Zone][] = [[PLAINS, 'library'], [SWAMP, 'library'], [PLAINS, 'library'], [SWAMP, 'library']]
/** On to the given step, attacking with nothing if the game asks. */
const onTo = (state: GameState, step: 'end' | 'upkeep' | 'main1') => {
  const asked = reduce(state, { type: 'passTo', step })
  return asked.pending?.kind === 'attack' ? run(asked, { type: 'attack', iids: [] }, { type: 'passTo', step }) : asked
}
const giant = card('Hill Giant', 'Creature — Giant', { mana_cost: '{3}{R}', cmc: 4, power: '3', toughness: '3' })

describe('a copy for as long as something is attached', () => {
  it('makes the enchanted creature a copy of another, until the Aura leaves', () => {
    const alteration = permanent('Metamorphic Alteration', 'Enchant creature\nAs this Aura enters, choose a creature.\nEnchanted creature is a copy of the chosen creature.', 'Enchantment — Aura', { mana_cost: '{G}' })
    expect(compile(alteration).coverage).toBe('auto')
    const start = ruled([[alteration, 'hand'], [FOREST, 'battlefield'], [BEARS, 'battlefield'], [giant, 'battlefield'], [BEARS, 'battlefield'], ...library])
    const hosted = run(start, cast('c0'), pass, { type: 'choose', iids: ['c2'] })
    expect(hosted.pending).toMatchObject({ kind: 'pick', options: ['c3', 'c4'] })
    const done = run(hosted, { type: 'choose', iids: ['c3'] })
    expect(at(done, 'c2').card.name).toBe('Hill Giant')
    expect(at(done, 'c0').attachedTo).toBe('c2')
    // Still one next turn; itself again once the Aura is gone.
    expect(at(onTo(done, 'main1'), 'c2').card.name).toBe('Hill Giant')
    expect(at(run(done, { type: 'move', iid: 'c0', zone: 'graveyard' }), 'c2').card.name).toBe('Grizzly Bears')
  })

  it('arrives with a Rebel to carry it, and makes its bearer a copy', () => {
    const blade = card('Blade of Shared Souls', 'Artifact — Equipment', {
      mana_cost: '{G}',
      oracle_text: 'For Mirrodin! (When this Equipment enters, create a 2/2 red Rebel creature token, then attach this to it.)\nWhenever this Equipment becomes attached to a creature, for as long as this Equipment remains attached to it, you may have that creature become a copy of another target creature you control.\nEquip {2}',
    })
    expect(compile(blade).coverage).toBe('auto')
    const start = ruled([[blade, 'hand'], ...forests, [giant, 'battlefield'], ...library])
    const arrived = run(start, cast('c0'), pass, pass)
    const [rebel] = tokens(arrived)
    expect(rebel.card.name).toBe('Rebel')
    expect(at(arrived, 'c0').attachedTo).toBe(rebel.iid)
    // Being attached is what the second ability watches for.
    const asked = run(arrived, pass)
    expect(asked.pending).toMatchObject({ kind: 'pick', options: ['c4'] })
    const copied = run(asked, { type: 'choose', iids: ['c4'] })
    expect(at(copied, rebel.iid).card.name).toBe('Hill Giant')
    // Moved to the Giant: the Rebel is a Rebel again.
    const moved = run(copied, { type: 'activate', iid: 'c0', index: 0 }, pass, { type: 'choose', iids: ['c4'] })
    expect(at(moved, rebel.iid).card.name).toBe('Rebel')
  })

  it('becomes a copy of a creature in a graveyard, keeping his own name', () => {
    const taskmaster = permanent('Taskmaster, Mercenary Mimic', "Photographic Reflexes — At the beginning of your first main phase, until your next turn, Taskmaster becomes a copy of up to one target creature on the battlefield or creature card in a graveyard, except his name is Taskmaster, Mercenary Mimic and he's a legendary Human Mercenary Villain creature.", 'Legendary Creature — Human Mercenary Villain', { power: '3', toughness: '5' })
    expect(compile(taskmaster).coverage).toBe('auto')
    const start = ruled([[taskmaster, 'battlefield'], [giant, 'graveyard'], [BEARS, 'battlefield'], [FOREST, 'graveyard'], ...library, ...library])
    const asked = onTo(start, 'main1')
    expect(asked.pending).toMatchObject({ kind: 'pick', zone: 'graveyard', options: ['c0', 'c2', 'c1'] })
    const done = run(asked, { type: 'choose', iids: ['c1'] })
    expect(at(done, 'c0').card).toMatchObject({ name: 'Taskmaster, Mercenary Mimic', type_line: 'Legendary Creature — Human Mercenary Villain', power: '3', toughness: '3' })
    // Himself again as the next turn begins — and asked again.
    const next = onTo(done, 'main1')
    expect(at(next, 'c0').card.toughness).toBe('5')
    expect(next.pending).toMatchObject({ kind: 'pick' })
  })
})

describe('becoming something lesser', () => {
  it('makes the enchanted permanent a plain colorless land while the Aura stays', () => {
    const moon = permanent('Imprisoned in the Moon', 'Enchant creature, land, or planeswalker\nEnchanted permanent is a colorless land with "{T}: Add {C}" and loses all other card types and abilities.', 'Enchantment — Aura', { mana_cost: '{G}' })
    expect(compile(moon).coverage).toBe('auto')
    const start = ruled([[moon, 'hand'], [FOREST, 'battlefield'], [giant, 'battlefield'], ...library])
    const done = run(start, cast('c0'), pass, { type: 'choose', iids: ['c2'] })
    const land = at(done, 'c2')
    expect(land.card).toMatchObject({ name: 'Hill Giant', type_line: 'Land' })
    expect(isCreature(land)).toBe(false)
    expect(reduce(done, { type: 'mana', iid: 'c2' }).pool.C).toBe(1)
    expect(at(run(done, { type: 'move', iid: 'c0', zone: 'graveyard' }), 'c2').card.type_line).toBe('Creature — Giant')
  })

  it('turns a chosen permanent into a Treasure while the thief is around', () => {
    const larcenist = permanent('Kitesail Larcenist', 'Flying, ward {1}\nWhen this creature enters, for each player, choose up to one other target artifact or creature that player controls. For as long as this creature remains on the battlefield, the chosen permanents become Treasure artifacts with "{T}, Sacrifice this artifact: Add one mana of any color" and lose all other abilities.', 'Creature — Human Pirate', { mana_cost: '{G}', power: '2', toughness: '3', keywords: ['Flying', 'Ward'] })
    expect(compile(larcenist).coverage).toBe('auto')
    const start = ruled([[larcenist, 'hand'], [FOREST, 'battlefield'], [BEARS, 'battlefield'], ...library])
    const asked = run(start, cast('c0'), pass, pass)
    expect(asked.pending).toMatchObject({ kind: 'pick', options: ['c2'], min: 0 })
    const done = run(asked, { type: 'choose', iids: ['c2'] })
    expect(at(done, 'c2').card).toMatchObject({ name: 'Grizzly Bears', type_line: 'Artifact — Treasure' })
    expect(compile(at(done, 'c2').card).activated).toHaveLength(1)
    expect(at(run(done, { type: 'move', iid: 'c0', zone: 'graveyard' }), 'c2').card.type_line).toBe('Creature — Bear')
  })

  it('blights a land into one that makes only colorless', () => {
    const ultima = permanent('Ultima, Origin of Oblivion', 'Flying\nWhenever Ultima attacks, put a blight counter on target land. For as long as that land has a blight counter on it, it loses all land types and abilities and has "{T}: Add {C}."\nWhenever you tap a land for {C}, add an additional {C}.', 'Legendary Creature — God', { power: '4', toughness: '4', keywords: ['Flying'] })
    expect(compile(ultima).coverage).toBe('auto')
    const start = ruled([[ultima, 'battlefield'], [FOREST, 'battlefield'], ...library], { step: 'combatAttackers', pending: { kind: 'attack', options: ['c0'] } })
    const done = run(start, { type: 'attack', iids: ['c0'] }, pass, { type: 'choose', iids: ['c1'] })
    expect(at(done, 'c1')).toMatchObject({ counters: { blight: 1 }, card: { type_line: 'Basic Land' } })
    // One for the land, and Ultima's one more.
    const tapped = reduce(done, { type: 'mana', iid: 'c1' })
    expect([tapped.pool.C, tapped.pool.G]).toEqual([2, 0])
    expect(power(at(done, 'c0'), done)).toBe(4)
  })
})
