import { describe, expect, it } from 'vitest'

import type { Card } from '../lib/api'
import { playable } from './cast'
import { compile } from './compiler/compile'
import { reduce } from './reducer'
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
const no: Action = { type: 'confirm', yes: false }
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
const elf = card('Elvish Visionary', 'Creature — Elf Shaman', { mana_cost: '{1}{G}', cmc: 2, power: '1', toughness: '1' })
const giant = card('Hill Giant', 'Creature — Giant', { mana_cost: '{3}{R}', cmc: 4, power: '3', toughness: '3' })

describe('playing a card from exile', () => {
  const construct = permanent('Containment Construct', 'Whenever you discard a card, you may exile that card from your graveyard. If you do, you may play that card this turn.', 'Artifact Creature — Construct', { power: '2', toughness: '1' })

  it('lets a discarded card be played this turn, and no later', () => {
    expect(compile(construct).coverage).toBe('auto')
    const start = ruled([[construct, 'battlefield'], [BEARS, 'hand'], ...forests, ...library])
    const exiled = run(start, { type: 'move', iid: 'c1', zone: 'graveyard' }, pass, yes)
    expect(zone(exiled, 'c1')).toBe('exile')
    expect(playable(exiled).has('c1')).toBe(true)
    const played = run(exiled, cast('c1'), pass)
    expect(zone(played, 'c1')).toBe('battlefield')
    // Left where it is, the turn ends and so does the permission.
    const later = onTo(exiled, 'main1')
    expect(zone(later, 'c1')).toBe('exile')
    expect(playable(later).has('c1')).toBe(false)
    expect(reduce(later, cast('c1'))).toBe(later)
  })

  it('plays a land from exile as the turn\'s land', () => {
    const start = ruled([[construct, 'battlefield'], [FOREST, 'hand'], ...library])
    const exiled = run(start, { type: 'move', iid: 'c1', zone: 'graveyard' }, pass, yes)
    const played = reduce(exiled, cast('c1'))
    expect(zone(played, 'c1')).toBe('battlefield')
    expect(played.landsPlayed).toBe(1)
  })

  it('leaves the card in the graveyard when the exile is declined', () => {
    const start = ruled([[construct, 'battlefield'], [BEARS, 'hand'], ...forests, ...library])
    const left = run(start, { type: 'move', iid: 'c1', zone: 'graveyard' }, pass, no)
    expect(zone(left, 'c1')).toBe('graveyard')
    expect(playable(left).has('c1')).toBe(false)
  })

  it('keeps the permission through the end of your next turn', () => {
    const moonstone = permanent('Moonstone, Harsh Mistress', 'Flying\nWhenever you discard a card, you may exile that card from your graveyard. If you do, until the end of your next turn, you may play that card.', 'Legendary Creature — Human Doctor Villain', { power: '2', toughness: '4', keywords: ['Flying'] })
    expect(compile(moonstone).coverage).toBe('auto')
    const start = ruled([[moonstone, 'battlefield'], [BEARS, 'hand'], ...forests, ...library, ...library])
    const exiled = run(start, { type: 'move', iid: 'c1', zone: 'graveyard' }, pass, yes)
    const next = onTo(exiled, 'main1')
    expect(playable(next).has('c1')).toBe(true)
    expect(playable(onTo(next, 'main1')).has('c1')).toBe(false)
  })

  it('exiles the top card to be played for nothing, for as long as it stays there', () => {
    const extract = spell('Extract Power', "Look at the top card of each player's library, then exile those cards face down. You may play them without paying their mana costs for as long as they remain exiled.", '{G}')
    expect(compile(extract).coverage).toBe('auto')
    const start = ruled([[extract, 'hand'], [FOREST, 'battlefield'], [giant, 'library'], ...library])
    const done = run(start, cast('c0'), pass)
    expect(at(done, 'c2')).toMatchObject({ zone: 'exile', mayPlay: { through: null, free: true } })
    // Nothing left untapped, and it is cast all the same — next turn too.
    const later = onTo(done, 'main1')
    const played = run(later, { type: 'tap', iid: 'c1' }, cast('c2'), pass)
    expect(zone(played, 'c2')).toBe('battlefield')
  })
})

describe('casting without paying', () => {
  it('casts the revealed creature if it shares a type with one of yours, and bottoms it if not', () => {
    const path = permanent("Descendants' Path", "At the beginning of your upkeep, reveal the top card of your library. If it's a creature card that shares a creature type with a creature you control, you may cast it without paying its mana cost. If you don't cast it, put it on the bottom of your library.")
    expect(compile(path).coverage).toBe('auto')
    const start = ruled([[path, 'battlefield'], [ELVES, 'battlefield'], [elf, 'library'], ...library])
    const asked = run(onTo(start, 'upkeep'), pass)
    expect(asked.pending).toMatchObject({ kind: 'confirm' })
    const taken = run(asked, yes)
    expect(zone(taken, 'c2')).toBe('stack')
    expect(zone(run(taken, pass), 'c2')).toBe('battlefield')
    const declined = run(asked, no)
    expect(declined.cards[declined.cards.length - 1].iid).toBe('c2')
    // A Giant shares nothing with an Elf.
    const other = run(onTo(ruled([[path, 'battlefield'], [ELVES, 'battlefield'], [giant, 'library'], ...library]), 'upkeep'), pass)
    expect(other.pending).toBeNull()
    expect(other.cards[other.cards.length - 1].iid).toBe('c2')
  })

  it('casts the top card after a scry, once each turn', () => {
    const planetarium = permanent('Planetarium of Wan Shi Tong', '{1}, {T}: Scry 2.\nWhenever you scry or surveil, look at the top card of your library. You may cast that card without paying its mana cost. Do this only once each turn. (Look at the card after you scry or surveil.)', 'Legendary Artifact')
    const scryer = permanent('Crystal Ball', '{0}: Scry 1.', 'Artifact')
    expect(compile(planetarium).coverage).toBe('auto')
    const start = ruled([[planetarium, 'battlefield'], [scryer, 'battlefield'], [giant, 'library'], [BEARS, 'library'], ...library])
    const scried = run(start, { type: 'activate', iid: 'c1', index: 0 }, pass, { type: 'arrange', keep: ['c2'], away: [] }, pass)
    expect(scried.pending).toMatchObject({ kind: 'confirm' })
    const taken = run(scried, yes, pass)
    expect(zone(taken, 'c2')).toBe('battlefield')
    // A second scry looks, and offers nothing.
    const again = run(taken, { type: 'activate', iid: 'c1', index: 0 }, pass, { type: 'arrange', keep: ['c3'], away: [] }, pass)
    expect(again.pending).toBeNull()
    expect(zone(again, 'c3')).toBe('library')
    // Turned down, the offer is still there for the next scry.
    const declined = run(scried, no, { type: 'activate', iid: 'c1', index: 0 }, pass, { type: 'arrange', keep: ['c2'], away: [] }, pass)
    expect(declined.pending).toMatchObject({ kind: 'confirm' })
  })

  it('casts a cheap spell from hand for nothing', () => {
    const expertise = spell("Kari Zev's Expertise", 'Gain control of target creature or Vehicle until end of turn. Untap it. It gains haste until end of turn.\nYou may cast a spell with mana value 2 or less from your hand without paying its mana cost.', '{G}')
    expect(compile(expertise).coverage).toBe('auto')
    const start = ruled([[expertise, 'hand'], [FOREST, 'battlefield'], [elf, 'hand'], [giant, 'hand'], [FOREST, 'hand'], ...library])
    // Nothing to take control of; the second line is its own.
    const asked = run(start, cast('c0'), pass)
    expect(asked.pending).toMatchObject({ kind: 'pick', zone: 'hand', options: ['c2'], min: 0, max: 1 })
    const done = run(asked, { type: 'choose', iids: ['c2'] })
    expect(zone(done, 'c2')).toBe('stack')
    expect(zone(done, 'c0')).toBe('graveyard')
    expect(zone(run(done, pass), 'c2')).toBe('battlefield')
  })

  it('exiles four, casts what you like of them, and takes the rest', () => {
    const purpose = permanent('Glorious Purpose', 'Whenever a creature you control connives, put a +1/+1 counter on that creature and a plan counter on this enchantment.\nWhen the sixth plan counter is put on this enchantment, sacrifice it. If you do, exile the top four cards of your library. You may cast any number of spells from among them without paying their mana costs. Put the rest into your hand.', 'Enchantment — Plan')
    expect(compile(purpose).coverage).toBe('auto')
    const start = ruled([[purpose, 'battlefield', { counters: { plan: 5 } }], [giant, 'library'], [FOREST, 'library'], [BEARS, 'library'], [elf, 'library'], ...library])
    const asked = run(start, { type: 'counter', iid: 'c0', counter: 'plan', by: 1 }, pass)
    expect(zone(asked, 'c0')).toBe('graveyard')
    expect(asked.pending).toMatchObject({ kind: 'pick', options: ['c1', 'c3', 'c4'], min: 0, max: 3 })
    const done = run(asked, { type: 'choose', iids: ['c1', 'c3'] })
    expect([zone(done, 'c1'), zone(done, 'c3')]).toEqual(['stack', 'stack'])
    expect([zone(done, 'c2'), zone(done, 'c4')]).toEqual(['hand', 'hand'])
  })
})

describe('playing from the top of the library', () => {
  const multiverse = permanent('One with the Multiverse', 'You may look at the top card of your library any time.\nYou may play lands and cast spells from the top of your library.\nOnce during each of your turns, you may cast a spell from your hand or the top of your library without paying its mana cost.')

  it('plays lands and casts spells from the top', () => {
    expect(compile(multiverse).coverage).toBe('auto')
    const start = ruled([[multiverse, 'battlefield'], [FOREST, 'library'], [GROWTH, 'library'], [BEARS, 'library'], ...library])
    expect(playable(start).has('c1')).toBe(true)
    expect(playable(start).has('c2')).toBe(false)
    const landed = reduce(start, cast('c1'))
    expect(zone(landed, 'c1')).toBe('battlefield')
    // The next card is the top now: asked whether it is the turn's free one.
    const asked = reduce(landed, cast('c2'))
    expect(asked.pending).toMatchObject({ kind: 'confirm' })
    const paid = run(asked, no)
    expect(zone(paid, 'c2')).toBe('stack')
    expect(at(paid, 'c1').tapped).toBe(true)
  })

  it('casts one spell a turn for nothing', () => {
    const start = ruled([[multiverse, 'battlefield'], [giant, 'hand'], [BEARS, 'hand'], ...library])
    expect(playable(start).has('c1')).toBe(true)
    const free = run(start, cast('c1'), yes)
    expect(zone(free, 'c1')).toBe('stack')
    // That was the one: the next is paid for, and there is nothing to pay with.
    const after = run(free, pass)
    expect(playable(after).has('c2')).toBe(false)
    expect(reduce(after, cast('c2'))).toBe(after)
    expect(playable(onTo(after, 'main1')).has('c2')).toBe(true)
  })

  it('casts creatures of the chosen type from the top, and nothing else', () => {
    const realmwalker = permanent('Realmwalker', 'Changeling (This card is every creature type.)\nAs this creature enters, choose a creature type.\nYou may look at the top card of your library any time.\nYou may cast creature spells of the chosen type from the top of your library.', 'Creature — Shapeshifter', { power: '2', toughness: '3', keywords: ['Changeling'] })
    expect(compile(realmwalker).coverage).toBe('auto')
    const board: [Card, Zone, Partial<Instance>?][] = [[realmwalker, 'battlefield', { chosenType: 'Elf' }], ...forests]
    expect(playable(ruled([...board, [elf, 'library'], ...library])).has('c4')).toBe(true)
    expect(playable(ruled([...board, [BEARS, 'library'], ...library])).has('c4')).toBe(false)
    expect(playable(ruled([...board, [FOREST, 'library'], ...library])).has('c4')).toBe(false)
  })
})

describe('a side chosen as it enters', () => {
  const siege = permanent('Outpost Siege', 'As this enchantment enters, choose Khans or Dragons.\n• Khans — At the beginning of your upkeep, exile the top card of your library. Until end of turn, you may play that card.\n• Dragons — Whenever a creature you control leaves the battlefield, this enchantment deals 1 damage to any target.', 'Enchantment', { mana_cost: '{G}' })

  it('asks which, and does only that side\'s', () => {
    expect(compile(siege).coverage).toBe('auto')
    const start = ruled([[siege, 'hand'], [FOREST, 'battlefield'], [BEARS, 'battlefield'], [giant, 'library'], ...library])
    const asked = run(start, cast('c0'), pass)
    expect(asked.pending).toMatchObject({ kind: 'type', iid: 'c0', options: ['Khans', 'Dragons'], side: true })
    const khans = run(asked, { type: 'pickType', subtype: 'Khans' })
    expect(at(khans, 'c0').chosenMode).toBe('Khans')
    // No damage for a creature leaving: that is the other side.
    const left = run(khans, { type: 'move', iid: 'c2', zone: 'graveyard' })
    expect(left.stack).toHaveLength(0)
    const upkeep = run(onTo(left, 'upkeep'), pass)
    expect(at(upkeep, 'c3')).toMatchObject({ zone: 'exile', mayPlay: { through: upkeep.turn } })
  })

  it('deals damage as a creature leaves, on the other side', () => {
    const start = ruled([[siege, 'battlefield', { chosenMode: 'Dragons' }], [BEARS, 'battlefield'], ...library])
    const done = run(start, { type: 'move', iid: 'c1', zone: 'graveyard' }, pass)
    expect(done.opponent.life).toBe(39)
    expect(run(onTo(done, 'upkeep')).stack).toHaveLength(0)
  })
})

describe('cards exiled with a permanent', () => {
  it('turns an exiled card into a Treasure or a Rogue', () => {
    const converter = permanent('Currency Converter', "Whenever you discard a card, you may exile that card from your graveyard.\n{2}, {T}: Draw a card, then discard a card.\n{T}: Put a card exiled with this artifact into its owner's graveyard. If it's a land card, create a Treasure token. If it's a nonland card, create a 2/2 black Rogue creature token.", 'Artifact')
    expect(compile(converter).coverage).toBe('auto')
    const start = ruled([[converter, 'battlefield'], [FOREST, 'hand'], [BEARS, 'hand'], ...library])
    const land = run(start, { type: 'move', iid: 'c1', zone: 'graveyard' }, pass, yes)
    expect(at(land, 'c1')).toMatchObject({ zone: 'exile', exiledBy: 'c0' })
    const treasure = run(land, { type: 'activate', iid: 'c0', index: 1 }, pass)
    expect(zone(treasure, 'c1')).toBe('graveyard')
    expect(tokens(treasure).map((c) => c.card.name)).toEqual(['Treasure'])
    const spellCard = run(start, { type: 'move', iid: 'c2', zone: 'graveyard' }, pass, yes, { type: 'activate', iid: 'c0', index: 1 }, pass)
    expect(tokens(spellCard).map((c) => c.card.name)).toEqual(['Rogue'])
  })

  it('imprints a dead creature, and copies it for a turn', () => {
    const vat = permanent('Mimic Vat', "Imprint — Whenever a nontoken creature dies, you may exile that card. If you do, return each other card exiled with this artifact to its owner's graveyard.\n{3}, {T}: Create a token that's a copy of a card exiled with this artifact. It gains haste. Exile it at the beginning of the next end step.", 'Artifact')
    expect(compile(vat).coverage).toBe('auto')
    const start = ruled([[vat, 'battlefield'], [BEARS, 'battlefield'], [giant, 'battlefield'], ...forests, ...library])
    const first = run(start, { type: 'move', iid: 'c1', zone: 'graveyard' }, pass, yes)
    expect(at(first, 'c1')).toMatchObject({ zone: 'exile', exiledBy: 'c0' })
    const copied = run(first, { type: 'activate', iid: 'c0', index: 0 }, pass)
    expect(tokens(copied).map((c) => c.card.name)).toEqual(['Grizzly Bears'])
    // The next one takes its place.
    const second = run(first, { type: 'move', iid: 'c2', zone: 'graveyard' }, pass, yes)
    expect([zone(second, 'c1'), zone(second, 'c2')]).toEqual(['graveyard', 'exile'])
  })

  it('returns three exiled creatures when the urn is sacrificed', () => {
    const urn = permanent("Colfenor's Urn", "Whenever a creature with toughness 4 or greater is put into your graveyard from the battlefield, you may exile it.\nAt the beginning of the end step, if three or more cards have been exiled with this artifact, sacrifice it. If you do, return those cards to the battlefield under their owner's control.", 'Artifact')
    expect(compile(urn).coverage).toBe('auto')
    const wall = card('Wall of Stone', 'Creature — Wall', { power: '0', toughness: '8' })
    const exiled: Partial<Instance> = { exiledBy: 'c0' }
    const start = ruled([[urn, 'battlefield'], [wall, 'battlefield'], [wall, 'exile', exiled], [wall, 'exile', exiled], [BEARS, 'battlefield'], ...library])
    // Too small to be kept.
    expect(run(start, { type: 'move', iid: 'c4', zone: 'graveyard' }).stack).toHaveLength(0)
    const third = run(start, { type: 'move', iid: 'c1', zone: 'graveyard' }, pass, yes)
    expect(at(third, 'c1')).toMatchObject({ zone: 'exile', exiledBy: 'c0' })
    const end = run(onTo(third, 'end'), pass)
    expect(zone(end, 'c0')).toBe('graveyard')
    expect(['c1', 'c2', 'c3'].map((iid) => zone(end, iid))).toEqual(['battlefield', 'battlefield', 'battlefield'])
  })
})
