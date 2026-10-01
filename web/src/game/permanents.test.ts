import { describe, expect, it } from 'vitest'

import type { Card } from '../lib/api'
import { eligibleAttackers } from './combat'
import { compile } from './compiler/compile'
import { isKind, sweeping } from './kinds'
import { reduce } from './reducer'
import { manaAbilities } from './sources'
import { hasKeyword } from './stats'
import { BEARS, card, FOREST, game, PLAINS, SWAMP } from './testing'
import type { Action, GameState, Instance, Zone } from './types'

const ruled = (placed: [Card, Zone, Partial<Instance>?][], extra: Partial<GameState> = {}) =>
  game(placed, { rules: true, ...extra })
const run = (state: GameState, ...actions: Action[]) => actions.reduce(reduce, state)
const at = (state: GameState, iid: string) => state.cards.find((c) => c.iid === iid)!
const zone = (state: GameState, z: Zone) => state.cards.filter((c) => c.zone === z).map((c) => c.iid)
const tokens = (state: GameState) => state.cards.filter((c) => c.token)
const pass: Action = { type: 'pass' }
const cast = (iid: string): Action => ({ type: 'play', iid })
const spell = (name: string, text: string, cost = '{G}', type = 'Sorcery') =>
  card(name, type, { mana_cost: cost, oracle_text: text })
const forests: [Card, Zone][] = [[FOREST, 'battlefield'], [FOREST, 'battlefield'], [FOREST, 'battlefield']]
const library: [Card, Zone][] = [[PLAINS, 'library'], [SWAMP, 'library'], [PLAINS, 'library']]

describe('more mana from the same tap', () => {
  const nissa = card('Nissa', 'Legendary Planeswalker — Nissa', {
    loyalty: '5', oracle_text: 'Whenever you tap a Forest for mana, add an additional {G}.',
  })

  it('doubles a Forest under Nissa, and leaves a Plains alone', () => {
    expect(compile(nissa)).toMatchObject({ coverage: 'auto', statics: [{ kind: 'extraMana', adds: 'G' }] })
    const state = ruled([[nissa, 'battlefield', { loyalty: 5 }], [FOREST, 'battlefield'], [PLAINS, 'battlefield']])
    expect(manaAbilities(at(state, 'c1'), state)[0].makes).toEqual([['G'], ['G']])
    expect(manaAbilities(at(state, 'c2'), state)[0].makes).toEqual([['W']])
    expect(reduce(state, { type: 'mana', iid: 'c1' }).pool.G).toBe(2)
  })

  it('doubles colorless for whatever makes only that', () => {
    const monument = card('Forsaken Monument', 'Legendary Artifact', {
      oracle_text: 'Whenever you tap a permanent for {C}, add an additional {C}.',
    })
    const wastes = card('Wastes', 'Basic Land', { oracle_text: '{T}: Add {C}.' })
    expect(compile(monument).coverage).toBe('auto')
    const state = ruled([[monument, 'battlefield'], [wastes, 'battlefield'], [FOREST, 'battlefield']])
    expect(manaAbilities(at(state, 'c1'), state)[0].makes).toEqual([['C'], ['C']])
    expect(manaAbilities(at(state, 'c2'), state)[0].makes).toEqual([['G']])
  })
})

describe('lands that are every basic land type', () => {
  const dryad = card('Dryad of the Ilysian Grove', 'Enchantment Creature — Nymph Dryad', {
    power: '2', toughness: '4',
    oracle_text: 'You may play an additional land on each of your turns.\nLands you control are every basic land type in addition to their other types.',
  })

  it('tap for any color, and count as any basic land', () => {
    expect(compile(dryad).coverage).toBe('auto')
    const state = ruled([[dryad, 'battlefield'], [PLAINS, 'battlefield']])
    expect(manaAbilities(at(state, 'c1'), state)[0].makes).toEqual([['W', 'U', 'B', 'R', 'G']])
    expect(isKind(at(state, 'c1'), { subtypes: ['Forest'] }, undefined, sweeping(state))).toBe(true)
    expect(isKind(at(state, 'c0'), { subtypes: ['Forest'] }, undefined, sweeping(state))).toBe(false)
    const without = ruled([[PLAINS, 'battlefield']])
    expect(isKind(at(without, 'c0'), { subtypes: ['Forest'] }, undefined, sweeping(without))).toBe(false)
  })
})

describe('an ability that works from the graveyard', () => {
  const anger = card('Anger', 'Creature — Incarnation', {
    power: '2', toughness: '2', keywords: ['Haste'],
    oracle_text: 'Haste\nAs long as Anger is in your graveyard and you control a Mountain, creatures you control have haste.',
  })
  const mountain = card('Mountain', 'Basic Land — Mountain')

  it('gives haste while Anger is buried and a Mountain is out', () => {
    expect(compile(anger).coverage).toBe('auto')
    const state = ruled([[anger, 'graveyard'], [mountain, 'battlefield'], [BEARS, 'battlefield']])
    expect(hasKeyword(at(state, 'c2'), 'Haste', state)).toBe(true)
    const noMountain = ruled([[anger, 'graveyard'], [FOREST, 'battlefield'], [BEARS, 'battlefield']])
    expect(hasKeyword(at(noMountain, 'c2'), 'Haste', noMountain)).toBe(false)
    const alive = ruled([[anger, 'battlefield'], [mountain, 'battlefield'], [BEARS, 'battlefield']])
    expect(hasKeyword(at(alive, 'c2'), 'Haste', alive)).toBe(false)
  })
})

describe("the city's blessing", () => {
  const swordtooth = card('Wayward Swordtooth', 'Creature — Dinosaur', {
    power: '5', toughness: '5',
    oracle_text: "Ascend\nYou may play an additional land on each of your turns.\nWayward Swordtooth can't attack or block unless you have the city's blessing.",
  })

  it('is had from ten permanents on, and kept', () => {
    expect(compile(swordtooth).coverage).toBe('auto')
    const few = ruled([[swordtooth, 'battlefield'], ...forests])
    expect(eligibleAttackers(few)).toEqual([])
    const ten: [Card, Zone][] = Array.from({ length: 9 }, () => [FOREST, 'battlefield'])
    const many = run(ruled([[swordtooth, 'battlefield'], ...ten, [PLAINS, 'hand']]), cast('c10'))
    expect(many.blessing).toBe(true)
    expect(eligibleAttackers(many).map((c) => c.iid)).toEqual(['c0'])
    const fewer = reduce(many, { type: 'move', iid: 'c1', zone: 'graveyard' })
    expect(fewer.blessing).toBe(true)
  })
})

describe('life and counters', () => {
  it('sets your life to the counters on Eternity Vessel', () => {
    const vessel = card('Eternity Vessel', 'Artifact', {
      oracle_text: 'Eternity Vessel enters with X charge counters on it, where X is your life total.\nLandfall — Whenever a land you control enters, you may have your life total become the number of charge counters on Eternity Vessel.',
    })
    expect(compile(vessel).coverage).toBe('auto')
    const start = ruled([[vessel, 'battlefield', { counters: { charge: 40 } }], [FOREST, 'hand']], { life: 12 })
    const done = run(start, cast('c1'), pass, { type: 'confirm', yes: true })
    expect(done.life).toBe(40)
    expect(done.tally.gained).toBe(28)
  })

  it('turns Lightning Coils\' counters into Elementals for a turn', () => {
    const coils = card('Lightning Coils', 'Artifact', {
      oracle_text: 'Whenever a nontoken creature you control dies, put a charge counter on Lightning Coils.\nAt the beginning of your upkeep, if Lightning Coils has five or more charge counters on it, remove all of them from it and create that many 3/1 red Elemental creature tokens with haste. Exile them at the beginning of the next end step.',
    })
    expect(compile(coils).coverage).toBe('auto')
    const start = ruled([[coils, 'battlefield', { counters: { charge: 6 } }], ...library], { step: 'cleanup' })
    const done = run(start, pass, pass)
    expect(tokens(done)).toHaveLength(6)
    expect(tokens(done)[0]).toMatchObject({ fleeting: 'end', card: { name: 'Elemental', keywords: ['Haste'] } })
    expect(at(done, 'c0').counters).toEqual({ charge: 0 })
    const short = run(ruled([[coils, 'battlefield', { counters: { charge: 4 } }], ...library], { step: 'cleanup' }), pass)
    expect(short.stack).toEqual([])
  })

  it('makes Insects for the damage Hornet Nest takes', () => {
    const nest = card('Hornet Nest', 'Creature — Insect', {
      power: '0', toughness: '2', keywords: ['Defender'],
      oracle_text: 'Defender\nWhenever Hornet Nest is dealt damage, create that many 1/1 green Insect creature tokens with flying and deathtouch.',
    })
    expect(compile(nest).coverage).toBe('auto')
    const storm = spell('Storm', 'Storm deals 3 damage to each creature.')
    const hit = run(ruled([[storm, 'hand'], ...forests, [nest, 'battlefield']]), cast('c0'), pass)
    expect(at(hit, 'c4').zone).toBe('graveyard')
    expect(hit.stack).toHaveLength(1)
    expect(tokens(run(hit, pass))).toHaveLength(3)
  })

  it('takes a counter off Undergrowth Champion in place of damage', () => {
    const champion = card('Undergrowth Champion', 'Creature — Elemental', {
      power: '2', toughness: '2',
      oracle_text: 'If damage would be dealt to Undergrowth Champion while it has a +1/+1 counter on it, prevent that damage and remove a +1/+1 counter from Undergrowth Champion.\nLandfall — Whenever a land you control enters, put a +1/+1 counter on Undergrowth Champion.',
    })
    expect(compile(champion).coverage).toBe('auto')
    const storm = spell('Storm', 'Storm deals 3 damage to each creature.')
    const shielded = run(ruled([[storm, 'hand'], ...forests, [champion, 'battlefield', { counters: { '+1/+1': 2 } }]]), cast('c0'), pass)
    expect(at(shielded, 'c4')).toMatchObject({ zone: 'battlefield', counters: { '+1/+1': 1 } })
    expect(at(shielded, 'c4').damage ?? 0).toBe(0)
    const bare = run(ruled([[storm, 'hand'], ...forests, [champion, 'battlefield']]), cast('c0'), pass)
    expect(at(bare, 'c4').zone).toBe('graveyard')
  })
})

describe('whole hands and whole graveyards', () => {
  it('discards the hand and draws seven for Ruin Grinder', () => {
    const grinder = card('Ruin Grinder', 'Artifact Creature — Construct', {
      power: '7', toughness: '4',
      oracle_text: 'Menace\nWhen Ruin Grinder dies, each player may discard their hand and draw seven cards.\nMountaincycling {2}',
    })
    expect(compile(grinder).coverage).toBe('auto')
    const deck: [Card, Zone][] = Array.from({ length: 8 }, () => [FOREST, 'library'])
    const asked = run(ruled([[grinder, 'battlefield'], [BEARS, 'hand'], [PLAINS, 'hand'], ...deck]), { type: 'move', iid: 'c0', zone: 'graveyard' }, pass)
    expect(asked.pending).toMatchObject({ kind: 'confirm' })
    const done = reduce(asked, { type: 'confirm', yes: true })
    expect(zone(done, 'graveyard').sort()).toEqual(['c0', 'c1', 'c2'])
    expect(zone(done, 'hand')).toHaveLength(7)
    expect(done.pending).toBeNull()
  })

  it('returns every small creature for Rally the Ancestors, until your next upkeep', () => {
    const rally = spell('Rally the Ancestors', 'Return each creature card with mana value X or less from your graveyard to the battlefield. Exile those creatures at the beginning of your next upkeep. Exile Rally the Ancestors.', '{X}{G}', 'Instant')
    expect(compile(rally).coverage).toBe('auto')
    const big = card('Colossus', 'Creature — Giant', { cmc: 6, power: '6', toughness: '6' })
    const small = card('Squire', 'Creature — Human', { cmc: 2, power: '1', toughness: '2' })
    const start = ruled([[rally, 'hand'], ...forests, [small, 'graveyard'], [big, 'graveyard'], [small, 'graveyard'], ...library])
    const done = run(start, { type: 'play', iid: 'c0', x: 2 }, pass)
    expect(zone(done, 'battlefield').filter((iid) => ['c4', 'c5', 'c6'].includes(iid))).toEqual(['c4', 'c6'])
    expect(at(done, 'c0').zone).toBe('exile')
    expect(at(done, 'c4').fleeting).toBe('upkeep')
    const next = run(done, { type: 'passTo', step: 'upkeep' })
    expect(at(next, 'c4').zone).toBe('exile')
    expect(at(next, 'c6').zone).toBe('exile')
  })

  it('adds mana of the color the hand wants', () => {
    const greed = spell('Greed', 'Add two mana of any one color.', '{G}', 'Instant')
    const blue = card('Air Elemental', 'Creature — Elemental', { mana_cost: '{3}{U}{U}' })
    const done = run(ruled([[greed, 'hand'], [FOREST, 'battlefield'], [blue, 'hand']]), cast('c0'), pass)
    expect(done.pool.U).toBe(2)
  })
})

describe('echo', () => {
  const marshal = card('Mogg War Marshal', 'Creature — Goblin Warrior', {
    mana_cost: '{G}', power: '1', toughness: '1',
    oracle_text: 'Echo {1}{R}\nWhen Mogg War Marshal enters or dies, create a 1/1 red Goblin creature token.',
  })
  const mountain = card('Mountain', 'Basic Land — Mountain')

  it('asks for its cost at your next upkeep, and is sacrificed if you do not pay', () => {
    expect(compile(marshal).coverage).toBe('auto')
    const start = ruled([[marshal, 'hand'], [FOREST, 'battlefield'], [mountain, 'battlefield'], ...library])
    const entered = run(start, cast('c0'), pass, pass)
    expect(at(entered, 'c0')).toMatchObject({ zone: 'battlefield', echo: true })
    // Passing to the upkeep resolves what it finds there, as far as the
    // question echo asks.
    const asked = run(entered, { type: 'passTo', step: 'upkeep' })
    expect(asked.step).toBe('upkeep')
    expect(asked.pending).toMatchObject({ kind: 'confirm' })
    const paid = reduce(asked, { type: 'confirm', yes: true })
    expect(at(paid, 'c0')).toMatchObject({ zone: 'battlefield' })
    expect(at(paid, 'c0').echo).toBeUndefined()
    const refused = reduce(asked, { type: 'confirm', yes: false })
    expect(at(refused, 'c0').zone).toBe('graveyard')
  })

  it('is asked only once', () => {
    const start = ruled([[marshal, 'battlefield'], ...library], { step: 'cleanup' })
    expect(run(start, pass).stack).toEqual([])
  })
})
