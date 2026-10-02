import { describe, expect, it } from 'vitest'

import type { Card } from '../lib/api'
import { compile } from './compiler/compile'
import { reduce } from './reducer'
import { BEARS, card, FOREST, game, OMENS, PLAINS, SWAMP } from './testing'
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
const permanent = (name: string, text: string, type = 'Enchantment', extra: Partial<Card> = {}) =>
  card(name, type, { oracle_text: text, ...extra })
const forests: [Card, Zone][] = [[FOREST, 'battlefield'], [FOREST, 'battlefield'], [FOREST, 'battlefield']]
const library: [Card, Zone][] = [[PLAINS, 'library'], [SWAMP, 'library'], [BEARS, 'library'], [OMENS, 'library'], [FOREST, 'library']]

describe('drawing', () => {
  it('triggers once for each card drawn', () => {
    const skulker = permanent('Chasm Skulker', 'Whenever you draw a card, put a +1/+1 counter on Chasm Skulker.', 'Creature — Squid Horror', { power: '1', toughness: '1' })
    expect(compile(skulker).coverage).toBe('auto')
    const divination = spell('Divination', 'Draw two cards.')
    const drew = run(ruled([[divination, 'hand'], ...forests, [skulker, 'battlefield'], ...library]), cast('c0'), pass)
    expect(drew.stack).toHaveLength(2)
    expect(at(run(drew, pass, pass), 'c4').counters).toEqual({ '+1/+1': 2 })
  })

  it('counts the second card of the turn', () => {
    const kang = permanent('Kang', 'Whenever you draw your second card each turn, each opponent loses 1 life and you gain 1 life.', 'Legendary Creature — Human Villain')
    const one = spell('Opt', 'Draw a card.', '{G}', 'Instant')
    const start = ruled([[one, 'hand'], [one, 'hand'], [one, 'hand'], ...forests, [kang, 'battlefield'], ...library])
    const first = run(start, cast('c0'), pass)
    expect(first.stack).toEqual([])
    const second = run(first, cast('c1'), pass)
    expect(second.stack).toHaveLength(1)
    const third = run(second, pass, cast('c2'), pass)
    expect(third.stack).toEqual([])
    expect(third.opponent.life).toBe(39)
    expect(third.tally.drawn).toBe(3)
  })

  it('starts counting again each turn', () => {
    const start = ruled([...library], { step: 'cleanup', tally: { drawn: 5, discarded: 0, died: 0, left: 0, binned: 0, gained: 0, lost: 0, struck: 0 } })
    const next = run(start, pass)
    // The new turn's draw step, and nothing before it.
    expect(next.tally.drawn).toBe(1)
  })

  it('draws two instead with Teferi\'s Ageless Insight, except for the draw step', () => {
    const insight = permanent('Ageless Insight', 'If you would draw a card except the first one you draw in each of your draw steps, draw two cards instead.', 'Legendary Enchantment')
    expect(compile(insight).coverage).toBe('auto')
    const one = spell('Opt', 'Draw a card.', '{G}', 'Instant')
    const drew = run(ruled([[one, 'hand'], ...forests, [insight, 'battlefield'], ...library]), cast('c0'), pass)
    expect(zone(drew, 'hand')).toHaveLength(2)
    const turn = run(ruled([[insight, 'battlefield'], ...library], { step: 'cleanup' }), pass)
    expect(zone(turn, 'hand')).toHaveLength(1)
  })
})

describe('discarding', () => {
  const haven = permanent('Drake Haven', 'Whenever you cycle or discard a card, you may pay {1}. If you do, create a 2/2 blue Drake creature token with flying.')

  it('is seen when a card goes from hand to graveyard', () => {
    expect(compile(haven).coverage).toBe('auto')
    const rummage = spell('Rummage', 'Draw a card, then discard a card.')
    const asked = run(ruled([[rummage, 'hand'], ...forests, [haven, 'battlefield'], [BEARS, 'hand'], ...library]), cast('c0'), pass)
    expect(asked.pending).toMatchObject({ kind: 'pick', zone: 'hand' })
    const discarded = reduce(asked, { type: 'choose', iids: ['c5'] })
    expect(discarded.stack).toHaveLength(1)
    expect(discarded.tally.discarded).toBe(1)
    const paid = run(discarded, pass, { type: 'confirm', yes: true })
    expect(paid.cards.filter((c) => c.token).map((c) => c.card.name)).toEqual(['Drake'])
  })

  it('is seen when a card is cycled', () => {
    const cycler = card('Cycler', 'Creature — Beast', { mana_cost: '{4}{G}', oracle_text: 'Cycling {G}' })
    const cycled = run(ruled([[cycler, 'hand'], ...forests, [haven, 'battlefield'], ...library]), { type: 'activate', iid: 'c0', index: 0 })
    // The cycling draw and Drake Haven's trigger, both waiting.
    expect(cycled.stack).toHaveLength(2)
  })

  it('answers once to several lands discarded together', () => {
    const doom = permanent('Doom', 'Whenever you discard one or more land cards, each opponent loses 2 life.', 'Legendary Creature — Human Villain')
    expect(compile(doom).triggers[0]).toMatchObject({ when: { on: 'discard', filter: { types: ['land'] } }, batch: true })
    const purge = spell('Purge', 'Discard two cards.')
    const asked = run(ruled([[purge, 'hand'], ...forests, [doom, 'battlefield'], [PLAINS, 'hand'], [SWAMP, 'hand']]), cast('c0'), pass)
    const done = run(asked, { type: 'choose', iids: ['c5', 'c6'] })
    expect(done.stack).toHaveLength(1)
  })
})

describe('tapping', () => {
  it('sets off "whenever ~ becomes tapped", however it was tapped', () => {
    const sage = permanent('Fallowsage', 'Whenever Fallowsage becomes tapped, you may draw a card.', 'Creature — Merfolk Wizard', { power: '2', toughness: '2' })
    expect(compile(sage).coverage).toBe('auto')
    const tapped = run(ruled([[sage, 'battlefield'], ...library]), { type: 'tap', iid: 'c0' })
    expect(tapped.stack).toHaveLength(1)
    // Untapping it is not the same thing.
    expect(run(tapped, pass, { type: 'confirm', yes: false }, { type: 'tap', iid: 'c0' }).stack).toEqual([])
  })

  it('sets off "becomes untapped" in the untap step', () => {
    const tui = permanent('Tui and La', 'Whenever Tui and La become untapped, put a +1/+1 counter on them.', 'Legendary Creature — Fish Spirit', { power: '3', toughness: '3' })
    expect(compile(tui).coverage).toBe('auto')
    const start = ruled([[tui, 'battlefield', { tapped: true }], ...library], { step: 'cleanup' })
    const next = run(start, pass)
    expect(next.stack).toHaveLength(1)
    expect(at(run(next, pass), 'c0').counters).toEqual({ '+1/+1': 1 })
  })
})

describe('scrying', () => {
  it('sets off "whenever you scry or surveil"', () => {
    const matoya = permanent('Matoya', 'Whenever you scry or surveil, draw a card.', 'Legendary Creature — Human Warlock')
    const opt = spell('Preordain', 'Scry 2.')
    const asked = run(ruled([[opt, 'hand'], ...forests, [matoya, 'battlefield'], ...library]), cast('c0'), pass)
    const done = reduce(asked, { type: 'arrange', keep: ['c5', 'c6'], away: [] })
    expect(done.stack).toHaveLength(1)
  })
})

describe('conniving', () => {
  const schemer = permanent('Schemer', '{T}: Target creature you control connives.', 'Creature — Human Villain', { power: '1', toughness: '1' })

  it('draws, discards, and grows the creature for a nonland card', () => {
    const asked = run(ruled([[schemer, 'battlefield'], [BEARS, 'battlefield'], [OMENS, 'hand'], ...library]),
      { type: 'activate', iid: 'c0', index: 0 }, pass, { type: 'choose', iids: ['c1'] })
    // A card was drawn, and one must be discarded.
    expect(asked.pending).toMatchObject({ kind: 'pick', zone: 'hand', min: 1, max: 1 })
    expect(zone(asked, 'hand')).toEqual(['c2', 'c3'])
    const kept = reduce(asked, { type: 'choose', iids: ['c2'] })
    expect(at(kept, 'c1').counters).toEqual({ '+1/+1': 1 })
    const land = reduce(asked, { type: 'choose', iids: ['c3'] })
    expect(at(land, 'c1').counters).toBeUndefined()
  })

  it('sets off abilities that watch for it', () => {
    const monger = permanent('Iron Monger', 'Whenever a creature you control connives, put a +1/+1 counter on each Villain you control.', 'Legendary Artifact Creature — Human Villain', { power: '3', toughness: '3' })
    expect(compile(monger).coverage).toBe('auto')
    const start = ruled([[schemer, 'battlefield'], [monger, 'battlefield'], [OMENS, 'hand'], ...library])
    const done = run(start, { type: 'activate', iid: 'c0', index: 0 }, pass, { type: 'choose', iids: ['c0'] }, { type: 'choose', iids: ['c3'] })
    expect(done.stack).toHaveLength(1)
    const grown = run(done, pass)
    expect(at(grown, 'c0').counters).toEqual({ '+1/+1': 1 })
    expect(at(grown, 'c1').counters).toEqual({ '+1/+1': 1 })
  })
})

describe('what has happened this turn', () => {
  it('counts the creatures that died, for Fresh Meat', () => {
    const meat = spell('Fresh Meat', 'Create a 3/3 green Beast creature token for each creature put into your graveyard from the battlefield this turn.', '{G}', 'Instant')
    expect(compile(meat).coverage).toBe('auto')
    const start = ruled([[meat, 'hand'], ...forests, [BEARS, 'battlefield'], [BEARS, 'battlefield']])
    const done = run(start, { type: 'move', iid: 'c4', zone: 'graveyard' }, { type: 'move', iid: 'c5', zone: 'graveyard' }, cast('c0'), pass)
    expect(done.tally.died).toBe(2)
    expect(done.cards.filter((c) => c.token)).toHaveLength(2)
  })

  it('checks revolt', () => {
    const rallier = card('Renegade Rallier', 'Creature — Human Warrior', {
      mana_cost: '{G}', power: '3', toughness: '2',
      oracle_text: 'Revolt — When Renegade Rallier enters, if a permanent left the battlefield under your control this turn, return target permanent card with mana value 2 or less from your graveyard to the battlefield.',
    })
    expect(compile(rallier).coverage).toBe('auto')
    const quiet = run(ruled([[rallier, 'hand'], ...forests, [BEARS, 'graveyard']]), cast('c0'), pass)
    expect(quiet.stack).toEqual([])
    const start = ruled([[rallier, 'hand'], ...forests, [BEARS, 'battlefield']])
    const revolted = run(start, { type: 'move', iid: 'c4', zone: 'graveyard' }, cast('c0'), pass)
    expect(revolted.stack).toHaveLength(1)
    const asked = run(revolted, pass)
    expect(asked.pending).toMatchObject({ kind: 'pick', zone: 'graveyard', options: ['c4'] })
  })

  it('lets a Background give its ability to your commander', () => {
    const hermit = permanent('Cloakwood Hermit', 'Commander creatures you own have "At the beginning of your end step, if a creature card was put into your graveyard from anywhere this turn, create two tapped 1/1 green Squirrel creature tokens."', 'Legendary Enchantment — Background')
    expect(compile(hermit).coverage).toBe('auto')
    const commander = card('Minsc', 'Legendary Creature — Human Ranger', { power: '3', toughness: '3' })
    const start = ruled([[hermit, 'battlefield'], [commander, 'battlefield', { commander: true }], [BEARS, 'battlefield'], ...library], { step: 'main2' })
    const nothing = run(start, pass)
    expect(nothing.cards.filter((c) => c.token)).toHaveLength(0)
    const died = run(start, { type: 'move', iid: 'c2', zone: 'graveyard' }, pass)
    expect(died.stack).toHaveLength(1)
    expect(run(died, pass).cards.filter((c) => c.token).map((c) => c.tapped)).toEqual([true, true])
  })

  it('counts life gained', () => {
    const start = ruled([[spell('Healing Salve', 'You gain 3 life.', '{G}', 'Instant'), 'hand'], ...forests])
    expect(run(start, cast('c0'), pass).tally.gained).toBe(3)
  })
})
