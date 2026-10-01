import { describe, expect, it } from 'vitest'

import type { Card } from '../lib/api'
import { compile } from './compiler/compile'
import { reduce } from './reducer'
import { BEARS, card, FOREST, game, PLAINS, SWAMP } from './testing'
import type { Action, GameState, Instance, Zone } from './types'

const ruled = (placed: [Card, Zone, Partial<Instance>?][], extra: Partial<GameState> = {}) =>
  game(placed, { rules: true, ...extra })
const run = (state: GameState, ...actions: Action[]) => actions.reduce(reduce, state)
const at = (state: GameState, iid: string) => state.cards.find((c) => c.iid === iid)!
const zone = (state: GameState, iid: string) => at(state, iid).zone
const hand = (state: GameState) => state.cards.filter((c) => c.zone === 'hand').map((c) => c.iid)
const tokens = (state: GameState) => state.cards.filter((c) => c.token)
const pass: Action = { type: 'pass' }
const yes: Action = { type: 'confirm', yes: true }
const cast = (iid: string): Action => ({ type: 'play', iid })
const spell = (name: string, text: string, cost = '{G}', type = 'Sorcery') =>
  card(name, type, { mana_cost: cost, oracle_text: text })
const permanent = (name: string, text: string, type = 'Enchantment', extra: Partial<Card> = {}) =>
  card(name, type, { oracle_text: text, ...extra })
const library: [Card, Zone][] = [[PLAINS, 'library'], [SWAMP, 'library'], [PLAINS, 'library'], [SWAMP, 'library']]
/** On to the given step, attacking with nothing if the game asks. */
const onTo = (state: GameState, step: 'end' | 'upkeep' | 'main1' | 'main2') => {
  const asked = reduce(state, { type: 'passTo', step })
  return asked.pending?.kind === 'attack' ? run(asked, { type: 'attack', iids: [] }, { type: 'passTo', step }) : asked
}
const giant = card('Hill Giant', 'Creature — Giant', { mana_cost: '{3}{R}', cmc: 4, power: '3', toughness: '3' })

describe('a second beginning', () => {
  it('untaps, has an upkeep and draws again after the second main phase', () => {
    const sphinx = permanent('Sphinx of the Second Sun', 'Flying\nAt the beginning of each of your postcombat main phases, there is an additional beginning phase after this phase. (The beginning phase includes the untap, upkeep, and draw steps.)', 'Creature — Sphinx', { power: '6', toughness: '6', keywords: ['Flying'] })
    const clock = permanent('Clock', 'At the beginning of your upkeep, you gain 1 life.', 'Artifact')
    expect(compile(sphinx).coverage).toBe('auto')
    const start = ruled([[sphinx, 'battlefield'], [clock, 'battlefield'], [FOREST, 'battlefield', { tapped: true }], [FOREST, 'hand'], ...library, ...library])
    const landed = reduce(start, cast('c3'))
    // Through combat with nothing attacking, to the second main phase,
    // where the Sphinx's ability resolves.
    const second = run(reduce(landed, { type: 'passTo', step: 'main2' }), { type: 'attack', iids: [] }, pass)
    expect([second.step, second.extraBeginnings]).toEqual(['main2', 1])
    const end = onTo(second, 'end')
    expect(end.turn).toBe(start.turn)
    expect(at(end, 'c2').tapped).toBe(false)
    expect(end.life).toBe(41)
    expect(hand(end)).toHaveLength(1)
    // …and the land for the turn has still been played.
    expect(end.landsPlayed).toBe(1)
    // The next turn has only the one it should.
    const next = onTo(end, 'main1')
    expect([next.turn, next.life]).toEqual([start.turn + 1, 42])
  })
})

describe('a miracle for nothing', () => {
  it('offers the first card drawn each turn, if it is not a land', () => {
    const man = permanent('Molecule Man', 'Nonland cards in your hand have miracle {0}. (You may cast a card for its miracle cost when you draw it if it\'s the first card you drew this turn.)', 'Legendary Creature — Human Villain', { power: '5', toughness: '5' })
    expect(compile(man).coverage).toBe('auto')
    const start = ruled([[man, 'battlefield'], [giant, 'library'], [BEARS, 'library'], ...library])
    const drawn = run(onTo(start, 'main1'), pass)
    expect(drawn.pending).toMatchObject({ kind: 'confirm' })
    const cast1 = run(drawn, yes, pass)
    expect(zone(cast1, 'c1')).toBe('battlefield')
    // A second card the same turn is no miracle.
    const again = run(cast1, { type: 'draw' })
    expect(again.stack).toHaveLength(0)
    expect(zone(again, 'c2')).toBe('hand')
    // A land is not offered.
    const land = onTo(ruled([[man, 'battlefield'], [FOREST, 'library'], ...library]), 'main1')
    expect([land.pending, land.stack.length]).toEqual([null, 0])
  })
})

describe('modes that are paid for', () => {
  const weaving = spell('Season of Weaving', "Choose up to five {P} worth of modes. You may choose the same mode more than once.\n{P} — Draw a card.\n{P}{P} — Choose an artifact or creature you control. Create a token that's a copy of it.\n{P}{P}{P} — Return each nonland, nontoken permanent to its owner's hand.")

  it('takes modes up to five in all, the same one more than once', () => {
    expect(compile(weaving).coverage).toBe('auto')
    const start = ruled([[weaving, 'hand'], [FOREST, 'battlefield'], [BEARS, 'battlefield'], ...library, ...library])
    const asked = run(start, cast('c0'), pass)
    expect(asked.pending).toMatchObject({ kind: 'mode', repeat: true, left: 5, costs: [1, 2, 3], canStop: true })
    // A copy (two), then three cards (one each): that is the five.
    const picked = run(asked, { type: 'mode', index: 1 }, { type: 'mode', index: 0 }, { type: 'mode', index: 0 })
    expect(picked.pending).toMatchObject({ kind: 'mode', left: 1, taken: [1, 0, 0] })
    const done = run(picked, { type: 'mode', index: 0 })
    // In printed order: the draws first, then the copy.
    expect(hand(done)).toHaveLength(3)
    expect(tokens(done).map((c) => c.card.name)).toEqual(['Grizzly Bears'])
  })

  it('refuses a mode there is not enough left for, and may stop early', () => {
    const start = ruled([[weaving, 'hand'], [FOREST, 'battlefield'], [BEARS, 'battlefield'], ...library, ...library])
    const asked = run(start, cast('c0'), pass, { type: 'mode', index: 2 })
    expect(asked.pending).toMatchObject({ left: 2 })
    expect(reduce(asked, { type: 'mode', index: 2 })).toBe(asked)
    const done = run(asked, { type: 'mode', index: -1 })
    expect([zone(done, 'c2'), done.pending]).toEqual(['hand', null])
  })
})

describe('draws that look for a kind of card', () => {
  const abundance = permanent('Abundance', 'If you would draw a card, you may instead choose land or nonland and reveal cards from the top of your library until you reveal a card of the chosen kind. Put that card into your hand and put all other cards revealed this way on the bottom of your library in any order.', 'Enchantment', { mana_cost: '{G}' })

  it('asks what draws should find, and finds it', () => {
    expect(compile(abundance).coverage).toBe('auto')
    const start = ruled([[abundance, 'hand'], [FOREST, 'battlefield'], [PLAINS, 'library'], [SWAMP, 'library'], [giant, 'library'], [FOREST, 'library']])
    const asked = run(start, cast('c0'), pass)
    expect(asked.pending).toMatchObject({ kind: 'type', iid: 'c0', side: true, options: ['Land', 'Nonland', 'As usual'] })
    const nonland = run(asked, { type: 'pickType', subtype: 'Nonland' })
    const drew = reduce(nonland, { type: 'draw' })
    expect(hand(drew)).toEqual(['c4'])
    // The lands on top of it went to the bottom.
    expect(drew.cards.filter((c) => c.zone === 'library').map((c) => c.iid)).toEqual(['c5', 'c2', 'c3'])
    // That was not a draw, as far as anything counting them goes.
    expect(drew.tally.drawn).toBe(0)
  })

  it('draws as usual when that is the choice, and can be asked again', () => {
    const start = ruled([[abundance, 'battlefield', { chosenMode: 'As usual' }], [PLAINS, 'library'], [giant, 'library'], ...library])
    expect(hand(reduce(start, { type: 'draw' }))).toEqual(['c1'])
    const again = run(start, { type: 'activate', iid: 'c0', index: 0 }, pass)
    expect(again.pending).toMatchObject({ kind: 'type', side: true })
    const land = run(again, { type: 'pickType', subtype: 'Land' }, { type: 'draw' }, { type: 'draw' })
    expect(hand(land)).toEqual(['c1', 'c3'])
  })
})

describe('a clone that keeps its name', () => {
  it('enters as a copy, named as itself', () => {
    const chameleon = permanent('Chameleon', 'You may have Chameleon enter as a copy of a creature you control, except his name is Chameleon.', 'Legendary Creature — Human Villain', { mana_cost: '{G}', power: '2', toughness: '2' })
    const start = ruled([[chameleon, 'hand'], [FOREST, 'battlefield'], [giant, 'battlefield'], ...library])
    const done = run(start, cast('c0'), pass, { type: 'choose', iids: ['c2'] })
    expect(at(done, 'c0').card).toMatchObject({ name: 'Chameleon', power: '3', type_line: 'Creature — Giant' })
  })
})
