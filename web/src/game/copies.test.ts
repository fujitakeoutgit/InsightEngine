import { describe, expect, it } from 'vitest'

import type { Card } from '../lib/api'
import { compile } from './compiler/compile'
import { readAbility } from './compiler/effects'
import { reduce } from './reducer'
import { hasKeyword, power } from './stats'
import { BEARS, card, FOREST, game, OMENS, PLAINS } from './testing'
import type { Action, GameState, Instance, Zone } from './types'

const ruled = (placed: [Card, Zone, Partial<Instance>?][], extra: Partial<GameState> = {}) =>
  game(placed, { rules: true, ...extra })
const run = (state: GameState, ...actions: Action[]) => actions.reduce(reduce, state)
const at = (state: GameState, iid: string) => state.cards.find((c) => c.iid === iid)!
const tokens = (state: GameState) => state.cards.filter((c) => c.token)
const pass: Action = { type: 'pass' }
const cast = (iid: string): Action => ({ type: 'play', iid })
const forests: [Card, Zone][] = [[FOREST, 'battlefield'], [FOREST, 'battlefield'], [FOREST, 'battlefield']]
const library: [Card, Zone][] = [[PLAINS, 'library'], [PLAINS, 'library'], [PLAINS, 'library']]

describe('a token that is a copy', () => {
  it('reads what is copied, what changes, and how long it lasts', () => {
    expect(readAbility("Create a token that's a copy of that creature. That token gains haste. Exile it at the beginning of the next end step.", { kind: 'event' })).toMatchObject({
      complete: true,
      effects: [{ op: 'copy', of: { kind: 'event' }, count: 1, change: { keywords: ['Haste'] }, fleeting: true }],
    })
    expect(readAbility("Create a token that's a copy of that creature, except it's a Spirit in addition to its other types and it isn't legendary.", { kind: 'event' })).toMatchObject({
      complete: true,
      effects: [{ op: 'copy', change: { types: ['Spirit'], notLegendary: true }, fleeting: false }],
    })
  })

  const conjuring = card('Flameshadow Conjuring', 'Enchantment', {
    oracle_text: "Whenever a nontoken creature you control enters, you may pay {R}. If you do, create a token that's a copy of that creature. That token gains haste. Exile it at the beginning of the next end step.",
  })
  const mountain = card('Mountain', 'Basic Land — Mountain')
  // Double green, so the Mountain is what is left to pay {R} with.
  const cub = card('Runeclaw Cub', 'Creature — Bear', { mana_cost: '{G}{G}', power: '2', toughness: '2' })

  it('copies the creature that entered, with haste, until the end step', () => {
    expect(compile(conjuring).coverage).toBe('auto')
    const start = ruled([[cub, 'hand'], [FOREST, 'battlefield'], [FOREST, 'battlefield'], [mountain, 'battlefield'], [conjuring, 'battlefield'], ...library])
    const copied = run(start, cast('c0'), pass, pass, { type: 'confirm', yes: true })
    const [token] = tokens(copied)
    expect(token.card).toMatchObject({ name: 'Runeclaw Cub', power: '2', toughness: '2', type_line: 'Creature — Bear' })
    expect(token).toMatchObject({ zone: 'battlefield', fleeting: true })
    expect(hasKeyword(token, 'Haste', copied)).toBe(true)
    // A token entering does not set the Conjuring off again.
    expect(copied.stack).toEqual([])
    // The hasty token could attack; it does not, and the turn runs on.
    const ended = run(copied, { type: 'passTo', step: 'end' }, { type: 'attack', iids: [] }, { type: 'passTo', step: 'end' })
    expect(ended.step).toBe('end')
    expect(tokens(ended)).toEqual([])
    expect(at(ended, 'c0').zone).toBe('battlefield')
  })

  it('copies what a creature was when it died, as a Spirit', () => {
    const hofri = card('Hofri', 'Legendary Creature — Dwarf Cleric', {
      power: '4', toughness: '5',
      oracle_text: 'Whenever another nontoken creature you control dies, exile it. If you do, create a token that\'s a copy of that creature, except it\'s a Spirit in addition to its other types and it has "When this token leaves the battlefield, return the exiled card to its owner\'s graveyard."',
    })
    expect(compile(hofri).coverage).toBe('auto')
    const done = run(ruled([[hofri, 'battlefield'], [BEARS, 'battlefield']]), { type: 'move', iid: 'c1', zone: 'graveyard' }, pass)
    expect(at(done, 'c1').zone).toBe('exile')
    const [spirit] = tokens(done)
    expect(spirit.card.type_line).toBe('Creature — Bear Spirit')
    expect(spirit.card.oracle_text).toContain('leaves the battlefield')
  })

  it('copies a creature card out of the graveyard', () => {
    const seance = card('Seance', 'Enchantment', {
      oracle_text: "At the beginning of each upkeep, you may exile target creature card from your graveyard. If you do, create a token that's a copy of that card, except it's a Spirit in addition to its other types. Exile it at the beginning of the next end step.",
    })
    expect(compile(seance).coverage).toBe('auto')
    const start = ruled([[seance, 'battlefield'], [BEARS, 'graveyard'], ...library], { step: 'cleanup' })
    const asked = run(start, pass, pass, { type: 'confirm', yes: true })
    expect(asked.pending).toMatchObject({ kind: 'pick', zone: 'graveyard', options: ['c1'] })
    const done = reduce(asked, { type: 'choose', iids: ['c1'] })
    expect(at(done, 'c1').zone).toBe('exile')
    expect(tokens(done)[0]).toMatchObject({ fleeting: true, card: { name: 'Grizzly Bears', type_line: 'Creature — Bear Spirit' } })
  })
})

describe('a creature that enters as a copy', () => {
  const clone = card('Clone', 'Creature — Shapeshifter', {
    mana_cost: '{G}', power: '0', toughness: '0',
    oracle_text: 'You may have Clone enter as a copy of any creature on the battlefield.',
  })
  const lord = card('Lord', 'Creature — Elf', {
    power: '2', toughness: '2', oracle_text: 'Other Elf creatures you control get +1/+1.',
  })

  it('asks what to copy as it resolves, and becomes it', () => {
    expect(compile(clone).coverage).toBe('auto')
    const asked = run(ruled([[clone, 'hand'], ...forests, [BEARS, 'battlefield'], [OMENS, 'battlefield'], ...library]), cast('c0'), pass)
    expect(asked.pending).toMatchObject({ kind: 'pick', zone: 'battlefield', options: ['c4', 'c5'], min: 0, max: 1 })
    const copied = reduce(asked, { type: 'choose', iids: ['c5'] })
    expect(at(copied, 'c0')).toMatchObject({ zone: 'battlefield', card: { name: 'Wall of Omens' } })
    // It entered as Wall of Omens, so it has Wall of Omens' arrival.
    expect(copied.stack).toHaveLength(1)
    expect(copied.stack[0].ability?.text).toBe('When Wall of Omens enters, draw a card.')
  })

  it('has what it copied\'s abilities for as long as it stays', () => {
    const copied = run(ruled([[clone, 'hand'], ...forests, [lord, 'battlefield']]), cast('c0'), pass, { type: 'choose', iids: ['c4'] })
    // Two lords, each making the other 3/3.
    expect(power(at(copied, 'c0'), copied)).toBe(3)
    expect(power(at(copied, 'c4'), copied)).toBe(3)
  })

  it('is itself again once it leaves', () => {
    const copied = run(ruled([[clone, 'hand'], ...forests, [BEARS, 'battlefield']]), cast('c0'), pass, { type: 'choose', iids: ['c4'] })
    const gone = reduce(copied, { type: 'move', iid: 'c0', zone: 'hand' })
    expect(at(gone, 'c0').card.name).toBe('Clone')
    expect(at(gone, 'c0').original).toBeUndefined()
  })

  it('may copy nothing, and then it is what it is — a 0/0', () => {
    const plain = run(ruled([[clone, 'hand'], ...forests, [BEARS, 'battlefield']]), cast('c0'), pass, { type: 'choose', iids: [] })
    expect(at(plain, 'c0').zone).toBe('graveyard')
    expect(plain.log).toContain('Clone dies — toughness 0')
  })

  it('reads the exceptions it can keep', () => {
    const image = card('Phantasmal Image', 'Creature — Illusion', {
      oracle_text: 'You may have Phantasmal Image enter as a copy of any creature on the battlefield, except it\'s an Illusion in addition to its other types and it has "When this creature becomes the target of a spell or ability, sacrifice it."',
    })
    expect(compile(image).statics).toMatchObject([{
      kind: 'enterAsCopy', filter: { types: ['creature'] },
      change: { types: ['Illusion'], text: expect.stringContaining('becomes the target') },
    }])
    const double = card('Spark Double', 'Creature — Illusion', {
      mana_cost: '{G}', power: '0', toughness: '0',
      oracle_text: "You may have Spark Double enter as a copy of a creature or planeswalker you control, except it enters with an additional +1/+1 counter on it if it's a creature, it enters with an additional loyalty counter on it if it's a planeswalker, and it isn't legendary.",
    })
    const legend = card('Old King', 'Legendary Creature — Human Noble', { power: '3', toughness: '3' })
    const copied = run(ruled([[double, 'hand'], ...forests, [legend, 'battlefield']]), cast('c0'), pass, { type: 'choose', iids: ['c4'] })
    expect(at(copied, 'c0')).toMatchObject({ counters: { '+1/+1': 1 }, card: { name: 'Old King', type_line: 'Creature — Human Noble' } })
  })

  it('copies a land as the land is played', () => {
    const vesuva = card('Vesuva', 'Land', { oracle_text: 'You may have Vesuva enter tapped as a copy of any land on the battlefield.' })
    const asked = run(ruled([[vesuva, 'hand'], [FOREST, 'battlefield']]), cast('c0'))
    expect(asked.pending).toMatchObject({ kind: 'pick', options: ['c1'] })
    const done = reduce(asked, { type: 'choose', iids: ['c1'] })
    expect(at(done, 'c0')).toMatchObject({ zone: 'battlefield', tapped: true, card: { name: 'Forest' } })
    expect(done.landsPlayed).toBe(1)
  })
})
