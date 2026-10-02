import { describe, expect, it } from 'vitest'

import type { Card } from '../lib/api'
import { abilitiesOf } from './activate'
import { castWays } from './cast'
import { compile } from './compiler/compile'
import { reduce } from './reducer'
import { power } from './stats'
import { BEARS, card, FOREST, game, PLAINS } from './testing'
import type { Action, GameState, Instance, Zone } from './types'

const ruled = (placed: [Card, Zone, Partial<Instance>?][], extra: Partial<GameState> = {}) =>
  game(placed, { rules: true, ...extra })
const run = (state: GameState, ...actions: Action[]) => actions.reduce(reduce, state)
const at = (state: GameState, iid: string) => state.cards.find((c) => c.iid === iid)!
const keys = (state: GameState, iid: string) => castWays(state, at(state, iid)).map((way) => way.key)
const inZone = (state: GameState, zone: Zone) => state.cards.filter((c) => c.zone === zone && !c.mergedInto).map((c) => c.iid)
const pass: Action = { type: 'pass' }
const cast = (iid: string): Action => ({ type: 'play', iid })
const by = (way: string): Action => ({ type: 'cast', way })
const island = card('Island', 'Basic Land — Island')
const lands: [Card, Zone][] = [[FOREST, 'battlefield'], [island, 'battlefield'], [FOREST, 'battlefield'], [island, 'battlefield']]
const library: [Card, Zone][] = [[PLAINS, 'library'], [PLAINS, 'library'], [PLAINS, 'library']]

const beast = card('Parcelbeast', 'Creature — Elemental Beast', {
  mana_cost: '{2}{G}{U}', power: '2', toughness: '4', keywords: ['Mutate'],
  oracle_text: "Mutate {G}{U} (If you cast this spell for its mutate cost, put it over or under target non-Human creature you own. They mutate into the creature on top plus all abilities from under it.)\n{1}, {T}: Look at the top card of your library. If it's a land card, you may put it onto the battlefield. If you don't put the card onto the battlefield, put it into your hand.",
})
const serpent = card('Aesi, Tyrant of Gyre Strait', 'Legendary Creature — Serpent', {
  power: '5', toughness: '5',
  oracle_text: 'You may play an additional land on each of your turns.\nLandfall — Whenever a land you control enters, you may draw a card.',
})
const scout = card('Elvish Visionary', 'Creature — Elf Shaman', {
  power: '1', toughness: '1', oracle_text: 'When this creature enters, draw a card.',
})
const human = card('Town Guard', 'Creature — Human Soldier', { power: '1', toughness: '1' })

describe('mutate', () => {
  it('is read as a way to cast the card, with nothing set aside', () => {
    expect(compile(beast)).toMatchObject({ coverage: 'auto', skipped: [], ways: [{ kind: 'mutate', cost: '{G}{U}' }] })
  })

  it('is offered only with a non-Human creature of yours to go onto', () => {
    expect(keys(ruled([[beast, 'hand'], ...lands, [human, 'battlefield']]), 'c0')).toEqual(['normal'])
    expect(keys(ruled([[beast, 'hand'], ...lands, [BEARS, 'battlefield']]), 'c0')).toEqual(['normal', 'mutate'])
    // For its mutate cost alone, it is the only way.
    expect(keys(ruled([[beast, 'hand'], [FOREST, 'battlefield'], [island, 'battlefield'], [BEARS, 'battlefield']]), 'c0')).toEqual(['mutate'])
  })

  it('goes on top: the creature becomes it, and keeps what it had', () => {
    const start = ruled([[beast, 'hand'], ...lands, [scout, 'battlefield', { counters: { '+1/+1': 1 } }], ...library])
    const asked = run(start, cast('c0'), by('mutate'), pass)
    // One creature it could be: asked only whether over or under.
    expect(asked.pending).toMatchObject({ kind: 'mode' })
    const done = reduce(asked, { type: 'mode', index: 0 })
    expect(done.pending).toBeNull()
    const merged = at(done, 'c5')
    expect(merged).toMatchObject({ zone: 'battlefield', counters: { '+1/+1': 1 }, merged: ['c0'] })
    expect([merged.card.name, power(merged, done), Boolean(merged.sick)]).toEqual(['Parcelbeast', 3, false])
    // The same creature, not a new one: nothing entered, so nothing was drawn.
    expect(inZone(done, 'hand')).toEqual([])
    expect(inZone(done, 'battlefield')).toHaveLength(5)
    // Its own ability, and the text of what is under it.
    expect(abilitiesOf(merged)).toHaveLength(1)
    expect(merged.card.oracle_text).toContain('When this creature enters, draw a card.')
    expect(at(done, 'c0')).toMatchObject({ mergedInto: 'c5' })
  })

  it('goes underneath: the creature stays itself, with its abilities as well', () => {
    const start = ruled([[beast, 'hand'], ...lands, [serpent, 'battlefield', { commander: true }], ...library])
    const done = run(start, cast('c0'), by('mutate'), pass, { type: 'mode', index: 1 })
    const merged = at(done, 'c5')
    expect([merged.card.name, merged.card.type_line, power(merged, done), merged.commander]).toEqual(
      ['Aesi, Tyrant of Gyre Strait', 'Legendary Creature — Serpent', 5, true],
    )
    expect(abilitiesOf(merged).map((a) => a.cost.mana)).toEqual(['{1}'])
    // Still what it was: the landfall is still read.
    expect(compile(merged.card).triggers).toHaveLength(1)
  })

  it('asks which creature when there is more than one', () => {
    const start = ruled([[beast, 'hand'], ...lands, [BEARS, 'battlefield'], [scout, 'battlefield'], [human, 'battlefield'], ...library])
    const asked = run(start, cast('c0'), by('mutate'), pass)
    expect(asked.pending).toMatchObject({ kind: 'pick', options: ['c5', 'c6'] })
    const done = run(asked, { type: 'choose', iids: ['c6'] }, { type: 'mode', index: 0 })
    expect([at(done, 'c5').card.name, at(done, 'c6').card.name]).toEqual(['Grizzly Bears', 'Parcelbeast'])
  })

  it('comes apart when it leaves: both cards go, each itself again', () => {
    const start = ruled([[beast, 'hand'], ...lands, [BEARS, 'battlefield'], ...library])
    const merged = run(start, cast('c0'), by('mutate'), pass, { type: 'mode', index: 0 })
    const died = reduce(merged, { type: 'move', iid: 'c5', zone: 'graveyard' })
    expect(inZone(died, 'graveyard').sort()).toEqual(['c0', 'c5'])
    expect([at(died, 'c5').card.name, at(died, 'c0').card.name]).toEqual(['Grizzly Bears', 'Parcelbeast'])
    expect([at(died, 'c5').merged, at(died, 'c0').mergedInto]).toEqual([undefined, undefined])
    const bounced = reduce(merged, { type: 'move', iid: 'c5', zone: 'hand' })
    expect(inZone(bounced, 'hand').sort()).toEqual(['c0', 'c5'])
  })

  it('just arrives when the creature it was aimed at is gone', () => {
    const start = ruled([[beast, 'hand'], ...lands, [BEARS, 'battlefield'], ...library])
    const done = run(start, cast('c0'), by('mutate'), { type: 'move', iid: 'c5', zone: 'graveyard' }, pass)
    expect(done.pending).toBeNull()
    expect(at(done, 'c0')).toMatchObject({ zone: 'battlefield', sick: true })
    expect(at(done, 'c0').mergedInto).toBeUndefined()
  })

  it('is cast as printed the ordinary way', () => {
    const start = ruled([[beast, 'hand'], ...lands, [BEARS, 'battlefield'], ...library])
    const done = run(start, cast('c0'), by('normal'), pass)
    expect(at(done, 'c0')).toMatchObject({ zone: 'battlefield' })
    expect(at(done, 'c5').card.name).toBe('Grizzly Bears')
  })
})
