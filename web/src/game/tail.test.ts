import { describe, expect, it } from 'vitest'

import type { Card } from '../lib/api'
import { compile } from './compiler/compile'
import { isKind, sweeping } from './kinds'
import { reduce } from './reducer'
import { manaAbilities } from './sources'
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
const permanent = (name: string, text: string, type = 'Enchantment', extra: Partial<Card> = {}) =>
  card(name, type, { oracle_text: text, ...extra })
const forests: [Card, Zone][] = [[FOREST, 'battlefield'], [FOREST, 'battlefield'], [FOREST, 'battlefield']]
const library: [Card, Zone][] = [[PLAINS, 'library'], [SWAMP, 'library'], [PLAINS, 'library'], [SWAMP, 'library']]
const attackWith = (state: GameState, ...iids: string[]) =>
  run({ ...state, step: 'combatAttackers', pending: { kind: 'attack', options: iids } }, { type: 'attack', iids })

describe('tokens that arrive attacking', () => {
  const loki = permanent('Loki', "Whenever Loki attacks, create a tapped and attacking token that's a copy of another target Villain you control, except it isn't legendary and it's an Illusion in addition to its other types. Sacrifice that token at the beginning of the next end step.", 'Legendary Creature — God Villain', { power: '3', toughness: '3' })
  const thug = card('Thug', 'Legendary Creature — Human Villain', { power: '2', toughness: '2' })

  it('join the attack, tapped, and are gone at the end step', () => {
    expect(compile(loki).coverage).toBe('auto')
    const attacked = attackWith(ruled([[loki, 'battlefield'], [thug, 'battlefield'], ...library]), 'c0')
    expect(attacked.stack).toHaveLength(1)
    const copied = run(attacked, pass, { type: 'choose', iids: ['c1'] })
    const [token] = tokens(copied)
    expect(token).toMatchObject({ tapped: true, fleeting: 'end', card: { name: 'Thug', type_line: 'Creature — Human Villain Illusion' } })
    expect(copied.attacking).toEqual(['c0', token.iid])
  })

  it('are made once for each card discarded this turn', () => {
    const laser = permanent('Living Laser', "Whenever Living Laser attacks, for each card you've discarded this turn, create a token that's a copy of Living Laser, except the token isn't legendary. The tokens enter tapped and attacking. Exile the tokens at the beginning of the next end step.", 'Legendary Creature — Elemental Villain', { power: '2', toughness: '2' })
    expect(compile(laser).coverage).toBe('auto')
    const start = ruled([[laser, 'battlefield'], ...library], { tally: { drawn: 0, discarded: 2, died: 0, left: 0, binned: 0, gained: 0, lost: 0, struck: 0 } })
    const done = run(attackWith(start, 'c0'), pass)
    expect(tokens(done)).toHaveLength(2)
    expect(done.attacking).toHaveLength(3)
    expect(tokens(done)[0].card.type_line).toBe('Creature — Elemental Villain')
  })
})

describe('until end of turn', () => {
  it('makes a creature another type as well', () => {
    const scepter = permanent("Loki's Scepter", 'When Loki\'s Scepter enters, gain control of target creature until end of turn. Untap that creature. Until end of turn, it becomes a Villain in addition to its other types and gains haste.', 'Legendary Artifact', { mana_cost: '{G}' })
    expect(compile(scepter).coverage).toBe('auto')
    const done = run(ruled([[scepter, 'hand'], ...forests, [BEARS, 'battlefield', { tapped: true }]]), cast('c0'), pass, pass, { type: 'choose', iids: ['c4'] })
    expect(at(done, 'c4').tapped).toBe(false)
    expect(hasKeyword(at(done, 'c4'), 'Haste', done)).toBe(true)
    expect(isKind(at(done, 'c4'), { subtypes: ['Villain'] }, undefined, sweeping(done))).toBe(true)
    expect(isKind(at(done, 'c4'), { subtypes: ['Villain'] }, undefined, sweeping({ ...done, boosts: [] }))).toBe(false)
  })

  it('gives melee its +1/+1 for the one opponent there is', () => {
    const titania = card('Titania', 'Legendary Creature — Human Villain', { power: '5', toughness: '5', oracle_text: 'Trample\nMelee' })
    expect(compile(titania).coverage).toBe('auto')
    const done = run(attackWith(ruled([[titania, 'battlefield'], ...library]), 'c0'), pass)
    expect(power(at(done, 'c0'), done)).toBe(6)
  })

  it('offers a choice of keywords', () => {
    const viper = permanent('Viper', "{B}: Target creature that's attacking alone gains your choice of deathtouch or lifelink until end of turn.", 'Legendary Creature — Human Villain', { power: '3', toughness: '3' })
    expect(compile(viper).coverage).toBe('auto')
    const attacking = ruled([[viper, 'battlefield'], [SWAMP, 'battlefield'], [BEARS, 'battlefield'], ...library], { step: 'combatAttackers', attacking: ['c0'] })
    const asked = run(attacking, { type: 'activate', iid: 'c0', index: 0 }, pass)
    // Alone, it is the only thing to aim at; with two attacking there is nothing.
    expect(asked.pending).toMatchObject({ kind: 'pick', options: ['c0'] })
    const chosen = reduce(asked, { type: 'choose', iids: ['c0'] })
    expect(chosen.pending).toMatchObject({ kind: 'mode', modes: ['Deathtouch', 'Lifelink'] })
    const done = reduce(chosen, { type: 'mode', index: 1 })
    expect(hasKeyword(at(done, 'c0'), 'Lifelink', done)).toBe(true)
  })
})

describe('conniving more', () => {
  it('draws first under Leader, then connives', () => {
    const leader = permanent('Leader', 'If a creature you control would connive, instead you draw a card, then that creature connives.\n{T}: Target creature you control connives.', 'Legendary Creature — Gamma Villain', { power: '2', toughness: '2' })
    expect(compile(leader).coverage).toBe('auto')
    const asked = run(ruled([[leader, 'battlefield'], ...library]), { type: 'activate', iid: 'c0', index: 0 }, pass, { type: 'choose', iids: ['c0'] })
    expect(zone(asked, 'hand')).toHaveLength(2)
    expect(asked.pending).toMatchObject({ kind: 'pick', zone: 'hand', min: 1, max: 1 })
  })

  it('connives for as much damage as was dealt', () => {
    const mask = permanent('Mask of the Schemer', 'Equipped creature gets +1/+1.\nWhenever equipped creature deals combat damage to a player, it connives X, where X is the amount of damage it dealt to that player.\nEquip {2}', 'Artifact — Equipment')
    expect(compile(mask).coverage).toBe('auto')
    const deck: [Card, Zone][] = [[OMENS, 'library'], [BEARS, 'library'], [OMENS, 'library'], [PLAINS, 'library'], [PLAINS, 'library']]
    const start = ruled([[mask, 'battlefield', { attachedTo: 'c1' }], [BEARS, 'battlefield'], ...deck])
    const hit = run(attackWith(start, 'c1'))
    expect(hit.stack).toHaveLength(1)
    const asked = run(hit, pass)
    // Three damage: three cards drawn, three to discard.
    expect(zone(asked, 'hand')).toHaveLength(3)
    expect(asked.pending).toMatchObject({ kind: 'pick', zone: 'hand', min: 3, max: 3 })
    const done = reduce(asked, { type: 'choose', iids: ['c2', 'c3', 'c4'] })
    expect(at(done, 'c1').counters).toEqual({ '+1/+1': 3 })
  })

  it('reads convoke as a way to pay, and what convoked the spell as conniving', () => {
    const scheme = card('Lethal Scheme', 'Instant', { mana_cost: '{G}', oracle_text: 'Convoke\nDestroy target creature or planeswalker. Each creature that convoked Lethal Scheme connives.' })
    expect(compile(scheme)).toMatchObject({ coverage: 'auto', skipped: [], statics: [{ kind: 'convoke' }] })
  })
})

describe('modes with strings attached', () => {
  const monument = permanent('Monument to Endurance', "Whenever you discard a card, choose one that hasn't been chosen this turn —\n• Draw a card.\n• Create a Treasure token.\n• Each opponent loses 3 life.", 'Artifact')

  it('offers only the modes not yet chosen this turn', () => {
    expect(compile(monument).coverage).toBe('auto')
    const start = ruled([[monument, 'battlefield'], [BEARS, 'hand'], [OMENS, 'hand'], ...library])
    const first = run(start, { type: 'move', iid: 'c1', zone: 'graveyard' }, pass)
    expect(first.pending).toMatchObject({ kind: 'mode', modes: ['Draw a card.', 'Create a Treasure token.', 'Each opponent loses 3 life.'], taken: [] })
    const second = run(first, { type: 'mode', index: 2 }, { type: 'move', iid: 'c2', zone: 'graveyard' }, pass)
    expect(second.opponent.life).toBe(37)
    expect(second.pending).toMatchObject({ kind: 'mode', taken: [2] })
    // What was chosen before is not to be had again.
    expect(reduce(second, { type: 'mode', index: 2 })).toBe(second)
    expect(tokens(reduce(second, { type: 'mode', index: 1 }))).toHaveLength(1)
  })

  it('chooses at random, unless the card lets you', () => {
    const mary = permanent('Typhoid Mary', 'Whenever Typhoid Mary attacks, choose one at random. If you discarded a card this turn, you choose one instead.\n• Mary — Create a Treasure token.\n• Typhoid Mary — Draw a card.\n• Bloody Mary — Each opponent loses 2 life and you gain 2 life.', 'Legendary Creature — Mutant Villain', { power: '3', toughness: '3' })
    expect(compile(mary).coverage).toBe('auto')
    const start = ruled([[mary, 'battlefield'], ...library])
    const random = run(attackWith(start, 'c0'), pass)
    expect(random.pending).toBeNull()
    expect(random.seed).not.toBe(start.seed)
    const did = [tokens(random).length, zone(random, 'hand').length, 40 - random.opponent.life].filter(Boolean)
    expect(did).toHaveLength(1)
    const discarded = { ...start, tally: { ...start.tally, discarded: 1 } }
    expect(run(attackWith(discarded, 'c0'), pass).pending).toMatchObject({ kind: 'mode' })
  })
})

describe('abilities that work from elsewhere', () => {
  it('returns Endless Ranks from the graveyard when your commander arrives', () => {
    const ranks = card('Endless Ranks', 'Sorcery', { mana_cost: '{G}', oracle_text: 'Create a 2/1 black Villain creature token with menace.\nWhenever your commander enters or attacks, you may pay {1}{B}. If you do, return Endless Ranks from your graveyard to your hand.' })
    expect(compile(ranks).coverage).toBe('auto')
    const boss = card('Boss', 'Legendary Creature — Human Villain', { mana_cost: '{G}', power: '2', toughness: '2' })
    const start = ruled([[ranks, 'graveyard'], [boss, 'hand', { commander: true }], [FOREST, 'battlefield'], [SWAMP, 'battlefield'], [SWAMP, 'battlefield']])
    const entered = run(start, cast('c1'), pass)
    expect(entered.stack).toHaveLength(1)
    const done = run(entered, pass, { type: 'confirm', yes: true })
    expect(at(done, 'c0').zone).toBe('hand')
    // In hand, or on the battlefield, it watches nothing.
    const held = run(ruled([[ranks, 'hand'], [boss, 'hand', { commander: true }], ...forests]), cast('c1'), pass)
    expect(held.stack).toEqual([])
  })

  it('returns Endless Evil to hand if what it enchanted was a Horror', () => {
    const evil = permanent('Endless Evil', 'Enchant creature you control\nWhen enchanted creature dies, if that creature was a Horror, return Endless Evil to its owner\'s hand.', 'Enchantment — Aura')
    expect(compile(evil).coverage).toBe('auto')
    const horror = card('Thing', 'Creature — Horror', { power: '1', toughness: '1' })
    const done = run(ruled([[evil, 'battlefield', { attachedTo: 'c1' }], [horror, 'battlefield']]), { type: 'move', iid: 'c1', zone: 'graveyard' }, pass)
    expect(at(done, 'c0').zone).toBe('hand')
    const other = run(ruled([[evil, 'battlefield', { attachedTo: 'c1' }], [BEARS, 'battlefield']]), { type: 'move', iid: 'c1', zone: 'graveyard' })
    expect(other.stack).toEqual([])
    expect(at(other, 'c0').zone).toBe('graveyard')
  })

  it('returns the creature card most lately buried', () => {
    const griffin = permanent('Mistmoon Griffin', 'Flying\nWhen Mistmoon Griffin dies, exile it, then return the top creature card of your graveyard to the battlefield.', 'Creature — Griffin', { power: '2', toughness: '2' })
    expect(compile(griffin).coverage).toBe('auto')
    const start = ruled([[griffin, 'battlefield'], [BEARS, 'battlefield'], [OMENS, 'battlefield'], [ELVES, 'graveyard']])
    const buried = run(start, { type: 'move', iid: 'c2', zone: 'graveyard' }, { type: 'move', iid: 'c1', zone: 'graveyard' }, { type: 'move', iid: 'c0', zone: 'graveyard' }, pass)
    expect(at(buried, 'c0').zone).toBe('exile')
    expect(at(buried, 'c1').zone).toBe('battlefield')
    expect(at(buried, 'c2').zone).toBe('graveyard')
  })
})

describe('mana from an enchanted land', () => {
  it('adds a {G} for each Elf', () => {
    const guidance = permanent('Elvish Guidance', 'Enchant land\nWhenever enchanted land is tapped for mana, its controller adds an additional {G} for each Elf on the battlefield.', 'Enchantment — Aura')
    expect(compile(guidance).coverage).toBe('auto')
    const state = ruled([[guidance, 'battlefield', { attachedTo: 'c1' }], [FOREST, 'battlefield'], [ELVES, 'battlefield'], [ELVES, 'battlefield'], [FOREST, 'battlefield']])
    expect(manaAbilities(at(state, 'c1'), state)[0].makes).toEqual([['G'], ['G'], ['G']])
    expect(manaAbilities(at(state, 'c4'), state)[0].makes).toEqual([['G']])
  })
})

describe('what cannot be aimed', () => {
  it('reads returning a spell you do not control as nothing', () => {
    const horror = permanent('Hullbreaker Horror', "Whenever you cast a spell, choose up to one —\n• Return target spell you don't control to its owner's hand.\n• Return target nonland permanent to its owner's hand.", 'Creature — Kraken Horror')
    expect(compile(horror).coverage).toBe('auto')
  })
})
