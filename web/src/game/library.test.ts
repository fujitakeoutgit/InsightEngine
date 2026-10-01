import { describe, expect, it } from 'vitest'

import type { Card } from '../lib/api'
import { compile } from './compiler/compile'
import { readAbility } from './compiler/effects'
import { reduce } from './reducer'
import { BEARS, card, ELVES, FOREST, game, OMENS, PLAINS, SWAMP } from './testing'
import type { Action, GameState, Instance, Zone } from './types'

const ruled = (placed: [Card, Zone, Partial<Instance>?][], extra: Partial<GameState> = {}) =>
  game(placed, { rules: true, ...extra })
const run = (state: GameState, ...actions: Action[]) => actions.reduce(reduce, state)
const at = (state: GameState, iid: string) => state.cards.find((c) => c.iid === iid)!
const zone = (state: GameState, z: Zone) => state.cards.filter((c) => c.zone === z).map((c) => c.iid)
const pass: Action = { type: 'pass' }
const cast = (iid: string): Action => ({ type: 'play', iid })
const spell = (name: string, text: string, cost = '{G}', type = 'Sorcery') =>
  card(name, type, { mana_cost: cost, oracle_text: text })
const forests: [Card, Zone][] = [[FOREST, 'battlefield'], [FOREST, 'battlefield'], [FOREST, 'battlefield']]

describe('looking at the top of your library', () => {
  it('reads how many, what may be taken, and where the rest goes', () => {
    expect(readAbility('Look at the top three cards of your library. You may reveal a Hero card from among them and put it into your hand. Put the rest on the bottom of your library in any order.')).toMatchObject({
      complete: true,
      effects: [{ op: 'dig', count: 3, take: { subtypes: ['Hero'] }, takeCount: 1, upTo: true, to: 'hand', rest: 'bottom' }],
    })
    expect(readAbility('Reveal the top X cards of your library. Put all land cards from among them onto the battlefield tapped and the rest on the bottom of your library in a random order.')).toMatchObject({
      complete: true,
      effects: [{ op: 'dig', count: 'X', take: { types: ['land'] }, takeCount: 'all', to: 'battlefield', tapped: true, rest: 'bottom' }],
    })
    expect(readAbility('Look at the top four cards of your library. Put one of them into your hand and the rest into your graveyard.')).toMatchObject({
      complete: true,
      effects: [{ op: 'dig', count: 4, take: null, takeCount: 1, upTo: false, to: 'hand', rest: 'graveyard' }],
    })
  })

  it('shows what was looked at, and takes only what the card allows', () => {
    const tower = spell('Scout the Halls', 'Look at the top three cards of your library. You may reveal a creature card from among them and put it into your hand. Put the rest on the bottom of your library in any order.')
    const asked = run(ruled([[tower, 'hand'], ...forests, [PLAINS, 'library'], [BEARS, 'library'], [SWAMP, 'library'], [OMENS, 'library']]), cast('c0'), pass)
    expect(asked.pending).toMatchObject({ kind: 'pick', zone: 'library', options: ['c5'], seen: ['c4', 'c6'], min: 0, max: 1 })
    const done = reduce(asked, { type: 'choose', iids: ['c5'] })
    expect(zone(done, 'hand')).toEqual(['c5'])
    // The fourth card is now on top, and the two left over went under it.
    expect(zone(done, 'library')).toEqual(['c7', 'c4', 'c6'])
  })

  it('puts every land among the top X onto the battlefield', () => {
    const awakening = spell("Animist's Awakening", 'Reveal the top X cards of your library. Put all land cards from among them onto the battlefield tapped and the rest on the bottom of your library in a random order.', '{X}{G}')
    const start = ruled([[awakening, 'hand'], ...forests, [PLAINS, 'library'], [BEARS, 'library'], [SWAMP, 'library']])
    const done = run(start, { type: 'play', iid: 'c0', x: 2 }, pass)
    expect(at(done, 'c4')).toMatchObject({ zone: 'battlefield', tapped: true })
    expect(zone(done, 'library')).toEqual(['c6', 'c5'])
    expect(done.pending).toBeNull()
  })

  it('reveals until a creature turns up', () => {
    const atla = card('Egg Tender', 'Creature — Human Shaman', {
      oracle_text: 'Whenever an Egg you control dies, reveal cards from the top of your library until you reveal a creature card. Put that card onto the battlefield and the rest on the bottom of your library in a random order.',
    })
    const egg = card('Egg', 'Creature — Egg', { power: '0', toughness: '1' })
    expect(compile(atla).coverage).toBe('auto')
    const start = ruled([[atla, 'battlefield'], [egg, 'battlefield'], [PLAINS, 'library'], [SWAMP, 'library'], [BEARS, 'library'], [FOREST, 'library']])
    const done = run(start, { type: 'move', iid: 'c1', zone: 'graveyard' }, pass)
    expect(at(done, 'c4').zone).toBe('battlefield')
    expect(zone(done, 'library')[0]).toBe('c5')
    expect(zone(done, 'library').slice(1).sort()).toEqual(['c2', 'c3'])
  })

  it('pays for Foster, then digs for a creature and bins the rest', () => {
    const foster = card('Foster', 'Enchantment', {
      oracle_text: 'Whenever a creature you control dies, you may pay {1}. If you do, reveal cards from the top of your library until you reveal a creature card. Put that card into your hand and the rest into your graveyard.',
    })
    expect(compile(foster).coverage).toBe('auto')
    const start = ruled([[foster, 'battlefield'], [BEARS, 'battlefield'], [FOREST, 'battlefield'], [PLAINS, 'library'], [OMENS, 'library'], [SWAMP, 'library']])
    const asked = run(start, { type: 'move', iid: 'c1', zone: 'graveyard' }, pass)
    expect(asked.pending).toMatchObject({ kind: 'confirm' })
    const done = reduce(asked, { type: 'confirm', yes: true })
    expect(zone(done, 'hand')).toEqual(['c4'])
    expect(zone(done, 'graveyard').sort()).toEqual(['c1', 'c3'])
    expect(at(done, 'c2').tapped).toBe(true)
  })
})

describe('the top card', () => {
  const beast = card('Parcelbeast', 'Creature — Elemental Beast', {
    power: '2', toughness: '4',
    oracle_text: "{1}, {T}: Look at the top card of your library. If it's a land card, you may put it onto the battlefield. If you don't put the card onto the battlefield, put it into your hand.",
  })

  it('offers a land for the battlefield, and takes anything else into hand', () => {
    expect(compile(beast).activated[0]).toMatchObject({
      complete: true,
      effects: [{ op: 'topCard', match: { types: ['land'] }, hit: 'battlefield', ask: true, miss: 'hand' }],
    })
    const land = run(ruled([[beast, 'battlefield'], [FOREST, 'battlefield'], [PLAINS, 'library']]), { type: 'activate', iid: 'c0', index: 0 }, pass)
    expect(land.pending).toMatchObject({ kind: 'confirm' })
    expect(at(reduce(land, { type: 'confirm', yes: true }), 'c2').zone).toBe('battlefield')
    expect(at(reduce(land, { type: 'confirm', yes: false }), 'c2').zone).toBe('hand')
    const other = run(ruled([[beast, 'battlefield'], [FOREST, 'battlefield'], [BEARS, 'library']]), { type: 'activate', iid: 'c0', index: 0 }, pass)
    expect(at(other, 'c2').zone).toBe('hand')
  })

  it('asks a second time where a card that is not kept may go', () => {
    const ascendancy = card('Cabaretti Ascendancy', 'Enchantment', {
      oracle_text: "At the beginning of your upkeep, look at the top card of your library. If it's a creature or planeswalker card, you may reveal it and put it into your hand. If you don't put the card into your hand, you may put it on the bottom of your library.",
    })
    expect(compile(ascendancy).coverage).toBe('auto')
    const start = ruled([[ascendancy, 'battlefield'], [PLAINS, 'library'], [BEARS, 'library'], [FOREST, 'library']], { step: 'cleanup' })
    const asked = run(start, pass, pass)
    // A land: not one it may keep, so only the second question is asked.
    expect(asked.pending).toMatchObject({ kind: 'confirm', prompt: expect.stringContaining('bottom') })
    const done = reduce(asked, { type: 'confirm', yes: true })
    expect(zone(done, 'library')).toEqual(['c2', 'c3', 'c1'])
  })
})

describe('putting cards back', () => {
  it('draws three and puts two back, the first chosen on top', () => {
    const brainstorm = spell('Brainstorm', 'Draw three cards, then put two cards from your hand on top of your library in any order.', '{G}', 'Instant')
    expect(compile(brainstorm).coverage).toBe('auto')
    const asked = run(ruled([[brainstorm, 'hand'], ...forests, [PLAINS, 'library'], [BEARS, 'library'], [SWAMP, 'library'], [ELVES, 'library']]), cast('c0'), pass)
    expect(asked.pending).toMatchObject({ kind: 'pick', zone: 'hand', min: 2, max: 2 })
    const done = reduce(asked, { type: 'choose', iids: ['c6', 'c4'] })
    expect(zone(done, 'library')).toEqual(['c6', 'c4', 'c7'])
    expect(zone(done, 'hand')).toEqual(['c5'])
  })
})
