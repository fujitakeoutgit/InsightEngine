import { describe, expect, it } from 'vitest'

import type { Card } from '../lib/api'
import { compile } from './compiler/compile'
import { reduce } from './reducer'
import { hasKeyword, power, toughness } from './stats'
import { BEARS, card, ELVES, FOREST, game, GROWTH, PLAINS, SWAMP } from './testing'
import type { Action, GameState, Instance, Zone } from './types'

const ruled = (placed: [Card, Zone, Partial<Instance>?][], extra: Partial<GameState> = {}) =>
  game(placed, { rules: true, ...extra })
const run = (state: GameState, ...actions: Action[]) => actions.reduce(reduce, state)
const at = (state: GameState, iid: string) => state.cards.find((c) => c.iid === iid)!
const zone = (state: GameState, iid: string) => at(state, iid).zone
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
const onTo = (state: GameState, step: 'end' | 'upkeep' | 'main1') => {
  const asked = reduce(state, { type: 'passTo', step })
  return asked.pending?.kind === 'attack' ? run(asked, { type: 'attack', iids: [] }, { type: 'passTo', step }) : asked
}
const giant = card('Hill Giant', 'Creature — Giant', { mana_cost: '{3}{R}', cmc: 4, power: '3', toughness: '3' })

describe('sagas', () => {
  const saga = permanent('The Long Road', '(As this Saga enters and after your draw step, add a lore counter. Sacrifice after III.)\nI, II — Draw a card.\nIII — You gain 5 life.', 'Enchantment — Saga', { mana_cost: '{G}' })

  it('tells a chapter as it enters, one each turn after, and is sacrificed at the end', () => {
    expect(compile(saga).coverage).toBe('auto')
    const start = ruled([[saga, 'hand'], [FOREST, 'battlefield'], ...library, ...library])
    const first = run(start, cast('c0'), pass)
    expect(at(first, 'c0').counters).toMatchObject({ lore: 1 })
    expect(first.stack).toHaveLength(1)
    const told = run(first, pass)
    expect(told.cards.filter((c) => c.zone === 'hand')).toHaveLength(1)
    // The second chapter, after the next draw step.
    const second = onTo(told, 'main1')
    expect(at(second, 'c0').counters).toMatchObject({ lore: 2 })
    const two = run(second, pass)
    expect(zone(two, 'c0')).toBe('battlefield')
    // The third: told, and then the Saga is done.
    const third = run(onTo(two, 'main1'), pass)
    expect(third.life).toBe(45)
    expect(zone(third, 'c0')).toBe('graveyard')
  })

  it('reads a chapter aimed across the table as nothing, and one aimed at yours', () => {
    const dynasty = permanent('Kang Dynasty', "(As this Saga enters and after your draw step, add a lore counter. Sacrifice after III.)\nI, II — For each opponent, tap up to one target creature that player controls. Goad those creatures. Until your next turn, whenever any of those creatures deals combat damage to a player, draw a card.\nIII — Target creature you control gets +1/+1 until end of turn for each card in your hand and can't be blocked this turn.", 'Enchantment — Saga')
    expect(compile(dynasty).coverage).toBe('auto')
    const start = ruled([[dynasty, 'battlefield', { counters: { lore: 2 } }], [BEARS, 'battlefield'], [FOREST, 'hand'], [FOREST, 'hand'], ...library])
    const told = run(start, { type: 'counter', iid: 'c0', counter: 'lore', by: 1 }, pass, { type: 'choose', iids: ['c1'] })
    expect(power(at(told, 'c1'), told)).toBe(4)
    expect(zone(told, 'c0')).toBe('graveyard')
  })
})

describe('suspended by an effect', () => {
  const prime = permanent('Kang Prime', "Flying\nWhenever Kang Prime enters or attacks, exile cards from the top of your library until you exile a nonland card. Put two time counters on that card. If it doesn't have suspend, it gains suspend. (At the beginning of your upkeep, remove a time counter. When the last is removed, you may cast it without paying its mana cost. If it's a creature, it has haste.)", 'Legendary Creature — Human Villain', { mana_cost: '{G}', power: '3', toughness: '5', keywords: ['Flying'] })

  it('exiles down to a nonland card, and casts it two upkeeps later with haste', () => {
    expect(compile(prime).coverage).toBe('auto')
    const start = ruled([[prime, 'hand'], [FOREST, 'battlefield'], [PLAINS, 'library'], [giant, 'library'], ...library, ...library])
    const exiled = run(start, cast('c0'), pass, pass)
    expect([zone(exiled, 'c2'), zone(exiled, 'c3')]).toEqual(['exile', 'exile'])
    expect(at(exiled, 'c3').suspended).toBe(2)
    expect(at(exiled, 'c2').suspended).toBeUndefined()
    const one = onTo(exiled, 'main1')
    expect(at(one, 'c3').suspended).toBe(1)
    // The last counter comes off: cast, if you like.
    const two = run(onTo(one, 'upkeep'), pass)
    expect(two.pending).toMatchObject({ kind: 'confirm' })
    const arrived = run(two, yes, pass)
    expect(zone(arrived, 'c3')).toBe('battlefield')
    expect(hasKeyword(at(arrived, 'c3'), 'Haste', arrived)).toBe(true)
  })

  it('suspends a card out of the graveyard', () => {
    const platform = permanent("Doom's Time Platform", "Whenever you attack, exile target nonland card from your graveyard with two time counters on it. If it doesn't have suspend, it gains suspend. (At the beginning of your upkeep, remove a time counter. When the last is removed, you may cast it without paying its mana cost. If it's a creature, it has haste.)", 'Artifact')
    expect(compile(platform).coverage).toBe('auto')
    const start = ruled([[platform, 'battlefield'], [BEARS, 'battlefield'], [giant, 'graveyard'], [FOREST, 'graveyard'], ...library], { step: 'combatAttackers', pending: { kind: 'attack', options: ['c1'] } })
    const asked = run(start, { type: 'attack', iids: ['c1'] }, pass)
    expect(asked.pending).toMatchObject({ kind: 'pick', zone: 'graveyard', options: ['c2'] })
    const done = run(asked, { type: 'choose', iids: ['c2'] })
    expect(at(done, 'c2')).toMatchObject({ zone: 'exile', suspended: 2 })
  })
})

describe('upkeep costs that grow', () => {
  it('asks for one more each upkeep, and sacrifices it when unpaid', () => {
    const remora = permanent('Mystic Remora', 'Cumulative upkeep {1} (At the beginning of your upkeep, put an age counter on this permanent, then sacrifice it unless you pay its upkeep cost for each age counter on it.)\nWhenever an opponent casts a noncreature spell, you may draw a card unless that player pays {4}.')
    expect(compile(remora).coverage).toBe('auto')
    const start = ruled([[remora, 'battlefield'], [FOREST, 'battlefield'], ...library, ...library, ...library])
    const first = run(onTo(start, 'upkeep'), pass)
    expect(at(first, 'c0').counters).toMatchObject({ age: 1 })
    expect(first.pending).toMatchObject({ kind: 'confirm' })
    const paid = run(first, yes)
    expect([zone(paid, 'c0'), at(paid, 'c1').tapped]).toEqual(['battlefield', true])
    // Two is more than one Forest makes.
    const second = run(onTo(paid, 'upkeep'), pass, yes)
    expect(zone(second, 'c0')).toBe('graveyard')
  })
})

describe('the first spell each turn, exchanged', () => {
  it('exiles the spell, digs to a nonland card, deals the difference, and offers it', () => {
    const loki = permanent('Lady Loki', "Whenever you cast your first instant, sorcery, or Villain spell each turn, exile it, then exile cards from the top of your library until you exile a nonland card. Lady Loki deals damage to each opponent equal to the difference between that spell's mana value and that nonland card's mana value. You may cast that card without paying its mana cost.", 'Legendary Creature — God Sorcerer Villain', { power: '5', toughness: '5' })
    expect(compile(loki).coverage).toBe('auto')
    const growth = { ...GROWTH, cmc: 1 }
    const start = ruled([[loki, 'battlefield'], [growth, 'hand'], [FOREST, 'battlefield'], [PLAINS, 'library'], [giant, 'library'], ...library])
    const asked = run(start, cast('c1'), pass)
    expect([zone(asked, 'c1'), zone(asked, 'c3'), zone(asked, 'c4')]).toEqual(['exile', 'exile', 'exile'])
    expect(asked.opponent.life).toBe(37)
    expect(asked.pending).toMatchObject({ kind: 'pick', options: ['c4'], min: 0, max: 1 })
    const done = run(asked, { type: 'choose', iids: ['c4'] }, pass)
    expect(zone(done, 'c4')).toBe('battlefield')
    // The spell it took the place of never resolves.
    expect(done.stack).toHaveLength(0)
    expect(zone(done, 'c1')).toBe('exile')
  })
})

describe('one-offs', () => {
  it('has one of your creatures hit another', () => {
    const clap = spell("Hulk's Thunderclap", "As an additional cost to cast this spell, you may behold a Gamma creature. (You may choose a Gamma creature you control or reveal a Gamma creature card from your hand.)\nTarget creature you control deals damage equal to its power to another target creature. If this spell's additional cost was paid, destroy target noncreature artifact or noncreature enchantment.")
    expect(compile(clap).coverage).toBe('auto')
    const start = ruled([[clap, 'hand'], [FOREST, 'battlefield'], [giant, 'battlefield'], [BEARS, 'battlefield'], ...library])
    const second = run(start, cast('c0'), pass, { type: 'choose', iids: ['c2'] })
    expect(second.pending).toMatchObject({ kind: 'pick', options: ['c3'] })
    const done = run(second, { type: 'choose', iids: ['c3'] })
    expect(zone(done, 'c3')).toBe('graveyard')
  })

  it('exiles a paradigm spell, and offers a copy each first main phase', () => {
    const symposium = spell('Echocasting Symposium', "Target player creates a token that's a copy of target creature you control.\nParadigm (Then exile this spell. After you first resolve a spell with this name, you may cast a copy of it from exile without paying its mana cost at the beginning of each of your first main phases.)", '{G}', 'Sorcery — Lesson')
    expect(compile(symposium).coverage).toBe('auto')
    const start = ruled([[symposium, 'hand'], [FOREST, 'battlefield'], [BEARS, 'battlefield'], ...library, ...library])
    const done = run(start, cast('c0'), pass, { type: 'choose', iids: ['c2'] })
    expect(tokens(done)).toHaveLength(1)
    expect(zone(done, 'c0')).toBe('exile')
    const next = run(onTo(done, 'main1'), pass)
    expect(next.pending).toMatchObject({ kind: 'confirm' })
    const again = run(next, yes, pass, { type: 'choose', iids: ['c2'] })
    expect(tokens(again)).toHaveLength(2)
    expect(zone(again, 'c0')).toBe('exile')
  })

  it('draws for a spell that targets one of your creatures', () => {
    const season = permanent('Season of Growth', 'Whenever a creature you control enters, scry 1. (Look at the top card of your library. You may put that card on the bottom.)\nWhenever you cast a spell that targets a creature you control, draw a card.')
    expect(compile(season).coverage).toBe('auto')
    const start = ruled([[season, 'battlefield'], [GROWTH, 'hand'], [FOREST, 'battlefield'], [BEARS, 'battlefield'], ...library])
    const done = run(start, cast('c1'), pass, { type: 'choose', iids: ['c3'] }, pass)
    expect(done.cards.filter((c) => c.zone === 'hand')).toHaveLength(1)
    expect(toughness(at(done, 'c3'), done)).toBe(5)
  })

  it('makes an Ooze as big as the slime counters on what made it', () => {
    const grime = permanent('Gutter Grime', 'Whenever a nontoken creature you control dies, put a slime counter on this enchantment, then create a green Ooze creature token with "This token\'s power and toughness are each equal to the number of slime counters on Gutter Grime."')
    expect(compile(grime).coverage).toBe('auto')
    const start = ruled([[grime, 'battlefield'], [BEARS, 'battlefield'], [ELVES, 'battlefield'], ...library])
    const one = run(start, { type: 'move', iid: 'c1', zone: 'graveyard' }, pass)
    const [ooze] = tokens(one)
    expect([power(ooze, one), toughness(ooze, one)]).toEqual([1, 1])
    const two = run(one, { type: 'move', iid: 'c2', zone: 'graveyard' }, pass)
    expect(tokens(two).map((c) => power(c, two))).toEqual([2, 2])
  })
})
