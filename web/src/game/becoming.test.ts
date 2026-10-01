import { describe, expect, it } from 'vitest'

import type { Card } from '../lib/api'
import { abilitiesOf } from './activate'
import { costOf } from './cast'
import { compile } from './compiler/compile'
import { reduce } from './reducer'
import { power, toughness } from './stats'
import { BEARS, card, ELVES, FOREST, game, OMENS, PLAINS, SWAMP } from './testing'
import type { Action, GameState, Instance, Zone } from './types'

const ruled = (placed: [Card, Zone, Partial<Instance>?][], extra: Partial<GameState> = {}) =>
  game(placed, { rules: true, ...extra })
const run = (state: GameState, ...actions: Action[]) => actions.reduce(reduce, state)
const at = (state: GameState, iid: string) => state.cards.find((c) => c.iid === iid)!
const tokens = (state: GameState) => state.cards.filter((c) => c.token)
const pass: Action = { type: 'pass' }
const cast = (iid: string): Action => ({ type: 'play', iid })
const spell = (name: string, text: string, cost = '{G}', type = 'Sorcery') =>
  card(name, type, { mana_cost: cost, oracle_text: text })
const permanent = (name: string, text: string, type = 'Enchantment', extra: Partial<Card> = {}) =>
  card(name, type, { oracle_text: text, ...extra })
const forests: [Card, Zone][] = [[FOREST, 'battlefield'], [FOREST, 'battlefield'], [FOREST, 'battlefield']]
const library: [Card, Zone][] = [[PLAINS, 'library'], [SWAMP, 'library'], [PLAINS, 'library'], [SWAMP, 'library']]
const king = card('Old King', 'Legendary Creature — Human Noble', { power: '4', toughness: '4' })
const island = card('Island', 'Basic Land — Island')
const islands: [Card, Zone][] = [[island, 'battlefield'], [island, 'battlefield'], [island, 'battlefield']]
/** On to the given step, attacking with nothing if the game asks. */
const onTo = (state: GameState, step: 'end' | 'upkeep') => {
  const asked = reduce(state, { type: 'passTo', step })
  return asked.pending?.kind === 'attack' ? run(asked, { type: 'attack', iids: [] }, { type: 'passTo', step }) : asked
}

describe('becoming a copy', () => {
  it('makes every other creature a copy until end of turn, and then themselves again', () => {
    const loki = permanent('Loki', "{U}, {T}: Choose target creature you control. Each creature you control other than the chosen creature becomes a copy of that creature until end of turn, except it isn't legendary. Activate only as a sorcery.", 'Legendary Creature — God Villain', { power: '2', toughness: '2' })
    expect(compile(loki).coverage).toBe('auto')
    const start = ruled([[loki, 'battlefield'], [island, 'battlefield'], [king, 'battlefield'], [BEARS, 'battlefield'], ...library])
    const done = run(start, { type: 'activate', iid: 'c0', index: 0 }, pass, { type: 'choose', iids: ['c2'] })
    expect(at(done, 'c3').card).toMatchObject({ name: 'Old King', type_line: 'Creature — Human Noble', power: '4' })
    expect(at(done, 'c0').card.name).toBe('Old King')
    expect(at(done, 'c2').card.type_line).toBe('Legendary Creature — Human Noble')
    const over = onTo(done, 'upkeep')
    expect(at(over, 'c3').card.name).toBe('Grizzly Bears')
    expect(at(over, 'c0').card.name).toBe('Loki')
  })

  it('makes a land a copy of another for good, keeping the ability that did it', () => {
    const stage = card("Thespian's Stage", 'Land', {
      oracle_text: "{T}: Add {C}.\n{2}, {T}: Thespian's Stage becomes a copy of target land, except it has this ability.",
    })
    expect(compile(stage).coverage).toBe('auto')
    const start = ruled([[stage, 'battlefield'], [FOREST, 'battlefield'], [PLAINS, 'battlefield'], ...library])
    const done = run(start, { type: 'activate', iid: 'c0', index: 0 }, pass, { type: 'choose', iids: ['c1'] })
    expect(at(done, 'c0').card).toMatchObject({ name: 'Forest', type_line: 'Basic Land — Forest' })
    expect(abilitiesOf(at(done, 'c0'))).toHaveLength(1)
    // It stays a Forest: that was not "until end of turn".
    expect(at(onTo(done, 'upkeep'), 'c0').card.name).toBe('Forest')
    expect(at(reduce(done, { type: 'move', iid: 'c0', zone: 'hand' }), 'c0').card.name).toBe("Thespian's Stage")
  })

  it('makes each nonland permanent a copy of the target', () => {
    const mirrorform = spell('Mirrorform', 'Each nonland permanent you control becomes a copy of target non-Aura permanent.', '{G}', 'Instant')
    expect(compile(mirrorform).coverage).toBe('auto')
    const relic = card('Relic', 'Artifact')
    const done = run(ruled([[mirrorform, 'hand'], ...forests, [BEARS, 'battlefield'], [relic, 'battlefield'], [OMENS, 'battlefield']]), cast('c0'), pass, { type: 'choose', iids: ['c4'] })
    expect([at(done, 'c5').card.name, at(done, 'c6').card.name, at(done, 'c1').card.name]).toEqual(['Grizzly Bears', 'Grizzly Bears', 'Forest'])
  })

  it('makes one target a copy of another until your next turn', () => {
    const sharer = permanent('Shapesharer', 'Changeling\n{2}{U}: Target Shapeshifter becomes a copy of target creature until your next turn.', 'Creature — Shapeshifter', { power: '1', toughness: '1', keywords: ['Changeling'] })
    expect(compile(sharer).coverage).toBe('auto')
    const start = ruled([[sharer, 'battlefield'], ...islands, [king, 'battlefield'], ...library])
    const first = run(start, { type: 'activate', iid: 'c0', index: 0 }, pass)
    expect(first.pending).toMatchObject({ kind: 'pick', options: ['c0'] })
    const second = reduce(first, { type: 'choose', iids: ['c0'] })
    expect(second.pending).toMatchObject({ kind: 'pick', options: ['c0', 'c4'] })
    const done = reduce(second, { type: 'choose', iids: ['c4'] })
    expect(at(done, 'c0').card.name).toBe('Old King')
    // Through this turn's cleanup, and gone as the next turn begins.
    const end = onTo(done, 'end')
    expect(at(end, 'c0').card.name).toBe('Old King')
    expect(at(onTo(end, 'upkeep'), 'c0').card.name).toBe('Shapesharer')
  })
})

describe('entering as a copy, with more exceptions', () => {
  it('arrives with a shield counter', () => {
    const operative = card('Undercover Operative', 'Creature — Shapeshifter Rogue', {
      mana_cost: '{G}', power: '0', toughness: '0',
      oracle_text: 'You may have Undercover Operative enter as a copy of any creature on the battlefield, except it enters with a shield counter on it if you control that creature.',
    })
    expect(compile(operative).coverage).toBe('auto')
    const done = run(ruled([[operative, 'hand'], ...forests, [BEARS, 'battlefield']]), cast('c0'), pass, { type: 'choose', iids: ['c4'] })
    expect(at(done, 'c0')).toMatchObject({ counters: { shield: 1 }, card: { name: 'Grizzly Bears' } })
  })

  it('reads Moritte: legendary, snow, and two counters on a creature', () => {
    const moritte = card('Moritte of the Frost', 'Legendary Snow Creature — Shapeshifter', {
      mana_cost: '{G}', power: '0', toughness: '0', keywords: ['Changeling'],
      oracle_text: "Changeling\nYou may have Moritte enter as a copy of a permanent you control, except it's legendary and snow in addition to its other types and, if it's a creature, it enters with two additional +1/+1 counters on it and has changeling.",
    })
    expect(compile(moritte).coverage).toBe('auto')
    const done = run(ruled([[moritte, 'hand'], ...forests, [BEARS, 'battlefield']]), cast('c0'), pass, { type: 'choose', iids: ['c4'] })
    expect(at(done, 'c0')).toMatchObject({
      counters: { '+1/+1': 2 },
      card: { name: 'Grizzly Bears', type_line: 'Legendary Snow Creature — Bear', keywords: ['Changeling'] },
    })
  })
})

describe('abilities that cost X', () => {
  const entity = permanent('Mirror Entity', 'Changeling\n{X}: Until end of turn, creatures you control have base power and toughness X/X and gain all creature types.', 'Creature — Shapeshifter', { power: '1', toughness: '1', keywords: ['Changeling'] })

  it('asks for X, pays it, and sets the size for the turn', () => {
    expect(compile(entity).coverage).toBe('auto')
    expect(abilitiesOf({ ...ruled([[entity, 'battlefield']]).cards[0] })[0].cost).toMatchObject({ mana: '{X}' })
    const start = ruled([[entity, 'battlefield'], ...forests, [BEARS, 'battlefield', { counters: { '+1/+1': 1 } }], ...library])
    const done = run(start, { type: 'activate', iid: 'c0', index: 0, x: 3 }, pass)
    expect(done.cards.filter((c) => c.tapped)).toHaveLength(3)
    // Base 3/3, and the counter still counts.
    expect([power(at(done, 'c0'), done), toughness(at(done, 'c0'), done)]).toEqual([3, 3])
    expect(power(at(done, 'c4'), done)).toBe(4)
    const over = onTo(done, 'upkeep')
    expect(power(at(over, 'c4'), over)).toBe(3)
  })

  it('reads Minsc making one creature X/X and a Giant', () => {
    const minsc = permanent('Minsc', '{X}: Until end of turn, target creature you control has base power and toughness X/X and becomes a Giant in addition to its other types. Activate only as a sorcery.', 'Legendary Creature — Human Ranger', { power: '3', toughness: '3' })
    expect(compile(minsc).coverage).toBe('auto')
    const done = run(ruled([[minsc, 'battlefield'], ...forests, [BEARS, 'battlefield']]), { type: 'activate', iid: 'c0', index: 0, x: 2 }, pass, { type: 'choose', iids: ['c4'] })
    expect(power(at(done, 'c4'), done)).toBe(2)
    expect(done.boosts[0]).toMatchObject({ iids: ['c4'], types: ['Giant'], base: { power: 2, toughness: 2 } })
  })
})

describe('doing it twice', () => {
  it('triggers a second time under Roaming Throne', () => {
    const throne = permanent('Roaming Throne', 'Ward {2}\nAs Roaming Throne enters, choose a creature type.\nRoaming Throne is the chosen type in addition to its other types.\nIf a triggered ability of another creature you control of the chosen type triggers, it triggers an additional time.', 'Artifact Creature — Golem', { power: '4', toughness: '4' })
    expect(compile(throne).coverage).toBe('auto')
    const visionary = card('Elvish Visionary', 'Creature — Elf Shaman', { mana_cost: '{G}', oracle_text: 'When Elvish Visionary enters, draw a card.' })
    const scout = card('Scout', 'Creature — Human Scout', { mana_cost: '{G}', oracle_text: 'When Scout enters, draw a card.' })
    const start = ruled([[throne, 'battlefield', { chosenType: 'Elf' }], [visionary, 'hand'], [scout, 'hand'], ...forests, ...library])
    const elf = run(start, cast('c1'), pass)
    expect(elf.stack).toHaveLength(2)
    // The Scout is not an Elf: once.
    const wall = run(elf, pass, pass, cast('c2'), pass)
    expect(wall.stack).toHaveLength(1)
  })

  it('copies a creature spell of the chosen type as a token', () => {
    const reflections = permanent('Reflections of Littjara', 'As Reflections of Littjara enters, choose a creature type.\nWhenever you cast a spell of the chosen type, copy that spell.')
    expect(compile(reflections).coverage).toBe('auto')
    const start = ruled([[reflections, 'battlefield', { chosenType: 'Elf' }], [ELVES, 'hand'], [BEARS, 'hand'], ...forests, ...library])
    const copied = run(start, cast('c1'), pass)
    expect(tokens(copied).map((t) => t.card.name)).toEqual(['Llanowar Elves'])
    expect(at(copied, 'c1').zone).toBe('stack')
    const bears = run(copied, pass, cast('c2'))
    expect(bears.stack).toHaveLength(1)
  })

  it('reads an outlaw as any of five types', () => {
    const down = permanent('Double Down', 'Whenever you cast an outlaw spell, copy that spell.')
    expect(compile(down).triggers[0].when).toEqual({
      on: 'cast', filter: { subtypes: ['Assassin', 'Mercenary', 'Pirate', 'Rogue', 'Warlock'] },
    })
  })
})

describe('a discount for variety', () => {
  it('counts the creature types you control, up to five', () => {
    const valiant = card('Valiant Changeling', 'Creature — Shapeshifter', {
      mana_cost: '{5}{W}{W}', keywords: ['Changeling'],
      oracle_text: "Changeling\nThis spell costs {1} less to cast for each creature type among creatures you control. This effect can't reduce the amount of mana this spell costs by more than {5}.\nDouble strike",
    })
    expect(compile(valiant).coverage).toBe('auto')
    const two = ruled([[valiant, 'hand'], [ELVES, 'battlefield'], [BEARS, 'battlefield']])
    // Elf, Druid, Bear.
    expect(costOf(two, at(two, 'c0')).generic).toBe(2)
    const changeling = card('Woodland Changeling', 'Creature — Shapeshifter', { keywords: ['Changeling'] })
    const every = ruled([[valiant, 'hand'], [changeling, 'battlefield']])
    expect(costOf(every, at(every, 'c0')).generic).toBe(0)
  })
})
