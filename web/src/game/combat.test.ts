import { describe, expect, it } from 'vitest'

import type { Card } from '../lib/api'
import { eligibleAttackers, expectedDamage } from './combat'
import { reduce } from './reducer'
import { BEARS, card, COMMANDER, FOREST, game } from './testing'
import type { Action, GameState, Instance, Zone } from './types'

const ruled = (placed: [Card, Zone, Partial<Instance>?][], extra: Partial<GameState> = {}) =>
  game(placed, { rules: true, ...extra })
const run = (state: GameState, ...actions: Action[]) => actions.reduce(reduce, state)
const at = (state: GameState, iid: string) => state.cards.find((c) => c.iid === iid)!
const pass: Action = { type: 'pass' }
const attack = (...iids: string[]): Action => ({ type: 'attack', iids })

const creature = (name: string, size: string, extra: Partial<Card> = {}) => {
  const [power, toughness] = size.split('/')
  return card(name, 'Creature — Test', { power, toughness, ...extra })
}
const wall = creature('Wall of Stone', '0/8', { keywords: ['Defender'], oracle_text: 'Defender' })
const felothar = card('Felothar', 'Legendary Creature — Human', {
  power: '0', toughness: '6',
  oracle_text: 'Each creature you control assigns combat damage equal to its toughness rather than its power.\n'
    + "Creatures you control can attack as though they didn't have defender.",
})

describe('declaring attackers', () => {
  it('asks when something can attack, and passes combat by when nothing can', () => {
    const ready = reduce(ruled([[BEARS, 'battlefield']]), pass)
    expect(ready).toMatchObject({ step: 'combatAttackers', pending: { kind: 'attack', options: ['c0'] } })
    expect(reduce(ruled([[BEARS, 'battlefield', { sick: true }]]), pass).step).toBe('main2')
  })

  it('lets a creature attack only if it is untapped, awake or hasty, and no defender', () => {
    const hasty = creature('Raider', '2/1', { keywords: ['Haste'], oracle_text: 'Haste' })
    const state = ruled([
      [BEARS, 'battlefield'], [BEARS, 'battlefield', { tapped: true }], [BEARS, 'battlefield', { sick: true }],
      [hasty, 'battlefield', { sick: true }], [wall, 'battlefield'], [FOREST, 'battlefield'],
    ])
    expect(eligibleAttackers(state).map((c) => c.iid)).toEqual(['c0', 'c3'])
  })

  it('taps the attackers, deals their power, and moves on to the second main phase', () => {
    const done = run(ruled([[BEARS, 'battlefield'], [BEARS, 'battlefield']]), pass, attack('c0'))
    expect(done.step).toBe('main2')
    expect(at(done, 'c0').tapped).toBe(true)
    expect(at(done, 'c1').tapped).toBe(false)
    expect(done.opponent.life).toBe(38)
    expect(done.attacking).toEqual([])
    expect(done.log).toContain('Grizzly Bears deals 2 damage to the opponent')
  })

  it('attacks with nothing when nothing is chosen', () => {
    const done = run(ruled([[BEARS, 'battlefield']]), pass, attack())
    expect(done).toMatchObject({ step: 'main2', opponent: { life: 40 } })
    expect(at(done, 'c0').tapped).toBe(false)
  })

  it('refuses a creature that may not attack', () => {
    const done = run(ruled([[BEARS, 'battlefield'], [wall, 'battlefield']]), pass, attack('c0', 'c1'))
    expect(at(done, 'c1').tapped).toBe(false)
    expect(done.opponent.life).toBe(38)
  })
})

describe('combat keywords', () => {
  it('leaves a vigilant attacker untapped', () => {
    const knight = creature('Knight', '2/2', { keywords: ['Vigilance'], oracle_text: 'Vigilance' })
    expect(at(run(ruled([[knight, 'battlefield']]), pass, attack('c0')), 'c0').tapped).toBe(false)
  })

  it('hits twice with double strike, and gains with lifelink', () => {
    const paladin = creature('Paladin', '3/3', { keywords: ['Double strike', 'Lifelink'], oracle_text: 'Double strike, lifelink' })
    const start = ruled([[paladin, 'battlefield']])
    expect(expectedDamage(start, ['c0'])).toBe(6)
    const done = run(start, pass, attack('c0'))
    expect(done.opponent.life).toBe(34)
    expect(done.life).toBe(46)
  })

  it('deals infect as poison, and ten of it wins', () => {
    const crusader = creature('Crusader', '5/5', { keywords: ['Infect'], oracle_text: 'Infect' })
    const once = run(ruled([[crusader, 'battlefield']], { opponent: { life: 40, poison: 5, commander: {} } }), pass, attack('c0'))
    expect(once.opponent).toMatchObject({ life: 40, poison: 10 })
    expect(once.won).toBe('The opponent has 10 poison counters on turn 1')
  })

  it('counts a commander’s damage apart, and 21 of it wins', () => {
    const big = { ...COMMANDER, power: '7', toughness: '7' }
    const start = ruled([[big, 'battlefield', { commander: true }]], { opponent: { life: 40, poison: 0, commander: { c0: 14 } } })
    const done = run(start, pass, attack('c0'))
    expect(done.opponent.commander).toEqual({ c0: 21 })
    expect(done.won).toBe('Felothar the Steadfast dealt 21 commander damage on turn 1')
  })
})

describe('toughness matters', () => {
  it('lets walls attack under Felothar, for their toughness', () => {
    const start = ruled([[felothar, 'battlefield'], [wall, 'battlefield']])
    expect(eligibleAttackers(start).map((c) => c.iid)).toEqual(['c0', 'c1'])
    const done = run(start, pass, attack('c0', 'c1'))
    expect(done.opponent.life).toBe(40 - 6 - 8)
    expect(done.opponent.commander).toEqual({})
  })
})

describe('combat triggers', () => {
  it('stop after attackers for "whenever ~ attacks", then deal damage', () => {
    const krenko = creature('Krenko', '1/2', {
      oracle_text: 'Whenever Krenko attacks, put a +1/+1 counter on it, then create a number of 1/1 red Goblin creature tokens equal to Krenko\'s power.',
    })
    const declared = run(ruled([[krenko, 'battlefield']]), pass, attack('c0'))
    expect(declared.step).toBe('combatAttackers')
    expect(declared.stack).toHaveLength(1)
    const resolved = reduce(declared, pass)
    expect(at(resolved, 'c0').counters).toEqual({ '+1/+1': 1 })
    expect(resolved.cards.filter((c) => c.token)).toHaveLength(2)
    const done = reduce(resolved, pass)
    // It grew before damage, so it hits for 2; the tokens did not attack.
    expect(done).toMatchObject({ step: 'main2', opponent: { life: 38 } })
  })

  it('fire when combat damage is dealt to the opponent', () => {
    const ikra = card('Ikra Shidiqi', 'Legendary Creature — Naga', {
      power: '3', toughness: '7',
      oracle_text: 'Menace\nWhenever a creature you control deals combat damage to a player, you gain life equal to that creature\'s toughness.',
    })
    const hit = run(ruled([[ikra, 'battlefield'], [BEARS, 'battlefield']]), pass, attack('c0', 'c1'))
    expect(hit.step).toBe('combatDamage')
    expect(hit.stack).toHaveLength(2)
    const done = run(hit, pass, pass, pass)
    expect(done.life).toBe(40 + 7 + 2)
    expect(done.step).toBe('main2')
  })

  it('stop at the beginning of combat for what happens there', () => {
    const banner = card('Banner', 'Enchantment', { oracle_text: 'At the beginning of combat on your turn, you gain 1 life.' })
    const begun = reduce(ruled([[banner, 'battlefield']]), pass)
    expect(begun.step).toBe('combatBegin')
    expect(run(begun, pass, pass)).toMatchObject({ step: 'main2', life: 41 })
  })
})
