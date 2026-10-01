import { describe, expect, it } from 'vitest'

import type { Card } from '../lib/api'
import { abilitiesOf, activationProblem } from './activate'
import { eligibleAttackers } from './combat'
import { compile } from './compiler/compile'
import { reduce } from './reducer'
import { isCreature } from './sources'
import { hasKeyword, power, toughness } from './stats'
import { BEARS, card, ELVES, FOREST, game, PLAINS, SWAMP } from './testing'
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
const forests: [Card, Zone][] = [[FOREST, 'battlefield'], [FOREST, 'battlefield'], [FOREST, 'battlefield']]
const library: [Card, Zone][] = [[PLAINS, 'library'], [SWAMP, 'library'], [PLAINS, 'library'], [SWAMP, 'library']]
/** On to the given step, attacking with nothing if the game asks. */
const onTo = (state: GameState, step: 'end' | 'upkeep' | 'main1') => {
  const asked = reduce(state, { type: 'passTo', step })
  return asked.pending?.kind === 'attack' ? run(asked, { type: 'attack', iids: [] }, { type: 'passTo', step }) : asked
}
const giant = card('Hill Giant', 'Creature — Giant', { mana_cost: '{3}{R}', cmc: 4, power: '3', toughness: '3' })

describe('lands that become creatures', () => {
  it('makes every land a 2/2 until your next turn', () => {
    const awakening = spell('Sylvan Awakening', "Until your next turn, all lands you control become 2/2 Elemental creatures with reach, indestructible, and haste. They're still lands.")
    expect(compile(awakening).coverage).toBe('auto')
    const done = run(ruled([[awakening, 'hand'], ...forests, ...library]), cast('c0'), pass)
    const land = at(done, 'c2')
    expect(land.card.type_line).toBe('Basic Land Creature — Forest Elemental')
    expect([power(land, done), toughness(land, done), hasKeyword(land, 'Reach', done)]).toEqual([2, 2, true])
    // Still a land: it taps for mana.
    expect(reduce(done, { type: 'mana', iid: 'c2' }).pool.G).toBe(1)
    const next = onTo(done, 'main1')
    expect(at(next, 'c2').card.type_line).toBe('Basic Land — Forest')
  })

  it('makes one land a creature for good, with the counters to live on', () => {
    const nissa = card('Nissa, Who Shakes the World', 'Legendary Planeswalker — Nissa', {
      loyalty: '5',
      oracle_text: "Whenever you tap a Forest for mana, add an additional {G}.\n+1: Put three +1/+1 counters on up to one target noncreature land you control. Untap it. It becomes a 0/0 Elemental creature with vigilance and haste that's still a land.\n−8: You get an emblem with \"Lands you control have indestructible.\" Search your library for any number of Forest cards, put them onto the battlefield tapped, then shuffle.",
    })
    expect(compile(nissa).coverage).toBe('auto')
    const start = ruled([[nissa, 'battlefield', { loyalty: 5 }], [FOREST, 'battlefield', { tapped: true }], ...library])
    const done = run(start, { type: 'activate', iid: 'c0', index: 0 }, pass, { type: 'choose', iids: ['c1'] })
    const land = at(done, 'c1')
    expect(isCreature(land)).toBe(true)
    expect([power(land, done), toughness(land, done), land.tapped]).toEqual([3, 3, false])
    expect(isCreature(at(onTo(done, 'main1'), 'c1'))).toBe(true)
  })

  it('gets an emblem, and every Forest in the library', () => {
    const nissa = card('Nissa, Who Shakes the World', 'Legendary Planeswalker — Nissa', {
      loyalty: '5',
      oracle_text: "−8: You get an emblem with \"Lands you control have indestructible.\" Search your library for any number of Forest cards, put them onto the battlefield tapped, then shuffle.",
    })
    const start = ruled([[nissa, 'battlefield', { loyalty: 8 }], [PLAINS, 'battlefield'], [FOREST, 'library'], [FOREST, 'library'], ...library])
    const asked = run(start, { type: 'activate', iid: 'c0', index: 0 }, pass)
    expect(asked.pending).toMatchObject({ kind: 'pick', zone: 'library', options: ['c2', 'c3'], max: 2 })
    const done = run(asked, { type: 'choose', iids: ['c2', 'c3'] })
    expect(tokens(done).map((c) => c.card.type_line)).toEqual(['Emblem'])
    expect(hasKeyword(at(done, 'c1'), 'Indestructible', done)).toBe(true)
    expect([at(done, 'c2').zone, at(done, 'c2').tapped]).toEqual(['battlefield', true])
  })

  it('makes a land a creature as big as your lands are many', () => {
    const awaken = spell('Awaken the Land', 'Target land you control becomes a creature with haste and "This creature\'s power and toughness are each equal to the number of lands you control." It\'s still a land.')
    expect(compile(awaken).coverage).toBe('auto')
    const done = run(ruled([[awaken, 'hand'], ...forests, ...library]), cast('c0'), pass, { type: 'choose', iids: ['c3'] })
    const land = at(done, 'c3')
    expect([isCreature(land), power(land, done), toughness(land, done), hasKeyword(land, 'Haste', done)]).toEqual([true, 3, 3, true])
  })
})

describe('vehicles', () => {
  const shredder = permanent('Hedge Shredder', 'Whenever this Vehicle attacks, you may mill two cards.\nWhenever one or more land cards are put into your graveyard from your library, put them onto the battlefield tapped.\nCrew 1 (Tap any number of creatures you control with total power 1 or more: This Vehicle becomes an artifact creature until end of turn.)', 'Artifact — Vehicle', { power: '5', toughness: '5' })
  const base = permanent('Damocles Base', 'Flying, deathtouch\nWhenever Damocles Base deals combat damage to a player, that player faces a villainous choice — They sacrifice a nontoken creature of their choice, or they lose 2 life and you draw two cards.\nCrew 3', 'Legendary Artifact — Vehicle', { power: '5', toughness: '5', keywords: ['Flying', 'Deathtouch'] })

  it('is crewed by tapping creatures with enough power, until end of turn', () => {
    expect(compile(base).coverage).toBe('auto')
    const start = ruled([[base, 'battlefield'], [BEARS, 'battlefield'], [ELVES, 'battlefield'], [giant, 'battlefield'], ...library])
    const asked = reduce(start, { type: 'activate', iid: 'c0', index: 0 })
    expect(asked.pending).toMatchObject({ kind: 'pick', zone: 'battlefield', options: ['c1', 'c2', 'c3'], budget: { min: 3, of: 'power' } })
    // Two power is not three.
    expect(reduce(asked, { type: 'choose', iids: ['c1'] })).toBe(asked)
    const crewed = run(asked, { type: 'choose', iids: ['c1', 'c3'] }, pass)
    expect([at(crewed, 'c1').tapped, at(crewed, 'c2').tapped, at(crewed, 'c3').tapped]).toEqual([true, false, true])
    expect(at(crewed, 'c0').card.type_line).toBe('Legendary Artifact Creature — Vehicle')
    expect(eligibleAttackers(crewed).map((c) => c.iid)).toContain('c0')
    expect(at(onTo(crewed, 'main1'), 'c0').card.type_line).toBe('Legendary Artifact — Vehicle')
  })

  it('cannot be crewed without the power for it', () => {
    const start = ruled([[base, 'battlefield'], [BEARS, 'battlefield'], ...library])
    expect(activationProblem(start, 'c0', 0)).toMatch(/power/i)
  })

  it('cannot attack the turn it arrives, crewed or not', () => {
    const cheap = card('Cart', 'Artifact — Vehicle', { mana_cost: '{G}', oracle_text: 'Crew 1', power: '3', toughness: '3' })
    const start = ruled([[cheap, 'hand'], [FOREST, 'battlefield'], [BEARS, 'battlefield'], ...library])
    const crewed = run(start, cast('c0'), pass, { type: 'activate', iid: 'c0', index: 0 }, { type: 'choose', iids: ['c2'] }, pass)
    expect(isCreature(at(crewed, 'c0'))).toBe(true)
    expect(eligibleAttackers(crewed).map((c) => c.iid)).not.toContain('c0')
  })

  it('has the opponent choose between two evils — picked for them', () => {
    const [choice] = compile(base).triggers
    expect(choice.effects[0]).toMatchObject({ op: 'mode', who: 'opponent', min: 1, max: 1 })
    const start = ruled([[base, 'battlefield'], ...library])
    const hit = reduce({ ...start, stack: [{ id: 's0', iid: 'c0', x: 0, ability: { text: choice.text, effects: choice.effects, complete: true, event: null, known: {} } }] }, pass)
    expect(hit.pending).toMatchObject({ kind: 'mode' })
    const done = reduce(hit, { type: 'mode', index: 1 })
    expect(done.opponent.life).toBe(38)
    expect(done.cards.filter((c) => c.zone === 'hand')).toHaveLength(2)
  })

  it('puts milled lands onto the battlefield tapped', () => {
    expect(compile(shredder).coverage).toBe('auto')
    const mill = spell('Mind Sculpt', 'Mill three cards.')
    const start = ruled([[shredder, 'battlefield'], [mill, 'hand'], [FOREST, 'battlefield'], [PLAINS, 'library'], [BEARS, 'library'], [SWAMP, 'library'], ...library])
    const done = run(start, cast('c1'), pass, pass, pass)
    expect([at(done, 'c3').zone, at(done, 'c3').tapped, zone(done, 'c5'), zone(done, 'c4')]).toEqual(['battlefield', true, 'battlefield', 'graveyard'])
  })
})

describe('coming back', () => {
  it('returns the enchanted creature, and its Aura with it at the end step', () => {
    const gift = permanent('Gift of Immortality', "Enchant creature\nWhen enchanted creature dies, return that card to the battlefield under its owner's control. Return this card to the battlefield attached to that creature at the beginning of the next end step.", 'Enchantment — Aura')
    expect(compile(gift).coverage).toBe('auto')
    const start = ruled([[gift, 'battlefield', { attachedTo: 'c1' }], [BEARS, 'battlefield'], ...library])
    const back = run(start, { type: 'move', iid: 'c1', zone: 'graveyard' }, pass)
    expect([zone(back, 'c1'), zone(back, 'c0')]).toEqual(['battlefield', 'graveyard'])
    const end = run(onTo(back, 'end'), pass)
    expect(at(end, 'c0')).toMatchObject({ zone: 'battlefield', attachedTo: 'c1' })
  })

  it('returns what went to the graveyard from the battlefield this turn', () => {
    const gerrard = permanent('Gerrard, Weatherlight Hero', 'First strike\nWhen Gerrard dies, exile it and return to the battlefield all artifact and creature cards in your graveyard that were put there from the battlefield this turn.', 'Legendary Creature — Human Soldier', { power: '3', toughness: '3', keywords: ['First strike'] })
    expect(compile(gerrard).coverage).toBe('auto')
    const relic = card('Relic', 'Artifact')
    const start = ruled([[gerrard, 'battlefield'], [BEARS, 'battlefield'], [relic, 'battlefield'], [giant, 'graveyard'], [ELVES, 'hand'], ...library])
    const done = run(start,
      { type: 'move', iid: 'c1', zone: 'graveyard' }, { type: 'move', iid: 'c2', zone: 'graveyard' },
      { type: 'move', iid: 'c4', zone: 'graveyard' }, { type: 'move', iid: 'c0', zone: 'graveyard' }, pass)
    // The Bears and the Relic come back; the Giant was there already, and
    // the Elves were discarded, not killed.
    expect(['c0', 'c1', 'c2', 'c3', 'c4'].map((iid) => zone(done, iid))).toEqual(['exile', 'battlefield', 'battlefield', 'graveyard', 'graveyard'])
  })

  it('returns a creature that dies this turn, once', () => {
    const saffi = permanent('Saffi Eriksdotter', 'Sacrifice Saffi Eriksdotter: When target creature is put into your graveyard this turn, return that card to the battlefield.', 'Legendary Creature — Human Scout', { power: '2', toughness: '2' })
    expect(compile(saffi).coverage).toBe('auto')
    const start = ruled([[saffi, 'battlefield'], [BEARS, 'battlefield'], ...library])
    const saved = run(start, { type: 'activate', iid: 'c0', index: 0 }, pass, { type: 'choose', iids: ['c1'] })
    const back = run(saved, { type: 'move', iid: 'c1', zone: 'graveyard' }, pass)
    expect(zone(back, 'c1')).toBe('battlefield')
    // Only the once.
    expect(zone(run(back, { type: 'move', iid: 'c1', zone: 'graveyard' }, pass), 'c1')).toBe('graveyard')
    // …and only this turn.
    const later = run(onTo(saved, 'main1'), { type: 'move', iid: 'c1', zone: 'graveyard' })
    expect(later.stack).toHaveLength(0)
  })

  it('exiles a reanimated creature at the next end step', () => {
    const rites = spell('Fleeting Rites', 'Return target creature card from your graveyard to the battlefield. It gains haste. Exile it at the beginning of the next end step.')
    expect(compile(rites).coverage).toBe('auto')
    const start = ruled([[rites, 'hand'], [FOREST, 'battlefield'], [giant, 'graveyard'], ...library])
    const back = run(start, cast('c0'), pass, { type: 'choose', iids: ['c2'] })
    expect([zone(back, 'c2'), hasKeyword(at(back, 'c2'), 'Haste', back)]).toEqual(['battlefield', true])
    const end = run(onTo(back, 'end'), pass)
    expect(zone(end, 'c2')).toBe('exile')
  })
})

describe('a few more', () => {
  it('shuffles a permanent away for whatever is on top', () => {
    const warp = spell('Chaos Warp', "The owner of target permanent shuffles it into their library, then reveals the top card of their library. If it's a permanent card, they put it onto the battlefield.", '{G}', 'Instant')
    expect(compile(warp).coverage).toBe('auto')
    const start = ruled([[warp, 'hand'], [FOREST, 'battlefield'], [BEARS, 'battlefield'], [giant, 'library'], [giant, 'library']])
    const done = run(start, cast('c0'), pass, { type: 'choose', iids: ['c2'] })
    // Three cards in the library, all creatures: one of them arrives.
    expect(done.cards.filter((c) => c.zone === 'battlefield' && isCreature(c))).toHaveLength(1)
    expect(done.cards.filter((c) => c.zone === 'library')).toHaveLength(2)
  })

  it('searches for lands with different names', () => {
    const horizon = spell('Reach the Horizon', 'Search your library for up to two basic land cards and/or Town cards with different names, put them onto the battlefield tapped, then shuffle.')
    expect(compile(horizon).coverage).toBe('auto')
    const town = card('Vector Town', 'Land — Town')
    const start = ruled([[horizon, 'hand'], [FOREST, 'battlefield'], [PLAINS, 'library'], [PLAINS, 'library'], [town, 'library'], [BEARS, 'library']])
    const asked = run(start, cast('c0'), pass)
    expect(asked.pending).toMatchObject({ kind: 'pick', options: ['c2', 'c4'], max: 2 })
  })

  it('reads a control effect that changes nothing here', () => {
    const pressure = spell('Peer Pressure', 'Choose a creature type. If you control more creatures of that type than each other player, you gain control of all creatures of that type. (This effect lasts indefinitely.)')
    expect(compile(pressure).coverage).toBe('auto')
  })

  it('returns cards to hand as they reach the graveyard, with the emblem for it', () => {
    const tamiyo = card('Tamiyo, the Moon Sage', 'Legendary Planeswalker — Tamiyo', {
      loyalty: '4',
      oracle_text: '−8: You get an emblem with "You have no maximum hand size" and "Whenever a card is put into your graveyard from anywhere, you may return it to your hand."',
    })
    expect(compile(tamiyo).coverage).toBe('auto')
    const start = ruled([[tamiyo, 'battlefield', { loyalty: 8 }], [BEARS, 'hand'], ...library])
    const emblem = run(start, { type: 'activate', iid: 'c0', index: 0 }, pass)
    expect(compile(tokens(emblem)[0].card).statics).toContainEqual({ kind: 'noMaxHandSize' })
    const back = run(emblem, { type: 'move', iid: 'c1', zone: 'graveyard' }, pass, yes)
    expect(zone(back, 'c1')).toBe('hand')
  })
})

describe('abilities of things that are not creatures', () => {
  it('lists crew among a Vehicle\'s abilities', () => {
    const cart = card('Wagon', 'Artifact — Vehicle', { oracle_text: 'Crew 2', power: '3', toughness: '3' })
    expect(abilitiesOf({ iid: 'x', card: cart, zone: 'battlefield', tapped: false, x: 0, y: 0 })[0].cost.crew).toBe(2)
  })
})
