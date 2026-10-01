import { describe, expect, it } from 'vitest'

import type { Card } from '../lib/api'
import { compile } from './compiler/compile'
import { readAbility, sentences } from './compiler/effects'
import { reduce } from './reducer'
import { BEARS, card, FOREST, game, PLAINS, SWAMP } from './testing'
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

describe('splitting an ability into sentences', () => {
  it('ends a sentence at a full stop, and at one inside closing quotes', () => {
    expect(sentences('Draw a card. You gain 1 life.')).toEqual(['Draw a card.', 'You gain 1 life.'])
    expect(sentences('Create a 1/1 red Satyr creature token with "This token can\'t block." If it rains, stay in.')).toEqual([
      'Create a 1/1 red Satyr creature token with "This token can\'t block."', 'If it rains, stay in.',
    ])
  })

  it('leaves what a token says in one piece', () => {
    expect(sentences('Create a Clue token. It has "{2}: Draw a card. Activate only as a sorcery."')).toEqual([
      'Create a Clue token.', 'It has "{2}: Draw a card. Activate only as a sorcery."',
    ])
  })
})

describe('"instead"', () => {
  it('reads the replacement as a choice between two outcomes', () => {
    const hydra = readAbility('Put a +1/+1 counter on ~. If that land is a Forest, put two +1/+1 counters on ~ instead.')
    expect(hydra).toMatchObject({
      complete: true,
      effects: [{
        op: 'if',
        test: { is: { subtypes: ['Forest'] }, of: 'event' },
        then: [{ op: 'counters', count: 2 }],
        otherwise: [{ op: 'counters', count: 1 }],
      }],
    })
  })

  it('gives Oran-Rief Hydra two counters for a Forest and one for anything else', () => {
    const hydra = card('Oran-Rief Hydra', 'Creature — Hydra', {
      power: '5', toughness: '5',
      oracle_text: 'Trample\nLandfall — Whenever a land you control enters, put a +1/+1 counter on Oran-Rief Hydra. If that land is a Forest, put two +1/+1 counters on Oran-Rief Hydra instead.',
    })
    expect(compile(hydra).coverage).toBe('auto')
    const start = ruled([[hydra, 'battlefield'], [FOREST, 'hand'], [PLAINS, 'hand']], { extraLands: 1 })
    const forest = run(start, cast('c1'), pass)
    expect(at(forest, 'c0').counters).toEqual({ '+1/+1': 2 })
    const plains = run(forest, cast('c2'), pass)
    expect(at(plains, 'c0').counters).toEqual({ '+1/+1': 3 })
  })

  it('makes two of Anax\'s Satyrs for a big creature, with what they say', () => {
    const anax = card('Anax', 'Legendary Enchantment Creature — Demigod', {
      power: '0', toughness: '3',
      oracle_text: 'Whenever Anax or another nontoken creature you control dies, create a 1/1 red Satyr creature token with "This token can\'t block." If the creature had power 4 or greater, create two of those tokens instead.',
    })
    const giant = card('Hill Giant', 'Creature — Giant', { power: '4', toughness: '3' })
    expect(compile(anax).triggers.every((t) => t.complete)).toBe(true)
    const start = ruled([[anax, 'battlefield'], [BEARS, 'battlefield'], [giant, 'battlefield']])
    const small = run(start, { type: 'move', iid: 'c1', zone: 'graveyard' }, pass)
    expect(small.cards.filter((c) => c.token)).toHaveLength(1)
    expect(small.cards.find((c) => c.token)!.card.oracle_text).toBe("Satyr can't block.")
    const big = run(small, { type: 'move', iid: 'c2', zone: 'graveyard' }, pass)
    expect(big.cards.filter((c) => c.token)).toHaveLength(3)
  })

  it('reads threshold across the two lines of Far Wanderings', () => {
    const wanderings = spell('Far Wanderings', 'Search your library for a basic land card, put that card onto the battlefield tapped, then shuffle.\nThreshold — If there are seven or more cards in your graveyard, instead search your library for up to three basic land cards, put them onto the battlefield tapped, then shuffle.')
    expect(compile(wanderings)).toMatchObject({ coverage: 'auto', spell: { complete: true } })
    const library: [Card, Zone][] = [[PLAINS, 'library'], [SWAMP, 'library'], [FOREST, 'library']]
    const few = run(ruled([[wanderings, 'hand'], ...forests, ...library]), cast('c0'), pass)
    expect(few.pending).toMatchObject({ kind: 'pick', max: 1 })
    const graveyard: [Card, Zone][] = Array.from({ length: 7 }, () => [BEARS, 'graveyard'])
    const many = run(ruled([[wanderings, 'hand'], ...forests, ...library, ...graveyard]), cast('c0'), pass)
    expect(many.pending).toMatchObject({ kind: 'pick', max: 3 })
  })
})

describe('a trigger with a condition', () => {
  it('checks what the card says before it triggers', () => {
    const sentinel = card('Bird Watcher', 'Creature — Human', {
      oracle_text: 'When Bird Watcher enters, if you control a Bird, draw a card.',
      mana_cost: '{G}',
    })
    expect(compile(sentinel).triggers[0]).toMatchObject({ condition: { control: { subtypes: ['Bird'], controller: 'you' }, atLeast: 1 } })
    const none = run(ruled([[sentinel, 'hand'], ...forests, [BEARS, 'library']]), cast('c0'), pass)
    expect(none.stack).toEqual([])
    const bird = card('Storm Crow', 'Creature — Bird')
    const one = run(ruled([[sentinel, 'hand'], ...forests, [BEARS, 'library'], [bird, 'battlefield']]), cast('c0'), pass)
    expect(one.stack).toHaveLength(1)
  })
})

describe('modes on an ability', () => {
  const cankerbloom = card('Cankerbloom', 'Creature — Phyrexian Fungus', {
    power: '3', toughness: '2',
    oracle_text: '{1}, Sacrifice Cankerbloom: Choose one —\n• Destroy target artifact.\n• Destroy target enchantment.\n• Draw a card.',
  })

  it('reads the bullets under an activated ability', () => {
    const compiled = compile(cankerbloom)
    expect(compiled.coverage).toBe('auto')
    expect(compiled.activated).toHaveLength(1)
    expect(compiled.activated[0]).toMatchObject({
      cost: { mana: '{1}', sacrificeSelf: true },
      effects: [{ op: 'mode', min: 1, max: 1, modes: [{}, {}, { effects: [{ op: 'draw', count: 1 }] }] }],
    })
  })

  it('asks which, as the ability resolves', () => {
    const asked = run(ruled([[cankerbloom, 'battlefield'], ...forests, [BEARS, 'library']]), { type: 'activate', iid: 'c0', index: 0 }, pass)
    expect(asked.pending).toMatchObject({ kind: 'mode', modes: ['Destroy target artifact.', 'Destroy target enchantment.', 'Draw a card.'] })
    const done = reduce(asked, { type: 'mode', index: 2 })
    expect(zone(done, 'hand').map((c) => c.iid)).toEqual(['c4'])
  })

  it('reads the bullets under a trigger', () => {
    const hydra = card('Voracious Hydra', 'Creature — Hydra', {
      oracle_text: 'When Voracious Hydra enters, choose one —\n• Draw a card.\n• Voracious Hydra fights target creature you don\'t control.',
    })
    expect(compile(hydra).triggers[0]).toMatchObject({
      when: { on: 'enters', who: 'self' },
      effects: [{ op: 'mode', modes: [{ effects: [{ op: 'draw' }] }, { effects: [{ op: 'nothing' }] }] }],
      complete: true,
    })
  })

  it('takes one or more, in the order printed, until you say done', () => {
    const connections = card('Black Market Connections', 'Enchantment', {
      oracle_text: 'At the beginning of your first main phase, choose one or more —\n• Sell Contraband — Create a Treasure token. You lose 1 life.\n• Buy Information — Draw a card. You lose 2 life.\n• Hire a Mercenary — Create a 3/2 colorless Shapeshifter creature token with changeling. You lose 3 life.',
    })
    expect(compile(connections).coverage).toBe('auto')
    const start = ruled([[connections, 'battlefield'], [BEARS, 'library'], [FOREST, 'library'], [FOREST, 'library']], { step: 'draw', turn: 2 })
    const main = run(start, pass)
    expect(main.step).toBe('main1')
    expect(main.stack).toHaveLength(1)
    const asked = run(main, pass)
    expect(asked.pending).toMatchObject({ kind: 'mode', taken: [], canStop: false })
    const one = reduce(asked, { type: 'mode', index: 1 })
    expect(one.pending).toMatchObject({ kind: 'mode', taken: [1], canStop: true })
    const two = reduce(one, { type: 'mode', index: 0 })
    const done = reduce(two, { type: 'mode', index: -1 })
    expect(done.pending).toBeNull()
    // A Treasure and 1 life, then a card and 2 life.
    expect(done.life).toBe(37)
    expect(done.cards.filter((c) => c.token).map((c) => c.card.name)).toEqual(['Treasure'])
    expect(zone(done, 'hand')).toHaveLength(1)
  })
})

describe('counters that multiply', () => {
  const walker = card('Ajani', 'Legendary Planeswalker — Ajani', { loyalty: '4' })

  it('proliferates everything of yours that has a counter, and their poison', () => {
    const steady = spell('Steady Progress', 'Proliferate.\nDraw a card.', '{G}', 'Instant')
    const start = ruled([
      [steady, 'hand'], ...forests, [BEARS, 'battlefield', { counters: { '+1/+1': 2 } }],
      [walker, 'battlefield', { loyalty: 4 }], [SWAMP, 'battlefield'], [PLAINS, 'library'],
    ], { opponent: { life: 40, poison: 3, commander: {} } })
    const done = run(start, cast('c0'), pass)
    expect(at(done, 'c4').counters).toEqual({ '+1/+1': 3 })
    expect(at(done, 'c5').loyalty).toBe(5)
    expect(at(done, 'c6').counters).toBeUndefined()
    expect(done.opponent.poison).toBe(4)
    expect(zone(done, 'hand')).toHaveLength(1)
  })

  it('doubles the counters on a creature', () => {
    const doubling = card('Doubling Hydra', 'Creature — Hydra', {
      power: '0', toughness: '1', mana_cost: '{G}',
      oracle_text: 'Doubling Hydra enters with three +1/+1 counters on it.\nWhen Doubling Hydra enters, double the number of +1/+1 counters on Doubling Hydra.',
    })
    const entered = run(ruled([[doubling, 'hand'], ...forests]), cast('c0'), pass)
    expect(at(entered, 'c0').counters).toEqual({ '+1/+1': 3 })
    expect(entered.stack).toHaveLength(1)
    expect(at(run(entered, pass), 'c0').counters).toEqual({ '+1/+1': 6 })
  })
})

describe('an additional cost', () => {
  it('is paid as the spell resolves', () => {
    const harrow = spell('Harrow', 'As an additional cost to cast this spell, sacrifice a land.\nSearch your library for up to two basic land cards, put them onto the battlefield, then shuffle.', '{G}', 'Instant')
    expect(compile(harrow).coverage).toBe('auto')
    const start = ruled([[harrow, 'hand'], [FOREST, 'battlefield'], [PLAINS, 'library'], [SWAMP, 'library']])
    const asked = run(start, cast('c0'), pass)
    // One land, so it is the one sacrificed; then the search.
    expect(at(asked, 'c1').zone).toBe('graveyard')
    expect(asked.pending).toMatchObject({ kind: 'pick', zone: 'library', max: 2 })
  })
})
