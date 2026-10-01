import { describe, expect, it } from 'vitest'

import type { Card } from '../lib/api'
import { abilitiesOf, activationProblem, usedFrom } from './activate'
import { costOf } from './cast'
import { compile } from './compiler/compile'
import { reduce } from './reducer'
import { power } from './stats'
import { BEARS, card, FOREST, game, PLAINS, SWAMP } from './testing'
import type { Action, GameState, Instance, Zone } from './types'

const ruled = (placed: [Card, Zone, Partial<Instance>?][], extra: Partial<GameState> = {}) =>
  game(placed, { rules: true, ...extra })
const run = (state: GameState, ...actions: Action[]) => actions.reduce(reduce, state)
const at = (state: GameState, iid: string) => state.cards.find((c) => c.iid === iid)!
const zone = (state: GameState, iid: string) => at(state, iid).zone
const pass: Action = { type: 'pass' }
const cast = (iid: string): Action => ({ type: 'play', iid })
const spell = (name: string, text: string, cost = '{G}', type = 'Sorcery') =>
  card(name, type, { mana_cost: cost, oracle_text: text })
const permanent = (name: string, text: string, type = 'Enchantment', extra: Partial<Card> = {}) =>
  card(name, type, { oracle_text: text, ...extra })
const forests: [Card, Zone][] = [[FOREST, 'battlefield'], [FOREST, 'battlefield'], [FOREST, 'battlefield']]
const library: [Card, Zone][] = [[PLAINS, 'library'], [SWAMP, 'library'], [PLAINS, 'library'], [SWAMP, 'library']]
const island = card('Island', 'Basic Land — Island')
const giant = card('Hill Giant', 'Creature — Giant', { mana_cost: '{3}{R}', cmc: 4, power: '3', toughness: '3' })

describe('abilities used from the graveyard', () => {
  it('returns itself to hand for mana and two lands', () => {
    const multani = permanent('Multani', "Reach, trample\nMultani gets +1/+1 for each land you control and each land card in your graveyard.\n{1}{G}, Return two lands you control to their owner's hand: Return this card from your graveyard to your hand.", 'Legendary Creature — Elemental Avatar', { power: '0', toughness: '0', keywords: ['Reach', 'Trample'] })
    expect(compile(multani).coverage).toBe('auto')
    const [ability] = abilitiesOf({ iid: 'x', card: multani, zone: 'graveyard', tapped: false, x: 0, y: 0 })
    expect(usedFrom(ability)).toBe('graveyard')
    // Not from the battlefield, and not with one land to give back.
    expect(activationProblem(ruled([[multani, 'battlefield'], ...forests]), 'c0', 0)).toMatch(/graveyard/i)
    expect(activationProblem(ruled([[multani, 'graveyard'], [FOREST, 'battlefield']]), 'c0', 0)).toBeTruthy()
    const start = ruled([[multani, 'graveyard'], ...forests, ...library])
    const asked = reduce(start, { type: 'activate', iid: 'c0', index: 0 })
    expect(asked.pending).toMatchObject({ kind: 'pick', options: ['c1', 'c2', 'c3'], min: 2, max: 2 })
    const done = run(asked, { type: 'choose', iids: ['c1', 'c2'] }, pass)
    expect([zone(done, 'c0'), zone(done, 'c1'), zone(done, 'c2'), zone(done, 'c3')]).toEqual(['hand', 'hand', 'hand', 'battlefield'])
  })

  it('exiles itself from the graveyard to make copies for a turn', () => {
    const naga = permanent('Naga Fleshcrafter', 'You may have this creature enter as a copy of any creature on the battlefield.\nRenew — {2}{U}, Exile this card from your graveyard: Put a +1/+1 counter on target nonlegendary creature you control. Each other creature you control becomes a copy of that creature until end of turn. Activate only as a sorcery.', 'Creature — Snake Shapeshifter', { power: '0', toughness: '0' })
    expect(compile(naga).coverage).toBe('auto')
    const king = card('Old King', 'Legendary Creature — Human Noble', { power: '4', toughness: '4' })
    const start = ruled([[naga, 'graveyard'], [island, 'battlefield'], [island, 'battlefield'], [island, 'battlefield'], [BEARS, 'battlefield'], [giant, 'battlefield'], [king, 'battlefield'], ...library])
    const asked = run(start, { type: 'activate', iid: 'c0', index: 0 }, pass)
    expect(zone(asked, 'c0')).toBe('exile')
    // The legend cannot be the one copied.
    expect(asked.pending).toMatchObject({ kind: 'pick', options: ['c4', 'c5'] })
    const done = reduce(asked, { type: 'choose', iids: ['c4'] })
    expect([at(done, 'c5').card.name, at(done, 'c6').card.name]).toEqual(['Grizzly Bears', 'Grizzly Bears'])
    expect(power(at(done, 'c4'), done)).toBe(3)
  })
})

describe('a land that counts its own taps', () => {
  const clocktower = card('Trenzalore Clocktower', 'Legendary Land', {
    oracle_text: '{T}: Add {U}. Put a time counter on Trenzalore Clocktower.\n{1}{U}, {T}, Remove twelve time counters from Trenzalore Clocktower and exile it: Shuffle your graveyard and hand into your library, then draw seven cards. Activate only if you control a Time Lord.',
  })
  const doctor = card('The Doctor', 'Legendary Creature — Time Lord Doctor', { power: '2', toughness: '2' })

  it('gets a time counter whenever it is tapped for mana, by hand or to pay', () => {
    expect(compile(clocktower).coverage).toBe('auto')
    const start = ruled([[clocktower, 'battlefield'], ...library])
    expect(at(reduce(start, { type: 'mana', iid: 'c0' }), 'c0').counters).toMatchObject({ time: 1 })
    const blue = spell('Opt', 'Draw a card.', '{U}', 'Instant')
    const paid = reduce(ruled([[clocktower, 'battlefield'], [blue, 'hand'], ...library]), cast('c1'))
    expect(at(paid, 'c0')).toMatchObject({ tapped: true, counters: { time: 1 } })
  })

  it('trades twelve counters and itself for a new hand, with a Time Lord about', () => {
    const board: [Card, Zone, Partial<Instance>?][] = [
      [clocktower, 'battlefield', { counters: { time: 12 } }], [island, 'battlefield'], [island, 'battlefield'],
      [BEARS, 'hand'], [giant, 'graveyard'], ...library, ...library,
    ]
    expect(activationProblem(ruled(board), 'c0', 0)).toMatch(/time lord/i)
    const start = ruled([...board, [doctor, 'battlefield']])
    const done = run(start, { type: 'activate', iid: 'c0', index: 0 }, pass)
    expect(zone(done, 'c0')).toBe('exile')
    expect(done.cards.filter((c) => c.zone === 'hand')).toHaveLength(7)
    expect(done.cards.filter((c) => c.zone === 'graveyard')).toHaveLength(0)
    expect(done.cards.filter((c) => c.zone === 'library')).toHaveLength(3)
  })
})

describe('the party', () => {
  const cleric = card('Healer', 'Creature — Human Cleric', { power: '1', toughness: '1' })
  const rogue = card('Sneak', 'Creature — Human Rogue', { power: '1', toughness: '1' })
  const warrior = card('Brute', 'Creature — Orc Warrior', { power: '2', toughness: '2' })
  const wizard = card('Sage', 'Creature — Human Wizard', { power: '1', toughness: '1' })
  const everything = card('Mimic', 'Creature — Shapeshifter', { power: '1', toughness: '1', keywords: ['Changeling'] })

  it('makes a spell cheaper for each creature in it', () => {
    const spoils = spell('Spoils of Adventure', 'This spell costs {1} less to cast for each creature in your party. (Your party consists of up to one each of Cleric, Rogue, Warrior, and Wizard.)\nYou gain 3 life and draw three cards.', '{4}{W}{U}', 'Instant')
    expect(compile(spoils).coverage).toBe('auto')
    // Two Clerics are one party member; the changeling is another.
    const state = ruled([[spoils, 'hand'], [cleric, 'battlefield'], [cleric, 'battlefield'], [everything, 'battlefield'], [BEARS, 'battlefield']])
    expect(costOf(state, at(state, 'c0')).generic).toBe(2)
  })

  it('prevents damage to the equipped creature with a full party', () => {
    const baldric = card('Multiclass Baldric', 'Artifact — Equipment', {
      oracle_text: 'Equipped creature has lifelink if you control a Cleric, deathtouch if you control a Rogue, haste if you control a Warrior, and flying if you control a Wizard.\nAs long as you have a full party, prevent all damage that would be dealt to equipped creature.\nEquip {2}',
    })
    expect(compile(baldric).coverage).toBe('auto')
    const bolt = spell('Shock', 'Shock deals 4 damage to target creature.', '{G}', 'Instant')
    const few: [Card, Zone, Partial<Instance>?][] = [[baldric, 'battlefield', { attachedTo: 'c1' }], [cleric, 'battlefield'], [bolt, 'hand'], [FOREST, 'battlefield'], [rogue, 'battlefield'], [warrior, 'battlefield']]
    const hurt = run(ruled(few), cast('c2'), pass, { type: 'choose', iids: ['c1'] })
    expect(zone(hurt, 'c1')).toBe('graveyard')
    const safe = run(ruled([...few, [wizard, 'battlefield']]), cast('c2'), pass, { type: 'choose', iids: ['c1'] })
    expect([zone(safe, 'c1'), at(safe, 'c1').damage ?? 0]).toEqual(['battlefield', 0])
  })

  it('keeps a party and sacrifices the rest', () => {
    const together = spell('Stick Together', 'Each player chooses a party from among creatures they control, then sacrifices the rest. (To choose a party, choose up to one each of Cleric, Rogue, Warrior, and Wizard.)')
    expect(compile(together).coverage).toBe('auto')
    const start = ruled([[together, 'hand'], [FOREST, 'battlefield'], [cleric, 'battlefield'], [cleric, 'battlefield'], [warrior, 'battlefield'], [BEARS, 'battlefield']])
    const asked = run(start, cast('c0'), pass)
    expect(asked.pending).toMatchObject({ kind: 'pick', options: ['c2', 'c3', 'c4'], min: 0, max: 3 })
    // Two Clerics are not a party.
    expect(reduce(asked, { type: 'choose', iids: ['c2', 'c3'] })).toBe(asked)
    const done = reduce(asked, { type: 'choose', iids: ['c2', 'c4'] })
    expect(['c2', 'c3', 'c4', 'c5'].map((iid) => zone(done, iid))).toEqual(['battlefield', 'graveyard', 'battlefield', 'graveyard'])
  })
})
