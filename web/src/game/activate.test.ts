import { describe, expect, it } from 'vitest'

import type { Card } from '../lib/api'
import { abilitiesOf, activationProblem, costLabel } from './activate'
import { reduce } from './reducer'
import { hasKeyword, power, toughness } from './stats'
import { BEARS, card, FOREST, game, PLAINS, WALKER } from './testing'
import type { Action, GameState, Instance, Zone } from './types'

const ruled = (placed: [Card, Zone, Partial<Instance>?][], extra: Partial<GameState> = {}) =>
  game(placed, { rules: true, ...extra })
const run = (state: GameState, ...actions: Action[]) => actions.reduce(reduce, state)
const at = (state: GameState, iid: string) => state.cards.find((c) => c.iid === iid)!
const zone = (state: GameState, z: Zone) => state.cards.filter((c) => c.zone === z)
const pass: Action = { type: 'pass' }
const act = (iid: string, index = 0): Action => ({ type: 'activate', iid, index })
const forests: [Card, Zone][] = [[FOREST, 'battlefield'], [FOREST, 'battlefield'], [FOREST, 'battlefield']]

describe('activated abilities', () => {
  const elder = card('Sakura-Tribe Elder', 'Creature — Snake Shaman', {
    power: '1', toughness: '1',
    oracle_text: 'Sacrifice Sakura-Tribe Elder: Search your library for a basic land card, put that card onto the battlefield tapped, then shuffle.',
  })

  it('pay their cost, go on the stack, and resolve', () => {
    const start = ruled([[elder, 'battlefield'], [PLAINS, 'library']])
    expect(abilitiesOf(at(start, 'c0')).map(costLabel)).toEqual(['sacrifice'])
    const activated = reduce(start, act('c0'))
    expect(at(activated, 'c0').zone).toBe('graveyard')
    expect(activated.stack).toHaveLength(1)
    const found = run(activated, pass, { type: 'choose', iids: ['c1'] })
    expect(at(found, 'c1')).toMatchObject({ zone: 'battlefield', tapped: true })
  })

  it('pay mana with the tapper, and tap themselves', () => {
    const maker = card('Egg Maker', 'Artifact', { oracle_text: '{2}, {T}: Create a 0/1 green Egg creature token with defender.' })
    const start = ruled([[maker, 'battlefield'], ...forests])
    const done = run(start, act('c0'), pass)
    expect(at(done, 'c0').tapped).toBe(true)
    expect(zone(done, 'battlefield').filter((c) => c.tapped)).toHaveLength(3)
    expect(done.cards.filter((c) => c.token)).toHaveLength(1)
    expect(activationProblem(done, 'c0', 0)).toBe('It is already tapped')
  })

  it('say why not', () => {
    const maker = card('Egg Maker', 'Artifact', { oracle_text: '{2}, {T}: Create a 0/1 green Egg creature token with defender.' })
    expect(activationProblem(ruled([[maker, 'battlefield'], [FOREST, 'battlefield']]), 'c0', 0))
      .toBe('Not enough mana — it costs {2}')
    const sick = card('Seer', 'Creature — Wizard', { oracle_text: '{T}: Draw a card.' })
    expect(activationProblem(ruled([[sick, 'battlefield', { sick: true }]]), 'c0', 0)).toMatch(/Summoning sick/)
  })

  it('ask what to sacrifice when there is a choice, and know what it was', () => {
    const felothar = card('Felothar', 'Legendary Creature — Human', {
      power: '0', toughness: '6',
      oracle_text: "{3}, {T}, Sacrifice another creature: Draw cards equal to the sacrificed creature's toughness, then discard cards equal to its power.",
    })
    const wall = card('Wall', 'Creature — Wall', { power: '0', toughness: '3' })
    const start = ruled([
      [felothar, 'battlefield'], [wall, 'battlefield'], [BEARS, 'battlefield'], ...forests,
      [PLAINS, 'library'], [PLAINS, 'library'], [PLAINS, 'library'],
    ])
    const asked = reduce(start, act('c0'))
    expect(asked.pending).toMatchObject({ kind: 'pick', options: ['c1', 'c2'], min: 1, max: 1 })
    // Nothing is paid until the choice is made.
    expect(at(asked, 'c0').tapped).toBe(false)
    const done = run(asked, { type: 'choose', iids: ['c1'] }, pass)
    expect(at(done, 'c1').zone).toBe('graveyard')
    expect(zone(done, 'hand')).toHaveLength(3)
    expect(done.pending).toBeNull()
  })

  it('make mana at once when that is what they are for', () => {
    const altar = card("Ashnod's Altar", 'Artifact', { oracle_text: 'Sacrifice a creature: Add {C}{C}.' })
    const done = reduce(ruled([[altar, 'battlefield'], [BEARS, 'battlefield']]), act('c0'))
    expect(done.pool.C).toBe(2)
    expect(done.stack).toEqual([])
    expect(at(done, 'c1').zone).toBe('graveyard')
  })

  it('only as a sorcery, and only once a turn, when they say so', () => {
    const slow = card('Slow', 'Artifact', { oracle_text: '{T}: Draw a card. Activate only as a sorcery.' })
    expect(activationProblem(ruled([[slow, 'battlefield']], { step: 'upkeep' }), 'c0', 0)).toMatch(/main phase/)
    const once = card('Once', 'Artifact', { oracle_text: '{0}: You gain 1 life. Activate only once each turn.' })
    const used = run(ruled([[once, 'battlefield']]), act('c0'), pass)
    expect(used.life).toBe(41)
    expect(activationProblem(used, 'c0', 0)).toBe('Only once each turn')
  })
})

describe('tokens with abilities', () => {
  it('lets a Treasure be sacrificed for mana', () => {
    const haul = card('Haul', 'Sorcery', { mana_cost: '{G}', oracle_text: 'Create a Treasure token.' })
    const made = run(ruled([[haul, 'hand'], [FOREST, 'battlefield']]), { type: 'play', iid: 'c0' }, pass)
    const treasure = made.cards.find((c) => c.token)!
    const spent = reduce(made, act(treasure.iid))
    expect(spent.cards.some((c) => c.token)).toBe(false)
    expect(Object.values(spent.pool).reduce((a, b) => a + b, 0)).toBe(1)
  })

  it('gives an Eldrazi Spawn the ability it was made with', () => {
    const zone_ = card('Awakening Zone', 'Enchantment', {
      oracle_text: 'At the beginning of your upkeep, you may create a 0/1 colorless Eldrazi Spawn creature token. It has "Sacrifice this token: Add {C}."',
    })
    const made = run(ruled([[zone_, 'battlefield'], [FOREST, 'library']], { step: 'main2' }), pass, pass, { type: 'confirm', yes: true })
    const spawn = made.cards.find((c) => c.token)!
    expect(abilitiesOf(spawn)).toHaveLength(1)
    expect(reduce(made, act(spawn.iid)).pool.C).toBe(1)
  })
})

describe('equipment and auras', () => {
  const boots = card('Swiftfoot Boots', 'Artifact — Equipment', {
    oracle_text: 'Equipped creature has hexproof and haste.\nEquip {1}',
  })
  const clamp = card('Skullclamp', 'Artifact — Equipment', {
    oracle_text: 'Equipped creature gets +1/-1.\nWhenever equipped creature dies, draw two cards.\nEquip {1}',
  })

  it('attach, and give what they give', () => {
    const start = ruled([[boots, 'battlefield'], [BEARS, 'battlefield', { sick: true }], [FOREST, 'battlefield']])
    const done = run(start, act('c0'), pass)
    expect(at(done, 'c0').attachedTo).toBe('c1')
    expect(hasKeyword(at(done, 'c1'), 'Haste', done)).toBe(true)
    // Hasty now, so it can attack the turn it arrived.
    expect(reduce(done, pass).pending).toMatchObject({ kind: 'attack', options: ['c1'] })
  })

  it('kill a 1/1 with Skullclamp, and draw two for it', () => {
    const elf = card('Elf', 'Creature — Elf', { power: '1', toughness: '1' })
    const start = ruled([[clamp, 'battlefield'], [elf, 'battlefield'], [FOREST, 'battlefield'], [PLAINS, 'library'], [PLAINS, 'library']])
    const done = run(start, act('c0'), pass, pass)
    expect(at(done, 'c1').zone).toBe('graveyard')
    expect(zone(done, 'hand')).toHaveLength(2)
    // The Equipment stays behind, on nothing.
    expect(at(done, 'c0')).toMatchObject({ zone: 'battlefield' })
    expect(at(done, 'c0').attachedTo).toBeUndefined()
  })

  it('put an Aura on a creature as it resolves', () => {
    const rancor = card('Rancor', 'Enchantment — Aura', {
      mana_cost: '{G}', oracle_text: 'Enchant creature\nEnchanted creature gets +2/+0 and has trample.',
    })
    const done = run(ruled([[rancor, 'hand'], [BEARS, 'battlefield'], [FOREST, 'battlefield']]), { type: 'play', iid: 'c0' }, pass)
    expect(at(done, 'c0').attachedTo).toBe('c1')
    expect(power(at(done, 'c1'), done)).toBe(4)
    expect(hasKeyword(at(done, 'c1'), 'Trample', done)).toBe(true)
  })
})

describe('loyalty abilities', () => {
  const ajani = { ...WALKER, oracle_text: '+1: You gain 2 life.\n−1: Put a +1/+1 counter on each creature you control.' }

  it('change loyalty as their cost, one a turn', () => {
    const start = ruled([[ajani, 'battlefield', { loyalty: 4 }], [BEARS, 'battlefield']])
    expect(abilitiesOf(at(start, 'c0')).map(costLabel)).toEqual(['+1', '−1'])
    const up = run(start, act('c0', 0), pass)
    expect(at(up, 'c0').loyalty).toBe(5)
    expect(up.life).toBe(42)
    expect(activationProblem(up, 'c0', 1)).toBe('One loyalty ability a turn')
    const down = run(start, act('c0', 1), pass)
    expect(at(down, 'c0').loyalty).toBe(3)
    expect(at(down, 'c1').counters).toEqual({ '+1/+1': 1 })
  })
})

describe('cycling', () => {
  it('discards the card from hand to draw another', () => {
    const cycler = card('Cycler', 'Creature — Beast', { mana_cost: '{4}{G}', oracle_text: 'Cycling {2}' })
    const start = ruled([[cycler, 'hand'], ...forests, [PLAINS, 'library']])
    const done = run(start, act('c0'), pass)
    expect(at(done, 'c0').zone).toBe('graveyard')
    expect(at(done, 'c4').zone).toBe('hand')
  })

  it('searches, for landcycling', () => {
    const grinder = card('Ruin Grinder', 'Artifact Creature — Construct', { oracle_text: 'Mountaincycling {2}' })
    const mountain = card('Mountain', 'Basic Land — Mountain')
    const asked = run(ruled([[grinder, 'hand'], ...forests, [PLAINS, 'library'], [mountain, 'library']]), act('c0'), pass)
    expect(asked.pending).toMatchObject({ kind: 'pick', zone: 'library', options: ['c5'] })
  })
})

describe('until end of turn', () => {
  it('pumps a creature, and lets go in cleanup', () => {
    const growth = card('Giant Growth', 'Instant', { mana_cost: '{G}', oracle_text: 'Target creature gets +3/+3 until end of turn.' })
    const start = ruled([[growth, 'hand'], [BEARS, 'battlefield'], [FOREST, 'battlefield'], [PLAINS, 'library']])
    const pumped = run(start, { type: 'play', iid: 'c0' }, pass, { type: 'choose', iids: ['c1'] })
    expect([power(at(pumped, 'c1'), pumped), toughness(at(pumped, 'c1'), pumped)]).toEqual([5, 5])
    // On through combat — declining to attack — and into the next turn.
    const next = run(pumped, pass, { type: 'attack', iids: [] }, { type: 'passTo', step: 'upkeep' })
    expect(next.turn).toBe(2)
    expect(power(at(next, 'c1'), next)).toBe(2)
  })

  it('gives a team a keyword', () => {
    const drawbridge = card('Crashing Drawbridge', 'Artifact Creature — Wall', {
      power: '0', toughness: '4', keywords: ['Defender'],
      oracle_text: 'Defender\n{T}: Creatures you control gain haste until end of turn.',
    })
    const start = ruled([[drawbridge, 'battlefield'], [BEARS, 'battlefield', { sick: true }]])
    const done = run(start, act('c0'), pass)
    expect(hasKeyword(at(done, 'c1'), 'Haste', done)).toBe(true)
  })
})
