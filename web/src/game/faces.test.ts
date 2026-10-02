import { describe, expect, it } from 'vitest'

import type { Card } from '../lib/api'
import { castWays, playable } from './cast'
import { compile } from './compiler/compile'
import { backOf, frontOf } from './faces'
import { deal, reduce } from './reducer'
import { power } from './stats'
import { BEARS, card, entry, FOREST, game, PLAINS, SWAMP } from './testing'
import type { Action, GameState, Instance, Zone } from './types'

const ruled = (placed: [Card, Zone, Partial<Instance>?][], extra: Partial<GameState> = {}) =>
  game(placed, { rules: true, ...extra })
const run = (state: GameState, ...actions: Action[]) => actions.reduce(reduce, state)
const at = (state: GameState, iid: string) => state.cards.find((c) => c.iid === iid)!
const zone = (state: GameState, iid: string) => at(state, iid).zone
const inZone = (state: GameState, where: Zone) => state.cards.filter((c) => c.zone === where)
const keys = (state: GameState, iid: string) => castWays(state, at(state, iid)).map((way) => way.key)
const pass: Action = { type: 'pass' }
const cast = (iid: string): Action => ({ type: 'play', iid })
const by = (way: string): Action => ({ type: 'cast', way })
const lands = (of: Card, n: number): [Card, Zone][] => Array.from({ length: n }, () => [of, 'battlefield'])
const library: [Card, Zone][] = [[PLAINS, 'library'], [SWAMP, 'library'], [PLAINS, 'library'], [SWAMP, 'library']]
const onTo = (state: GameState, step: 'end' | 'upkeep' | 'main1') => {
  const asked = reduce(state, { type: 'passTo', step })
  return asked.pending?.kind === 'attack' ? run(asked, { type: 'attack', iids: [] }, { type: 'passTo', step }) : asked
}
const giant = card('Hill Giant', 'Creature — Giant', { mana_cost: '{3}{R}', cmc: 4, power: '3', toughness: '3' })

/** As the mirror has them: the card's own text empty, each face with its. */
const beanstalk = card('Beanstalk Giant // Fertile Footsteps', 'Creature — Giant // Sorcery — Adventure', {
  mana_cost: '{6}{G} // {2}{G}', oracle_text: '', layout: 'adventure', power: '*', toughness: '*', cmc: 7,
  card_faces: [
    { name: 'Beanstalk Giant', mana_cost: '{6}{G}', type_line: 'Creature — Giant', power: '*', toughness: '*', oracle_text: "Beanstalk Giant's power and toughness are each equal to the number of lands you control." },
    { name: 'Fertile Footsteps', mana_cost: '{2}{G}', type_line: 'Sorcery — Adventure', oracle_text: 'Search your library for a basic land card, put it onto the battlefield, then shuffle. (Then exile this card. You may cast the creature later from exile.)' },
  ],
})
const dusk = card('Dusk // Dawn', 'Sorcery // Sorcery', {
  mana_cost: '{2}{W}{W} // {3}{W}{W}', oracle_text: '', layout: 'split', keywords: ['Aftermath'], cmc: 9,
  card_faces: [
    { name: 'Dusk', mana_cost: '{2}{W}{W}', type_line: 'Sorcery', oracle_text: 'Destroy all creatures with power 3 or greater.' },
    { name: 'Dawn', mana_cost: '{3}{W}{W}', type_line: 'Sorcery', oracle_text: 'Aftermath (Cast this spell only from your graveyard. Then exile it.)\nReturn all creature cards with power 2 or less from your graveyard to your hand.' },
  ],
})

describe('a card with two faces', () => {
  it('is read as its front face, and the other is read too', () => {
    expect(frontOf(beanstalk)).toMatchObject({ name: 'Beanstalk Giant', mana_cost: '{6}{G}', type_line: 'Creature — Giant' })
    expect(backOf(beanstalk)).toMatchObject({ name: 'Fertile Footsteps', mana_cost: '{2}{G}', type_line: 'Sorcery — Adventure' })
    const compiled = compile(beanstalk)
    expect(compiled.coverage).toBe('auto')
    expect(compiled.statics).toMatchObject([{ kind: 'size' }])
    expect(compile(backOf(beanstalk)!).spell?.effects).toMatchObject([{ op: 'search' }])
    expect(compile(dusk)).toMatchObject({ coverage: 'auto', spell: { effects: [{ op: 'move' }] } })
  })

  it('counts a face it cannot read against the card', () => {
    const odd = card('Fine // Odd', 'Sorcery // Sorcery', {
      mana_cost: '{G} // {G}', oracle_text: '', layout: 'split',
      card_faces: [
        { name: 'Fine', mana_cost: '{G}', type_line: 'Sorcery', oracle_text: 'Draw a card.' },
        { name: 'Odd', mana_cost: '{G}', type_line: 'Sorcery', oracle_text: 'Each player shuffles their hand and graveyard into their library.' },
      ],
    })
    expect(compile(odd).coverage).toBe('partial')
    expect(compile(odd).unread).toHaveLength(0)
  })

  it('says so when the other face is one that is turned to, not cast', () => {
    const werewolf = card('Village Watch // Village Reavers', 'Creature — Human Werewolf // Creature — Werewolf', {
      mana_cost: '{4}{R}', oracle_text: '', layout: 'transform', power: '4', toughness: '3',
      card_faces: [
        { name: 'Village Watch', mana_cost: '{4}{R}', type_line: 'Creature — Human Werewolf', power: '4', toughness: '3', oracle_text: 'Haste' },
        { name: 'Village Reavers', type_line: 'Creature — Werewolf', power: '5', toughness: '4', oracle_text: 'Wolves and Werewolves you control have haste.' },
      ],
    })
    expect(backOf(werewolf)).toBeNull()
    expect(compile(werewolf)).toMatchObject({ coverage: 'auto', skipped: ['Its other face, Village Reavers'] })
    expect(frontOf(werewolf)).toMatchObject({ name: 'Village Watch', type_line: 'Creature — Human Werewolf', power: '4' })
  })

  it('is dealt as its front face', () => {
    const start = deal([entry(beanstalk), entry(FOREST, 20)], 3, true)
    const dealt = start.cards.find((c) => c.card.oracle_id === beanstalk.oracle_id)!
    expect(dealt.card).toMatchObject({ name: 'Beanstalk Giant', mana_cost: '{6}{G}' })
  })
})

describe('an adventure', () => {
  it('is cast as the spell, exiled, and cast as the creature later', () => {
    const start = ruled([[frontOf(beanstalk), 'hand'], ...lands(FOREST, 3), [FOREST, 'library'], ...library])
    // Three lands: only the adventure can be paid for, and it is still asked.
    expect(keys(start, 'c0')).toEqual(['back'])
    const asked = reduce(start, cast('c0'))
    expect(asked.pending).toMatchObject({ kind: 'way', ways: [{ key: 'back', label: expect.stringContaining('Fertile Footsteps') }] })
    const went = run(asked, by('back'), pass)
    expect(went.pending).toMatchObject({ kind: 'pick', zone: 'library' })
    const back = run(went, { type: 'choose', iids: ['c4'] })
    expect(zone(back, 'c4')).toBe('battlefield')
    // On an adventure: in exile, and castable from there as the creature.
    expect(at(back, 'c0')).toMatchObject({ zone: 'exile', card: { name: 'Beanstalk Giant' }, mayPlay: { through: null } })
    expect(playable(back).has('c0')).toBe(false)
    const rich = { ...back, cards: [...back.cards, ...game(lands(FOREST, 7)).cards.map((c, i) => ({ ...c, iid: `x${i}` }))] }
    expect(keys(rich, 'c0')).toEqual(['normal'])
    const arrived = run(rich, cast('c0'), pass)
    expect(zone(arrived, 'c0')).toBe('battlefield')
    expect(power(at(arrived, 'c0'), arrived)).toBe(11)
  })

  it('may be cast as the creature straight away, and then there is no adventure', () => {
    const start = ruled([[frontOf(beanstalk), 'hand'], ...lands(FOREST, 7), ...library])
    expect(keys(start, 'c0')).toEqual(['normal', 'back'])
    const arrived = run(start, cast('c0'), by('normal'), pass)
    expect(at(arrived, 'c0')).toMatchObject({ zone: 'battlefield', card: { name: 'Beanstalk Giant' } })
    // Dead, it is a card in the graveyard and nothing more.
    const dead = reduce(arrived, { type: 'move', iid: 'c0', zone: 'graveyard' })
    expect(playable(dead).has('c0')).toBe(false)
  })
})

describe('a split card with aftermath', () => {
  it('casts the first half from hand and the second from the graveyard, then is exiled', () => {
    const small = { ...BEARS, power: '2', toughness: '2' }
    const start = ruled([[frontOf(dusk), 'hand'], ...lands(PLAINS, 5), [giant, 'battlefield'], [small, 'battlefield'], [small, 'graveyard'], ...library])
    // Dawn is not cast from hand.
    expect(keys(start, 'c0')).toEqual(['normal'])
    const swept = run(start, cast('c0'), pass)
    expect([zone(swept, 'c6'), zone(swept, 'c7'), zone(swept, 'c0')]).toEqual(['graveyard', 'battlefield', 'graveyard'])
    const next = onTo(swept, 'main1')
    expect(keys(next, 'c0')).toEqual(['back'])
    expect(playable(next).has('c0')).toBe(true)
    const dawn = run(next, cast('c0'), pass)
    // The small creature comes back to hand; the Giant does not; the card is exiled.
    expect([zone(dawn, 'c8'), zone(dawn, 'c6'), zone(dawn, 'c0')]).toEqual(['hand', 'graveyard', 'exile'])
    expect(at(dawn, 'c0').card.name).toBe('Dusk')
  })
})

describe('the last five', () => {
  it('destroys everything that is not of a type chosen as it resolves', () => {
    const dominance = card('Kindred Dominance', 'Sorcery', { mana_cost: '{G}', oracle_text: "Choose a creature type. Destroy all creatures that aren't of the chosen type." })
    const mimic = card('Mimic', 'Creature — Shapeshifter', { power: '1', toughness: '1', keywords: ['Changeling'] })
    expect(compile(dominance).coverage).toBe('auto')
    const start = ruled([[dominance, 'hand'], [FOREST, 'battlefield'], [BEARS, 'battlefield'], [giant, 'battlefield'], [mimic, 'battlefield'], ...library])
    const asked = run(start, cast('c0'), pass)
    expect(asked.pending).toMatchObject({ kind: 'type', iid: 'c0' })
    const done = run(asked, { type: 'pickType', subtype: 'Bear' })
    expect(['c2', 'c3', 'c4', 'c0'].map((iid) => zone(done, iid))).toEqual(['battlefield', 'graveyard', 'battlefield', 'graveyard'])
  })

  it('cannot lose with Platinum Angel out', () => {
    const angel = card('Platinum Angel', 'Artifact Creature — Angel', { power: '4', toughness: '4', keywords: ['Flying'], oracle_text: "Flying\nYou can't lose the game and your opponents can't win the game." })
    expect(compile(angel).coverage).toBe('auto')
    const safe = reduce(ruled([[angel, 'battlefield']], { life: 3 }), { type: 'life', by: -5 })
    expect(safe.lost).toBeNull()
    expect(reduce(safe, { type: 'draw' }).lost).toBeNull()
    const gone = reduce(safe, { type: 'move', iid: 'c0', zone: 'graveyard' })
    expect(gone.lost).toBeTruthy()
  })

  it('pays {0} for a Zombie with Rooftop Storm', () => {
    const storm = card('Rooftop Storm', 'Enchantment', { oracle_text: 'You may pay {0} rather than pay the mana cost for Zombie creature spells you cast.' })
    const zombie = card('Gravecrawler', 'Creature — Zombie', { mana_cost: '{3}{B}', power: '2', toughness: '1' })
    expect(compile(storm).coverage).toBe('auto')
    const start = ruled([[storm, 'battlefield'], [zombie, 'hand'], [giant, 'hand'], ...library])
    expect(keys(start, 'c1')).toEqual(['alt'])
    expect(keys(start, 'c2')).toEqual([])
    const done = run(start, cast('c1'), by('alt'), pass)
    expect(zone(done, 'c1')).toBe('battlefield')
  })

  it('tells a Saga creature\'s chapters: a bounce, then cards for attacking', () => {
    const leviathan = card('Summon: Leviathan', 'Enchantment Creature — Saga Leviathan', {
      power: '6', toughness: '6',
      oracle_text: "(As this Saga enters and after your draw step, add a lore counter. Sacrifice after III.)\nI — Return each creature that isn't a Kraken, Leviathan, Merfolk, Octopus, or Serpent to its owner's hand.\nII, III — Until end of turn, whenever a Kraken, Leviathan, Merfolk, Octopus, or Serpent attacks, draw a card.\nWard {2}",
    })
    expect(compile(leviathan).coverage).toBe('auto')
    const start = ruled([[leviathan, 'battlefield', { counters: { lore: 0 } }], [BEARS, 'battlefield'], ...library, ...library])
    const one = run(start, { type: 'counter', iid: 'c0', counter: 'lore', by: 1 }, pass)
    expect([zone(one, 'c1'), zone(one, 'c0')]).toEqual(['hand', 'battlefield'])
    const two = run(one, { type: 'counter', iid: 'c0', counter: 'lore', by: 1 }, pass)
    const before = inZone(two, 'hand').length
    const attacked = run({ ...two, step: 'combatAttackers', pending: { kind: 'attack', options: ['c0'] } }, { type: 'attack', iids: ['c0'] }, pass)
    expect(inZone(attacked, 'hand')).toHaveLength(before + 1)
    // Only for the turn.
    const later = onTo(attacked, 'upkeep')
    expect(later.untilEnd).toEqual([])
  })

  it('waterbends: artifacts and creatures help pay, and a spell is cast for nothing', () => {
    const yue = card('Yue, the Moon Spirit', 'Legendary Creature — Spirit Ally', {
      power: '3', toughness: '3', keywords: ['Flying', 'Vigilance', 'Waterbend'],
      oracle_text: 'Flying, vigilance\nWaterbend {5}, {T}: You may cast a noncreature spell from your hand without paying its mana cost. (While paying a waterbend cost, you can tap your artifacts and creatures to help. Each one pays for {1}.)',
    })
    const relic = card('Relic', 'Artifact')
    const bolt = card('Big Spell', 'Sorcery', { mana_cost: '{7}{R}', oracle_text: 'Draw three cards.' })
    expect(compile(yue).coverage).toBe('auto')
    const start = ruled([[yue, 'battlefield'], ...lands(FOREST, 2), [relic, 'battlefield'], [relic, 'battlefield'], [BEARS, 'battlefield'], [bolt, 'hand'], [giant, 'hand'], ...library])
    const asked = run(start, { type: 'activate', iid: 'c0', index: 0 }, pass)
    // Two lands, two artifacts and a creature make five; Yue taps for the cost.
    expect(asked.cards.filter((c) => c.zone === 'battlefield' && c.tapped)).toHaveLength(6)
    expect(asked.pending).toMatchObject({ kind: 'pick', zone: 'hand', options: ['c6'] })
    const done = run(asked, { type: 'choose', iids: ['c6'] }, pass)
    expect(inZone(done, 'hand').length).toBe(4)
  })
})
