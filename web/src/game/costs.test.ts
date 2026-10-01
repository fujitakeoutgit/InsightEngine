import { describe, expect, it } from 'vitest'

import type { Card } from '../lib/api'
import { abilitiesOf, activationProblem } from './activate'
import { checkCast, costOf } from './cast'
import { compile } from './compiler/compile'
import { readCost } from './compiler/activated'
import { reduce } from './reducer'
import { power, toughness } from './stats'
import { BEARS, card, FOREST, game, PLAINS, SWAMP } from './testing'
import type { Action, GameState, Instance, Zone } from './types'

const ruled = (placed: [Card, Zone, Partial<Instance>?][], extra: Partial<GameState> = {}) =>
  game(placed, { rules: true, ...extra })
const run = (state: GameState, ...actions: Action[]) => actions.reduce(reduce, state)
const at = (state: GameState, iid: string) => state.cards.find((c) => c.iid === iid)!
const pass: Action = { type: 'pass' }
const cast = (iid: string): Action => ({ type: 'play', iid })

describe('spells that cost less', () => {
  const medallion = card('Sapphire Medallion', 'Artifact', { oracle_text: 'Blue spells you cast cost {1} less to cast.' })
  const blue = card('Air Elemental', 'Creature — Elemental', { mana_cost: '{3}{U}{U}', colors: 'U', power: '4', toughness: '4' })

  it('takes generic mana off what matches', () => {
    expect(compile(medallion)).toMatchObject({ coverage: 'auto', statics: [{ kind: 'costLess', filter: { colors: ['U'] }, amount: 1 }] })
    const state = ruled([[medallion, 'battlefield'], [blue, 'hand'], [BEARS, 'hand']])
    expect(costOf(state, at(state, 'c1')).generic).toBe(2)
    expect(costOf(state, at(state, 'c2')).generic).toBe(1)
  })

  it('adds up, and stops at nothing', () => {
    const cheap = card('Sprite', 'Creature — Faerie', { mana_cost: '{1}{U}', colors: 'U' })
    const state = ruled([[medallion, 'battlefield'], [medallion, 'battlefield'], [cheap, 'hand']])
    expect(costOf(state, at(state, 'c2'))).toMatchObject({ generic: 0, pips: [['U']] })
  })

  it('reads a tribe', () => {
    const baron = card('Baron', 'Legendary Creature — Human Villain', { oracle_text: 'Villain spells you cast cost {1} less to cast.' })
    const henchman = card('Henchman', 'Creature — Human Villain', { mana_cost: '{2}{B}' })
    const state = ruled([[baron, 'battlefield'], [henchman, 'hand']])
    expect(costOf(state, at(state, 'c1')).generic).toBe(1)
  })

  it('counts the board for a spell that discounts itself', () => {
    const act = card('Blasphemous Act', 'Sorcery', {
      mana_cost: '{8}{R}',
      oracle_text: 'This spell costs {1} less to cast for each creature on the battlefield.\nBlasphemous Act deals 13 damage to each creature.',
    })
    expect(compile(act).coverage).toBe('auto')
    const state = ruled([[act, 'hand'], [BEARS, 'battlefield'], [BEARS, 'battlefield'], [BEARS, 'battlefield']])
    expect(costOf(state, at(state, 'c0')).generic).toBe(5)
  })

  it('checks a condition, sentence by sentence', () => {
    const snare = card('Geistlight Snare', 'Instant', {
      mana_cost: '{2}{U}',
      oracle_text: 'This spell costs {1} less to cast if you control a Spirit. It also costs {1} less to cast if you control an enchantment.\nCounter target spell unless its controller pays {3}.',
    })
    expect(compile(snare).coverage).toBe('auto')
    const spirit = card('Ghost', 'Creature — Spirit')
    const aura = card('Glow', 'Enchantment')
    expect(costOf(ruled([[snare, 'hand']]), ruled([[snare, 'hand']]).cards[0]).generic).toBe(2)
    const one = ruled([[snare, 'hand'], [spirit, 'battlefield']])
    expect(costOf(one, one.cards[0]).generic).toBe(1)
    const both = ruled([[snare, 'hand'], [spirit, 'battlefield'], [aura, 'battlefield']])
    expect(costOf(both, both.cards[0]).generic).toBe(0)
  })

  it('lets the discount decide what can be cast', () => {
    const state = ruled([[medallion, 'battlefield'], [blue, 'hand'], ...Array.from({ length: 4 }, (): [Card, Zone] => [card('Island', 'Basic Land — Island'), 'battlefield'])])
    expect(checkCast(state, 'c1').why).toBeUndefined()
  })
})

describe('more ways to pay for an ability', () => {
  it('reads two costs joined by "and"', () => {
    expect(readCost('Remove three quest counters from ~ and sacrifice it')).toMatchObject({
      remove: { counter: 'quest', count: 3 }, sacrificeSelf: true,
    })
  })

  it('pays for Khalni Heart Expedition with its counters and itself', () => {
    const expedition = card('Khalni Heart Expedition', 'Enchantment', {
      oracle_text: 'Landfall — Whenever a land you control enters, you may put a quest counter on Khalni Heart Expedition.\nRemove three quest counters from Khalni Heart Expedition and sacrifice it: Search your library for up to two basic land cards, put them onto the battlefield tapped, then shuffle.',
    })
    expect(compile(expedition).coverage).toBe('auto')
    const short = ruled([[expedition, 'battlefield', { counters: { quest: 2 } }]])
    expect(activationProblem(short, 'c0', 0)).toBe('Not enough quest counters')
    const ready = ruled([[expedition, 'battlefield', { counters: { quest: 3 } }], [PLAINS, 'library'], [SWAMP, 'library']])
    const asked = run(ready, { type: 'activate', iid: 'c0', index: 0 }, pass)
    expect(at(asked, 'c0').zone).toBe('graveyard')
    expect(asked.pending).toMatchObject({ kind: 'pick', zone: 'library', max: 2 })
  })

  it('puts a counter on Wall of Roots for mana, once a turn', () => {
    const roots = card('Wall of Roots', 'Creature — Plant Wall', {
      power: '0', toughness: '5', keywords: ['Defender'],
      oracle_text: 'Defender\nPut a -0/-1 counter on Wall of Roots: Add {G}. Activate only once each turn.',
    })
    expect(compile(roots).coverage).toBe('auto')
    expect(abilitiesOf({ ...ruled([[roots, 'battlefield']]).cards[0] })[0]).toMatchObject({
      cost: { add: { counter: '-0/-1', count: 1 } }, mana: [['G']], oncePerTurn: true,
    })
    const tapped = run(ruled([[roots, 'battlefield']]), { type: 'activate', iid: 'c0', index: 0 })
    expect(tapped.pool.G).toBe(1)
    expect(at(tapped, 'c0').counters).toEqual({ '-0/-1': 1 })
    expect([power(at(tapped, 'c0'), tapped), toughness(at(tapped, 'c0'), tapped)]).toEqual([0, 4])
    expect(activationProblem(tapped, 'c0', 0)).toBe('Only once each turn')
  })

  it('taps another permanent as the cost', () => {
    const relic = card('Relic of Legends', 'Artifact', {
      oracle_text: '{T}: Add one mana of any color.\nTap an untapped legendary creature you control: Add one mana of any color.',
    })
    const legend = card('Old King', 'Legendary Creature — Human Noble', { power: '3', toughness: '3' })
    expect(compile(relic).coverage).toBe('auto')
    const none = ruled([[relic, 'battlefield'], [BEARS, 'battlefield']])
    expect(activationProblem(none, 'c0', 0)).toBe('Nothing to tap for it')
    const one = run(ruled([[relic, 'battlefield'], [legend, 'battlefield']]), { type: 'activate', iid: 'c0', index: 0 })
    expect(at(one, 'c1').tapped).toBe(true)
    expect(Object.values(one.pool).reduce((a, b) => a + b, 0)).toBe(1)
    // The Relic itself was not tapped: that is its other ability.
    expect(at(one, 'c0').tapped).toBe(false)
    const asked = run(ruled([[relic, 'battlefield'], [legend, 'battlefield'], [legend, 'battlefield']]), { type: 'activate', iid: 'c0', index: 0 })
    expect(asked.pending).toMatchObject({ kind: 'pick', options: ['c1', 'c2'], min: 1, max: 1 })
    expect(at(reduce(asked, { type: 'choose', iids: ['c2'] }), 'c2').tapped).toBe(true)
  })
})

describe('life as a cost', () => {
  it('pays X life for Toxic Deluge, and shrinks everything by X', () => {
    const deluge = card('Toxic Deluge', 'Sorcery', {
      mana_cost: '{G}',
      oracle_text: 'As an additional cost to cast this spell, pay X life.\nAll creatures get -X/-X until end of turn.',
    })
    expect(compile(deluge).coverage).toBe('auto')
    const done = run(ruled([[deluge, 'hand'], [FOREST, 'battlefield'], [BEARS, 'battlefield']]), { type: 'play', iid: 'c0', x: 2 }, pass)
    expect(done.life).toBe(38)
    expect(at(done, 'c2').zone).toBe('graveyard')
  })
})

describe('casting', () => {
  it('still casts an ordinary spell for its printed cost', () => {
    const state = ruled([[BEARS, 'hand'], [FOREST, 'battlefield'], [FOREST, 'battlefield']])
    expect(at(run(state, cast('c0')), 'c0').zone).toBe('stack')
  })
})
