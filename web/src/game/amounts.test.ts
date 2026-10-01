import { describe, expect, it } from 'vitest'

import type { Card } from '../lib/api'
import { compile } from './compiler/compile'
import { readSentence } from './compiler/effects'
import { readAmount } from './compiler/read'
import { reduce } from './reducer'
import { power, toughness } from './stats'
import { BEARS, card, FOREST, game, OMENS, PLAINS, SWAMP } from './testing'
import type { Action, GameState, Instance, Zone } from './types'

const ruled = (placed: [Card, Zone, Partial<Instance>?][], extra: Partial<GameState> = {}) =>
  game(placed, { rules: true, ...extra })
const run = (state: GameState, ...actions: Action[]) => actions.reduce(reduce, state)
const at = (state: GameState, iid: string) => state.cards.find((c) => c.iid === iid)!
const zone = (state: GameState, z: Zone) => state.cards.filter((c) => c.zone === z)
const pass: Action = { type: 'pass' }
const cast = (iid: string): Action => ({ type: 'play', iid })
const spell = (name: string, text: string, cost = '{G}', type = 'Sorcery') =>
  card(name, type, { mana_cost: cost, oracle_text: text })
const forests: [Card, Zone][] = [[FOREST, 'battlefield'], [FOREST, 'battlefield'], [FOREST, 'battlefield']]

describe('reading how many', () => {
  it('reads what a number can be worked out from', () => {
    expect(readAmount('the number of lands you control')).toEqual({ per: { controller: 'you', types: ['land'] } })
    expect(readAmount('the number of cards in your hand')).toEqual({ zone: 'hand' })
    expect(readAmount('the number of land cards in your graveyard')).toEqual({ zone: 'graveyard', filter: { types: ['land'] } })
    expect(readAmount('the number of +1/+1 counters on ~')).toEqual({ counters: '+1/+1', of: 'self' })
    expect(readAmount('the number of colors among permanents you control')).toBe('colors')
    expect(readAmount('your life total')).toBe('life')
    expect(readAmount("~'s power")).toEqual({ stat: 'power', of: 'self' })
    expect(readAmount("that permanent's mana value")).toEqual({ stat: 'manaValue', of: 'event' })
    expect(readAmount('the total toughness of other creatures you control')).toEqual({
      total: 'toughness', of: { controller: 'you', other: true, types: ['creature'] },
    })
    expect(readAmount('the number of opponents you have')).toBe(1)
    expect(readAmount('the number of creatures destroyed this way')).toBe('thatMany')
    expect(readAmount('how you feel about it')).toBeNull()
  })

  it('puts what X is in place of X', () => {
    expect(readSentence('create x 1/1 blue squid creature tokens with islandwalk, where x is the number of +1/+1 counters on ~')).toMatchObject([
      { op: 'token', count: { counters: '+1/+1', of: 'self' }, token: { name: 'Squid' } },
    ])
    expect(readSentence('search your library for up to x basic land cards, where x is the number of lands you control, put them onto the battlefield tapped, then shuffle')).toMatchObject([
      { op: 'search', count: { per: { controller: 'you', types: ['land'] } }, upTo: true, to: 'battlefield', tapped: true },
    ])
  })

  it('reads "equal to" the same way', () => {
    expect(readSentence('you lose life equal to the number of cards in your hand')).toEqual([
      { op: 'life', who: 'you', sign: -1, count: { zone: 'hand' } },
    ])
    expect(readSentence('put a number of +1/+1 counters on ~ equal to the number of lands you control')).toMatchObject([
      { op: 'counters', to: { kind: 'self' }, counter: '+1/+1', count: { per: { types: ['land'] } } },
    ])
  })
})

describe('amounts, as the game stands', () => {
  it('searches for as many lands as you control', () => {
    const realms = spell('Boundless Realms', 'Search your library for up to X basic land cards, where X is the number of lands you control, put them onto the battlefield tapped, then shuffle.')
    const asked = run(ruled([[realms, 'hand'], ...forests, [PLAINS, 'library'], [SWAMP, 'library'], [FOREST, 'library'], [PLAINS, 'library']]), cast('c0'), pass)
    expect(asked.pending).toMatchObject({ kind: 'pick', zone: 'library', max: 3 })
  })

  it('shrinks everything by what was sacrificed', () => {
    const scales = spell('Tip the Scales', "Sacrifice a creature. When you do, all creatures get -X/-X until end of turn, where X is the sacrificed creature's toughness.")
    const big = card('Hill Giant', 'Creature — Giant', { power: '3', toughness: '3' })
    const asked = run(ruled([[scales, 'hand'], ...forests, [BEARS, 'battlefield'], [big, 'battlefield']]), cast('c0'), pass)
    expect(asked.pending).toMatchObject({ kind: 'pick', min: 1, max: 1 })
    const done = reduce(asked, { type: 'choose', iids: ['c4'] })
    // The Bears were sacrificed: 2 toughness, so the Giant is 1/1 for the turn.
    expect(at(done, 'c4').zone).toBe('graveyard')
    expect([power(at(done, 'c5'), done), toughness(at(done, 'c5'), done)]).toEqual([1, 1])
  })

  it('makes a token as big as what was destroyed is many', () => {
    const rebirth = spell('Phyrexian Rebirth', 'Destroy all creatures, then create an X/X colorless Phyrexian Horror artifact creature token, where X is the number of creatures destroyed this way.')
    const done = run(ruled([[rebirth, 'hand'], ...forests, [BEARS, 'battlefield'], [OMENS, 'battlefield']]), cast('c0'), pass)
    const horror = done.cards.find((c) => c.token)!
    expect(horror.card).toMatchObject({ name: 'Phyrexian Horror', power: '2', toughness: '2' })
    expect(zone(done, 'graveyard').map((c) => c.iid).sort()).toEqual(['c0', 'c4', 'c5'])
  })

  it('counts the cards in your hand', () => {
    const baldin = card('Baldin', 'Legendary Creature — Human', {
      power: '0', toughness: '7',
      oracle_text: 'Whenever Baldin attacks, up to one hundred target creatures each get +0/+X until end of turn, where X is the number of cards in your hand.',
    })
    const trigger = compile(baldin).triggers[0]
    expect(trigger).toMatchObject({
      complete: true,
      effects: [
        { op: 'choose', count: 100, upTo: true },
        { op: 'boost', to: { kind: 'chosen' }, power: 0, toughness: { sign: 1, count: { zone: 'hand' } } },
      ],
    })
  })

  it('arrives with counters worked out from the board', () => {
    const titan = card('Towering Titan', 'Creature — Giant', {
      mana_cost: '{G}', power: '0', toughness: '0',
      oracle_text: 'Towering Titan enters with X +1/+1 counters on it, where X is the total toughness of other creatures you control.',
    })
    const done = run(ruled([[titan, 'hand'], ...forests, [BEARS, 'battlefield'], [OMENS, 'battlefield', { counters: { '+1/+1': 1 } }]]), cast('c0'), pass)
    // Bears 2, and a Wall of Omens with a counter but no printed size: 1.
    expect(at(done, 'c0').counters).toEqual({ '+1/+1': 3 })
  })

  it('arrives with as many counters as your life', () => {
    const vessel = card('Eternity Vessel', 'Artifact', {
      mana_cost: '{G}', oracle_text: 'Eternity Vessel enters with X charge counters on it, where X is your life total.',
    })
    const done = run(ruled([[vessel, 'hand'], ...forests], { life: 37 }), cast('c0'), pass)
    expect(at(done, 'c0').counters).toEqual({ charge: 37 })
  })

  it('remembers the counters on a creature that has died', () => {
    const skulker = card('Chasm Skulker', 'Creature — Squid Horror', {
      power: '1', toughness: '1',
      oracle_text: 'When Chasm Skulker dies, create X 1/1 blue Squid creature tokens with islandwalk, where X is the number of +1/+1 counters on Chasm Skulker.',
    })
    const start = ruled([[skulker, 'battlefield', { counters: { '+1/+1': 3 } }]])
    const died = run(start, { type: 'move', iid: 'c0', zone: 'graveyard' }, pass)
    expect(died.cards.filter((c) => c.token)).toHaveLength(3)
  })

  it('gives each creature counters by its own size', () => {
    const gargantuan = card('Canopy Gargantuan', 'Creature — Dragon', {
      power: '6', toughness: '6',
      oracle_text: "At the beginning of your upkeep, put a number of +1/+1 counters on each other creature you control equal to that creature's toughness.",
    })
    const big = card('Hill Giant', 'Creature — Giant', { power: '3', toughness: '3' })
    const start = ruled([[gargantuan, 'battlefield'], [BEARS, 'battlefield'], [big, 'battlefield'], [FOREST, 'library'], [FOREST, 'library']], { step: 'cleanup' })
    const upkeep = run(start, pass)
    expect(upkeep.stack).toHaveLength(1)
    const done = run(upkeep, pass)
    expect(at(done, 'c1').counters).toEqual({ '+1/+1': 2 })
    expect(at(done, 'c2').counters).toEqual({ '+1/+1': 3 })
    expect(at(done, 'c0').counters).toBeUndefined()
  })

  it('grows a creature by what is in the graveyard too', () => {
    const multani = card('Multani', 'Legendary Creature — Elemental Avatar', {
      power: '0', toughness: '0',
      oracle_text: 'Multani gets +1/+1 for each land you control and each land card in your graveyard.',
    })
    const state = ruled([[multani, 'battlefield'], ...forests, [FOREST, 'graveyard'], [BEARS, 'graveyard']])
    expect(power(at(state, 'c0'), state)).toBe(4)
  })
})
