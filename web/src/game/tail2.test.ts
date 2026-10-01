import { describe, expect, it } from 'vitest'

import type { Card } from '../lib/api'
import { activationProblem } from './activate'
import { compile } from './compiler/compile'
import { readFilter } from './compiler/read'
import { reduce } from './reducer'
import { hasKeyword, power } from './stats'
import { BEARS, card, ELVES, FOREST, game, OMENS, PLAINS, SWAMP } from './testing'
import type { Action, GameState, Instance, Zone } from './types'

const ruled = (placed: [Card, Zone, Partial<Instance>?][], extra: Partial<GameState> = {}) =>
  game(placed, { rules: true, ...extra })
const run = (state: GameState, ...actions: Action[]) => actions.reduce(reduce, state)
const at = (state: GameState, iid: string) => state.cards.find((c) => c.iid === iid)!
const zone = (state: GameState, z: Zone) => state.cards.filter((c) => c.zone === z).map((c) => c.iid)
const tokens = (state: GameState) => state.cards.filter((c) => c.token)
const pass: Action = { type: 'pass' }
const cast = (iid: string): Action => ({ type: 'play', iid })
const spell = (name: string, text: string, cost = '{G}', type = 'Sorcery') =>
  card(name, type, { mana_cost: cost, oracle_text: text })
const permanent = (name: string, text: string, type = 'Enchantment', extra: Partial<Card> = {}) =>
  card(name, type, { oracle_text: text, ...extra })
const forests: [Card, Zone][] = [[FOREST, 'battlefield'], [FOREST, 'battlefield'], [FOREST, 'battlefield']]
const library: [Card, Zone][] = [[PLAINS, 'library'], [SWAMP, 'library'], [PLAINS, 'library'], [SWAMP, 'library']]
const giant = card('Hill Giant', 'Creature — Giant', { power: '3', toughness: '3' })
const ogre = card('Gray Ogre', 'Creature — Ogre', { power: '2', toughness: '2' })

describe('picking within a total', () => {
  it('keeps creatures up to a total power, and sacrifices the rest', () => {
    const slaughter = spell('Slaughter the Strong', 'Each player chooses any number of creatures they control with total power 4 or less, then sacrifices all other creatures they control.')
    expect(compile(slaughter).coverage).toBe('auto')
    const asked = run(ruled([[slaughter, 'hand'], ...forests, [BEARS, 'battlefield'], [giant, 'battlefield'], [ogre, 'battlefield']]), cast('c0'), pass)
    expect(asked.pending).toMatchObject({ kind: 'pick', options: ['c4', 'c5', 'c6'], min: 0, budget: { max: 4, cost: { c4: 2, c5: 3, c6: 2 } } })
    // Five power is over: refused.
    expect(reduce(asked, { type: 'choose', iids: ['c4', 'c5'] })).toBe(asked)
    const done = reduce(asked, { type: 'choose', iids: ['c4', 'c6'] })
    expect(zone(done, 'graveyard').sort()).toEqual(['c0', 'c5'])
  })

  it('returns creature cards up to a total power', () => {
    const reunion = spell('Reunion of the House', 'Return any number of target creature cards with total power 10 or less from your graveyard to the battlefield. Exile Reunion of the House.')
    expect(compile(reunion).coverage).toBe('auto')
    const big = card('Colossus', 'Creature — Giant', { power: '9', toughness: '9' })
    const asked = run(ruled([[reunion, 'hand'], ...forests, [big, 'graveyard'], [BEARS, 'graveyard'], [giant, 'graveyard']]), cast('c0'), pass)
    expect(asked.pending).toMatchObject({ kind: 'pick', zone: 'graveyard', budget: { max: 10 } })
    expect(reduce(asked, { type: 'choose', iids: ['c4', 'c5'] })).toBe(asked)
    const done = reduce(asked, { type: 'choose', iids: ['c5', 'c6'] })
    expect(zone(done, 'battlefield').filter((iid) => ['c5', 'c6'].includes(iid))).toHaveLength(2)
    expect(at(done, 'c0').zone).toBe('exile')
  })
})

describe('choosing a number', () => {
  it('destroys what is at least that big', () => {
    const expel = spell('Expel the Interlopers', 'Choose a number between 0 and 10. Destroy all creatures with power greater than or equal to the chosen number.')
    expect(compile(expel).coverage).toBe('auto')
    const asked = run(ruled([[expel, 'hand'], ...forests, [BEARS, 'battlefield'], [giant, 'battlefield']]), cast('c0'), pass)
    expect(asked.pending).toMatchObject({ kind: 'number', min: 0, max: 10 })
    expect(reduce(asked, { type: 'number', value: 11 })).toBe(asked)
    const done = reduce(asked, { type: 'number', value: 3 })
    expect(at(done, 'c4').zone).toBe('battlefield')
    expect(at(done, 'c5').zone).toBe('graveyard')
  })
})

describe('sacrificing any number as a cost', () => {
  const evangel = card("Emrakul's Evangel", 'Creature — Human Horror', {
    power: '3', toughness: '2',
    oracle_text: "{T}, Sacrifice Emrakul's Evangel and any number of other non-Eldrazi creatures: Create a 3/2 colorless Eldrazi Horror creature token for each creature sacrificed this way.",
  })

  it('makes a token for each creature given up, itself included', () => {
    expect(compile(evangel).coverage).toBe('auto')
    const asked = run(ruled([[evangel, 'battlefield'], [BEARS, 'battlefield'], [giant, 'battlefield']]), { type: 'activate', iid: 'c0', index: 0 })
    expect(asked.pending).toMatchObject({ kind: 'pick', options: ['c1', 'c2'], min: 0, max: 2 })
    const done = run(asked, { type: 'choose', iids: ['c1'] }, pass)
    expect(zone(done, 'graveyard').sort()).toEqual(['c0', 'c1'])
    expect(tokens(done).map((t) => t.card.name)).toEqual(['Eldrazi Horror', 'Eldrazi Horror'])
  })

  it('may give up only itself', () => {
    const alone = run(ruled([[evangel, 'battlefield']]), { type: 'activate', iid: 'c0', index: 0 }, pass)
    expect(tokens(alone)).toHaveLength(1)
    expect(activationProblem(ruled([[evangel, 'battlefield', { tapped: true }]]), 'c0', 0)).toBe('It is already tapped')
  })
})

describe('leaving and coming back', () => {
  it('flickers permanents, and they arrive anew', () => {
    const flicker = spell('Ghostly Flicker', 'Exile two target artifacts, creatures, and/or lands you control, then return those cards to the battlefield under your control.', '{G}', 'Instant')
    expect(compile(flicker).coverage).toBe('auto')
    const start = ruled([[flicker, 'hand'], ...forests, [OMENS, 'battlefield', { counters: { '+1/+1': 2 }, tapped: true }], [BEARS, 'battlefield'], ...library])
    const done = run(start, cast('c0'), pass, { type: 'choose', iids: ['c4', 'c5'] })
    expect(at(done, 'c4')).toMatchObject({ zone: 'battlefield', tapped: false })
    expect(at(done, 'c4').counters).toBeUndefined()
    // Wall of Omens arrived again, and says so.
    expect(done.stack.map((item) => item.ability?.text)).toEqual(['When Wall of Omens enters, draw a card.'])
  })

  it('returns a creature with persist once, with a -1/-1 counter', () => {
    const kelpie = card('River Kelpie', 'Creature — Beast', {
      power: '3', toughness: '3',
      oracle_text: 'Whenever River Kelpie or another permanent enters from a graveyard, draw a card.\nWhenever a player casts a spell from a graveyard, draw a card.\nPersist',
    })
    expect(compile(kelpie).coverage).toBe('auto')
    const died = run(ruled([[kelpie, 'battlefield'], ...library]), { type: 'move', iid: 'c0', zone: 'graveyard' })
    expect(died.stack).toHaveLength(1)
    const back = run(died, pass)
    expect(at(back, 'c0')).toMatchObject({ zone: 'battlefield', counters: { '-1/-1': 1 } })
    // It entered from a graveyard: its own ability sees that.
    expect(back.stack).toHaveLength(1)
    expect(zone(run(back, pass), 'hand')).toHaveLength(1)
    const again = run(back, pass, { type: 'move', iid: 'c0', zone: 'graveyard' })
    expect(again.stack).toEqual([])
  })

  it('keeps a permanent tapped through its next untap step', () => {
    const tamiyo = card('Tamiyo', 'Legendary Planeswalker — Tamiyo', {
      loyalty: '4', oracle_text: "+1: Tap target permanent. It doesn't untap during its controller's next untap step.",
    })
    expect(compile(tamiyo).coverage).toBe('auto')
    const start = ruled([[tamiyo, 'battlefield', { loyalty: 4 }], [BEARS, 'battlefield'], ...library])
    const frozen = run(start, { type: 'activate', iid: 'c0', index: 0 }, pass, { type: 'choose', iids: ['c1'] })
    expect(at(frozen, 'c1')).toMatchObject({ tapped: true, frozen: true })
    const next = run(frozen, { type: 'passTo', step: 'main1' })
    expect(next.turn).toBe(2)
    expect(at(next, 'c1').tapped).toBe(true)
    expect(at(next, 'c1').frozen).toBeUndefined()
    expect(at(run(next, { type: 'passTo', step: 'main1' }), 'c1').tapped).toBe(false)
  })
})

describe('sharing a creature type', () => {
  const elf = card('Elvish Visionary', 'Creature — Elf Shaman', { power: '1', toughness: '1' })
  const changeling = card('Woodland Changeling', 'Creature — Shapeshifter', { power: '2', toughness: '2', keywords: ['Changeling'] })

  it('counts the creatures that share one with the source', () => {
    const titan = permanent('Titan of Littjara', 'Whenever Titan of Littjara enters or attacks, you may draw a card for each other creature you control that shares a creature type with it. If you do, discard a card.', 'Creature — Elf Illusion', { mana_cost: '{G}', power: '4', toughness: '4' })
    expect(compile(titan).coverage).toBe('auto')
    const start = ruled([[titan, 'hand'], ...forests, [elf, 'battlefield'], [changeling, 'battlefield'], [BEARS, 'battlefield'], ...library])
    const asked = run(start, cast('c0'), pass, pass, { type: 'confirm', yes: true })
    // The Elf and the changeling, not the Bears: two cards, then one back.
    expect(zone(asked, 'hand')).toHaveLength(2)
    expect(asked.pending).toMatchObject({ kind: 'pick', zone: 'hand', min: 1, max: 1 })
  })

  it('digs for a card that shares one with the creature that died', () => {
    const blade = permanent('Heirloom Blade', 'Equipped creature gets +3/+1.\nWhenever equipped creature dies, you may reveal cards from the top of your library until you reveal a creature card that shares a creature type with it. Put that card into your hand and the rest on the bottom of your library in a random order.\nEquip {1}', 'Artifact — Equipment')
    expect(compile(blade).coverage).toBe('auto')
    const start = ruled([[blade, 'battlefield', { attachedTo: 'c1' }], [ELVES, 'battlefield'], [BEARS, 'library'], [PLAINS, 'library'], [elf, 'library'], [SWAMP, 'library']])
    const done = run(start, { type: 'move', iid: 'c1', zone: 'graveyard' }, pass, { type: 'confirm', yes: true })
    expect(zone(done, 'hand')).toEqual(['c4'])
    expect(zone(done, 'library')[0]).toBe('c5')
  })

  it('looks for one among the top five for Call to the Kindred', () => {
    const call = permanent('Call to the Kindred', 'Enchant creature\nAt the beginning of your upkeep, you may look at the top five cards of your library. If you do, you may put a creature card that shares a creature type with enchanted creature from among them onto the battlefield, then you put the rest of those cards on the bottom of your library in any order.', 'Enchantment — Aura')
    expect(compile(call).coverage).toBe('auto')
    const start = ruled([[call, 'battlefield', { attachedTo: 'c1' }], [ELVES, 'battlefield'], [BEARS, 'library'], [elf, 'library'], [PLAINS, 'library']], { step: 'cleanup' })
    const asked = run(start, pass, pass, { type: 'confirm', yes: true })
    expect(asked.pending).toMatchObject({ kind: 'pick', zone: 'library', options: ['c3'], seen: ['c2', 'c4'], min: 0, max: 1 })
    expect(at(reduce(asked, { type: 'choose', iids: ['c3'] }), 'c3').zone).toBe('battlefield')
  })

  it('checks for three creatures of one type', () => {
    const seekers = permanent('Littjara Kinseekers', 'Changeling\nWhen Littjara Kinseekers enters, if you control three or more creatures that share a creature type, put a +1/+1 counter on Littjara Kinseekers, then scry 1.', 'Creature — Shapeshifter', { mana_cost: '{G}', power: '2', toughness: '4', keywords: ['Changeling'] })
    expect(compile(seekers).coverage).toBe('auto')
    const few = run(ruled([[seekers, 'hand'], ...forests, [elf, 'battlefield'], [BEARS, 'battlefield']]), cast('c0'), pass)
    expect(few.stack).toEqual([])
    const enough = run(ruled([[seekers, 'hand'], ...forests, [elf, 'battlefield'], [ELVES, 'battlefield']]), cast('c0'), pass)
    expect(enough.stack).toHaveLength(1)
  })
})

describe('anthems for one thing or another', () => {
  it('reads two kinds joined by "and" as either', () => {
    expect(readFilter('artifact creatures and Heroes')).toEqual({
      either: [{ types: ['creature'], also: ['artifact'] }, { subtypes: ['Hero'] }],
    })
  })

  it('pumps artifact creatures and Heroes for each Artificer, buried ones too', () => {
    const cid = permanent('Cid', 'Artifact creatures and Heroes you control get +1/+1 for each Artificer you control and each Artificer card in your graveyard.', 'Legendary Creature — Human Artificer', { power: '3', toughness: '3' })
    expect(compile(cid).coverage).toBe('auto')
    const hero = card('Hero', 'Creature — Human Hero', { power: '1', toughness: '1' })
    const golem = card('Golem', 'Artifact Creature — Golem', { power: '2', toughness: '2' })
    const tinker = card('Tinker', 'Creature — Gnome Artificer', { power: '1', toughness: '1' })
    const state = ruled([[cid, 'battlefield'], [hero, 'battlefield'], [golem, 'battlefield'], [BEARS, 'battlefield'], [tinker, 'graveyard']])
    expect(power(at(state, 'c1'), state)).toBe(3)
    expect(power(at(state, 'c2'), state)).toBe(4)
    expect(power(at(state, 'c3'), state)).toBe(2)
    expect(power(at(state, 'c0'), state)).toBe(3)
  })

  it('pumps Zombies and tokens, and makes a Zombie when cards leave the graveyard', () => {
    const wings = permanent('On Wings of Gold', 'Creatures you control that are Zombies and/or tokens get +1/+1 and have flying.\nWhenever one or more cards leave your graveyard, create a 1/1 white Zombie creature token.')
    expect(compile(wings).coverage).toBe('auto')
    const zombie = card('Ghoul', 'Creature — Zombie', { power: '2', toughness: '2' })
    const state = ruled([[wings, 'battlefield'], [zombie, 'battlefield'], [BEARS, 'battlefield'], [BEARS, 'battlefield', { token: true }], [OMENS, 'graveyard'], [ELVES, 'graveyard']])
    expect(power(at(state, 'c1'), state)).toBe(3)
    expect(power(at(state, 'c2'), state)).toBe(2)
    expect(hasKeyword(at(state, 'c3'), 'Flying', state)).toBe(true)
    const left = reduce(state, { type: 'move', iid: 'c4', zone: 'exile' })
    expect(left.stack).toHaveLength(1)
    expect(tokens(run(left, pass)).map((t) => t.card.name)).toContain('Zombie')
  })
})

describe('seeking', () => {
  it('takes a creature of the commonest type in the library, at random', () => {
    const agent = permanent('Faceless Agent', 'Changeling\nWhen Faceless Agent enters the battlefield, seek a creature card of the most prevalent creature type in your library.', 'Creature — Shapeshifter', { mana_cost: '{G}', power: '2', toughness: '1', keywords: ['Changeling'] })
    expect(compile(agent).coverage).toBe('auto')
    const elf = card('Elvish Visionary', 'Creature — Elf Shaman')
    const start = ruled([[agent, 'hand'], ...forests, [BEARS, 'library'], [elf, 'library'], [ELVES, 'library'], [PLAINS, 'library']])
    const done = run(start, cast('c0'), pass, pass)
    const [found] = zone(done, 'hand')
    expect(['c5', 'c6']).toContain(found)
    // Seeking does not shuffle: what is left is in the order it was.
    expect(zone(done, 'library')).toEqual(['c4', 'c5', 'c6', 'c7'].filter((iid) => iid !== found))
  })
})
