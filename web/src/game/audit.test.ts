import { describe, expect, it } from 'vitest'

import type { Card } from '../lib/api'
import { compile } from './compiler/compile'
import { reduce } from './reducer'
import { hasKeyword, power } from './stats'
import { BEARS, card, FOREST, game, GROWTH, PLAINS, SWAMP } from './testing'
import type { Action, GameState, Instance, Zone } from './types'

/* Cards that read in full and did the wrong thing: found by reading each
 * card in the decks beside what it compiled to. */

const ruled = (placed: [Card, Zone, Partial<Instance>?][], extra: Partial<GameState> = {}) =>
  game(placed, { rules: true, ...extra })
const run = (state: GameState, ...actions: Action[]) => actions.reduce(reduce, state)
const at = (state: GameState, iid: string) => state.cards.find((c) => c.iid === iid)!
const zone = (state: GameState, iid: string) => at(state, iid).zone
const inZone = (state: GameState, where: Zone) => state.cards.filter((c) => c.zone === where)
const tokens = (state: GameState) => state.cards.filter((c) => c.token)
const pass: Action = { type: 'pass' }
const yes: Action = { type: 'confirm', yes: true }
const no: Action = { type: 'confirm', yes: false }
const cast = (iid: string): Action => ({ type: 'play', iid })
const permanent = (name: string, text: string, type = 'Enchantment', extra: Partial<Card> = {}) =>
  card(name, type, { oracle_text: text, ...extra })
const library: [Card, Zone][] = [[PLAINS, 'library'], [SWAMP, 'library'], [PLAINS, 'library'], [SWAMP, 'library']]
const onTo = (state: GameState, step: 'end' | 'upkeep' | 'main1') => {
  const asked = reduce(state, { type: 'passTo', step })
  return asked.pending?.kind === 'attack' ? run(asked, { type: 'attack', iids: [] }, { type: 'passTo', step }) : asked
}
const villain = (name: string) => card(name, 'Creature — Human Villain', { power: '2', toughness: '2' })

describe('keywords with conditions', () => {
  const baldric = card('Multiclass Baldric', 'Artifact — Equipment', {
    oracle_text: 'Equipped creature has lifelink if you control a Cleric, deathtouch if you control a Rogue, haste if you control a Warrior, and flying if you control a Wizard.\nEquip {2}',
  })
  const cleric = card('Healer', 'Creature — Human Cleric', { power: '1', toughness: '1' })
  const wizard = card('Sage', 'Creature — Human Wizard', { power: '1', toughness: '1' })

  it('gives each keyword only while its condition holds', () => {
    expect(compile(baldric).coverage).toBe('auto')
    const state = ruled([[baldric, 'battlefield', { attachedTo: 'c1' }], [BEARS, 'battlefield'], [cleric, 'battlefield']])
    const bears = at(state, 'c1')
    expect(['Lifelink', 'Deathtouch', 'Haste', 'Flying'].map((k) => hasKeyword(bears, k, state))).toEqual([true, false, false, false])
    const more = ruled([[baldric, 'battlefield', { attachedTo: 'c1' }], [BEARS, 'battlefield'], [wizard, 'battlefield']])
    expect(['Lifelink', 'Flying'].map((k) => hasKeyword(at(more, 'c1'), k, more))).toEqual([false, true])
  })

  it('does not take a condition for part of a keyword\'s name', () => {
    const odd = permanent('Odd Banner', 'Creatures you control have flying unless it is raining.')
    expect(compile(odd).statics).toEqual([])
  })
})

describe('melee given to other creatures', () => {
  it('pumps each creature that has it as it attacks', () => {
    const titania = permanent('Titania', 'First strike\nMelee\nOther creatures you control have melee.', 'Legendary Creature — Human Villain', { power: '3', toughness: '3', keywords: ['First strike', 'Melee'] })
    const start = ruled([[titania, 'battlefield'], [BEARS, 'battlefield'], ...library], { step: 'combatAttackers', pending: { kind: 'attack', options: ['c0', 'c1'] } })
    const attacking = reduce(start, { type: 'attack', iids: ['c0', 'c1'] })
    expect(attacking.stack).toHaveLength(2)
    const pumped = run(attacking, pass, pass)
    expect([power(at(pumped, 'c0'), pumped), power(at(pumped, 'c1'), pumped)]).toEqual([4, 3])
  })
})

describe('whose library', () => {
  const crab = permanent('Hedron Crab', 'Landfall — Whenever a land you control enters, target player mills three cards.', 'Creature — Crab', { power: '0', toughness: '2' })

  it('asks who mills, and mills nobody when it is the opponent', () => {
    expect(compile(crab).coverage).toBe('auto')
    const start = ruled([[crab, 'battlefield'], [FOREST, 'hand'], ...library])
    const asked = run(start, cast('c1'), pass)
    expect(asked.pending).toMatchObject({ kind: 'mode', modes: ['You mill three cards', 'The opponent mills three cards'] })
    expect(inZone(run(asked, { type: 'mode', index: 1 }), 'graveyard')).toHaveLength(0)
    expect(inZone(run(asked, { type: 'mode', index: 0 }), 'graveyard')).toHaveLength(3)
  })

  it('still mills you where the card says you', () => {
    const digger = card('Dig', 'Sorcery', { mana_cost: '{G}', oracle_text: 'Mill three cards.' })
    const done = run(ruled([[digger, 'hand'], [FOREST, 'battlefield'], ...library]), cast('c0'), pass)
    expect([done.pending, inZone(done, 'graveyard').length]).toEqual([null, 4])
  })
})

describe('a token that stands in for an exiled card', () => {
  it('sends the card to the graveyard when the token leaves', () => {
    const hofri = permanent('Hofri Ghostforge', 'Spirits you control get +1/+1 and have trample and haste.\nWhenever another nontoken creature you control dies, exile it. If you do, create a token that\'s a copy of that creature, except it\'s a Spirit in addition to its other types and it has "When this token leaves the battlefield, return the exiled card to its owner\'s graveyard."', 'Legendary Creature — Dwarf Cleric', { power: '4', toughness: '5' })
    const start = ruled([[hofri, 'battlefield'], [BEARS, 'battlefield'], ...library])
    const made = run(start, { type: 'move', iid: 'c1', zone: 'graveyard' }, pass)
    expect(zone(made, 'c1')).toBe('exile')
    const [spirit] = tokens(made)
    expect(spirit.card.type_line).toBe('Creature — Bear Spirit')
    const gone = run(made, { type: 'move', iid: spirit.iid, zone: 'graveyard' })
    expect(zone(gone, 'c1')).toBe('graveyard')
    expect(tokens(gone)).toHaveLength(0)
  })
})

describe('becoming the target of something', () => {
  it('sacrifices an Illusion that a spell is aimed at', () => {
    const image = card('Phantasmal Image', 'Creature — Illusion', {
      mana_cost: '{G}', power: '0', toughness: '0',
      oracle_text: 'You may have this creature enter as a copy of any creature on the battlefield, except it\'s an Illusion in addition to its other types and it has "When this creature becomes the target of a spell or ability, sacrifice it."',
    })
    const start = ruled([[image, 'hand'], [FOREST, 'battlefield'], [FOREST, 'battlefield'], [BEARS, 'battlefield'], [GROWTH, 'hand'], ...library])
    const copy = run(start, cast('c0'), pass, { type: 'choose', iids: ['c3'] })
    expect(at(copy, 'c0').card).toMatchObject({ name: 'Grizzly Bears', type_line: 'Creature — Bear Illusion' })
    // Aimed at the real Bears: nothing happens to the Illusion.
    const spared = run(copy, cast('c4'), pass, { type: 'choose', iids: ['c3'] })
    expect([spared.stack.length, zone(spared, 'c0')]).toEqual([0, 'battlefield'])
    const hit = run(copy, cast('c4'), pass, { type: 'choose', iids: ['c0'] }, pass)
    expect(zone(hit, 'c0')).toBe('graveyard')
  })

  it('sacrifices it when an Equipment is put on it, too', () => {
    const illusion = card('Illusion', 'Creature — Illusion', { power: '2', toughness: '2', oracle_text: 'When this creature becomes the target of a spell or ability, sacrifice it.' })
    const boots = card('Boots', 'Artifact — Equipment', { oracle_text: 'Equip {0}' })
    expect(compile(illusion).coverage).toBe('auto')
    const start = ruled([[illusion, 'battlefield'], [boots, 'battlefield'], [BEARS, 'battlefield'], ...library])
    const done = run(start, { type: 'activate', iid: 'c1', index: 0 }, pass, { type: 'choose', iids: ['c0'] }, pass)
    expect(zone(done, 'c0')).toBe('graveyard')
  })

  it('does not count untapping lands as aiming at them', () => {
    const illusion = card('Mirage Field', 'Land Creature — Illusion', { power: '1', toughness: '1', oracle_text: 'When this creature becomes the target of a spell or ability, sacrifice it.' })
    const snap = card('Refresh', 'Instant', { mana_cost: '{G}', oracle_text: 'Untap up to two lands.' })
    const start = ruled([[illusion, 'battlefield', { tapped: true }], [snap, 'hand'], [FOREST, 'battlefield'], ...library])
    const done = run(start, cast('c1'), pass, { type: 'choose', iids: ['c0'] })
    expect([done.stack.length, zone(done, 'c0'), at(done, 'c0').tapped]).toEqual([0, 'battlefield', false])
  })
})

describe('a copy with an ability of its own', () => {
  it('makes a token of itself each upkeep, and the token does not', () => {
    const mimic = card('Progenitor Mimic', 'Creature — Shapeshifter', {
      mana_cost: '{G}', power: '0', toughness: '0',
      oracle_text: 'You may have this creature enter as a copy of any creature on the battlefield, except it has "At the beginning of your upkeep, if this creature isn\'t a token, create a token that\'s a copy of this creature."',
    })
    const start = ruled([[mimic, 'hand'], [FOREST, 'battlefield'], [BEARS, 'battlefield'], ...library, ...library])
    const copy = run(start, cast('c0'), pass, { type: 'choose', iids: ['c2'] })
    expect(compile(at(copy, 'c0').card).coverage).toBe('auto')
    const one = onTo(copy, 'main1')
    expect(tokens(one).map((c) => c.card.name)).toEqual(['Grizzly Bears'])
    // Next upkeep: one more from the Mimic, none from its token.
    expect(tokens(onTo(one, 'main1'))).toHaveLength(2)
  })
})

describe('"do this only once each turn"', () => {
  const strucker = permanent('Baron Strucker', 'Villain spells you cast cost {1} less to cast.\nWhenever another Villain you control enters, you may have it connive. Do this only once each turn.', 'Legendary Creature — Human Villain', { power: '2', toughness: '2' })

  it('is not used up by saying no', () => {
    const start = ruled([[strucker, 'battlefield'], [villain('One'), 'hand'], [villain('Two'), 'hand'], [villain('Three'), 'hand'], ...library, ...library])
    const first = run(start, { type: 'place', iid: 'c1', at: { x: 0.2, y: 0.2 } }, pass)
    expect(first.pending).toMatchObject({ kind: 'confirm' })
    const second = run(first, no, { type: 'place', iid: 'c2', at: { x: 0.3, y: 0.2 } }, pass)
    // Asked again, having declined the first time.
    expect(second.pending).toMatchObject({ kind: 'confirm' })
    const done = run(second, yes)
    expect(done.pending).toMatchObject({ kind: 'pick', zone: 'hand' })
    const third = run(done, { type: 'choose', iids: ['c3'] }, { type: 'place', iid: 'c3', at: { x: 0.4, y: 0.2 } }, pass)
    expect(third.pending).toBeNull()
  })

  it('is there again next turn', () => {
    const start = ruled([[strucker, 'battlefield'], [villain('One'), 'hand'], [villain('Two'), 'hand'], ...library, ...library])
    const used = run(start, { type: 'place', iid: 'c1', at: { x: 0.2, y: 0.2 } }, pass, yes)
    const hand = inZone(used, 'hand').map((c) => c.iid)
    const next = onTo(run(used, { type: 'choose', iids: [hand[0]] }), 'main1')
    const again = run(next, { type: 'place', iid: 'c2', at: { x: 0.3, y: 0.2 } }, pass)
    expect(again.pending).toMatchObject({ kind: 'confirm' })
  })
})

describe('tokens with names', () => {
  it('names a token what the card names it', () => {
    const koma = permanent('Koma, World-Eater', "Whenever Koma deals combat damage to a player, create four 3/3 blue Serpent creature tokens named Koma's Coil.", 'Legendary Creature — Serpent', { power: '8', toughness: '12' })
    const [trigger] = compile(koma).triggers
    const start = ruled([[koma, 'battlefield'], ...library])
    const made = reduce({ ...start, stack: [{ id: 's0', iid: 'c0', x: 0, ability: { text: trigger.text, effects: trigger.effects, complete: true, event: null, known: {} } }] }, pass)
    expect(tokens(made).map((c) => [c.card.name, c.card.type_line])).toEqual(Array.from({ length: 4 }, () => ["Koma's Coil", 'Token Creature — Serpent']))
  })
})

describe('equip with a condition', () => {
  it('goes only onto what it names', () => {
    const blade = card('Blackblade Reforged', 'Legendary Artifact — Equipment', {
      oracle_text: 'Equipped creature gets +1/+1 for each land you control.\nEquip legendary creature {3}\nEquip {7}',
    })
    const king = card('Old King', 'Legendary Creature — Human Noble', { power: '4', toughness: '4' })
    const [cheap, dear] = compile(blade).activated
    expect(cheap.effects[0]).toMatchObject({ op: 'choose', filter: { types: ['creature'], subtypes: ['Legendary'] } })
    expect(dear.effects[0]).toMatchObject({ op: 'choose', filter: { types: ['creature'], controller: 'you' } })
    const lands: [Card, Zone][] = Array.from({ length: 3 }, () => [FOREST, 'battlefield'])
    const start = ruled([[blade, 'battlefield'], ...lands, [BEARS, 'battlefield'], [king, 'battlefield'], ...library])
    // One legend to put it on: no question to ask.
    const done = run(start, { type: 'activate', iid: 'c0', index: 0 }, pass)
    expect(at(done, 'c0').attachedTo).toBe('c5')
  })
})
