import { describe, expect, it } from 'vitest'

import type { Card } from '../lib/api'
import { autoPass, canAct } from './auto'
import { reduce } from './reducer'
import { BEARS, card, FOREST, game, GROWTH, PLAINS, RIDDLE } from './testing'
import type { GameState, Instance, Zone } from './types'
import { freshTable, reduceTable } from './undo'

const ruled = (placed: [Card, Zone, Partial<Instance>?][], extra: Partial<GameState> = {}) =>
  game(placed, { rules: true, ...extra })
const at = (state: GameState, iid: string) => state.cards.find((c) => c.iid === iid)!
const hand = (state: GameState) => state.cards.filter((c) => c.zone === 'hand').map((c) => c.iid)

/** A library of spells nothing can pay for: turns that have nothing in them. */
const dear = card('Colossus', 'Creature — Golem', { mana_cost: '{9}', power: '9', toughness: '9' })
const blanks = (n: number): [Card, Zone][] => Array.from({ length: n }, () => [dear, 'library'])
const forests = (n: number): [Card, Zone][] => Array.from({ length: n }, () => [FOREST, 'battlefield'])
const ring = card('Scrying Stone', 'Artifact', { oracle_text: '{1}, {T}: Scry 1.' })
const elf = card('Sitting Elf', 'Creature — Elf', { power: '1', toughness: '1', oracle_text: '{T}: Add {G}.' })

describe('whether there is anything to do', () => {
  it('counts a land to play, a spell to cast, an ability to use', () => {
    expect(canAct(ruled([[FOREST, 'hand']]))).toBe(true)
    expect(canAct(ruled([[BEARS, 'hand'], ...forests(2)]))).toBe(true)
    expect(canAct(ruled([[ring, 'battlefield'], ...forests(1)]))).toBe(true)
  })

  it('does not count what cannot be paid for, or mana that would only sit in the pool', () => {
    expect(canAct(ruled([[BEARS, 'hand'], ...forests(1)]))).toBe(false)
    expect(canAct(ruled([[ring, 'battlefield']]))).toBe(false)
    expect(canAct(ruled([[elf, 'battlefield'], ...forests(3)]))).toBe(false)
  })

  it('counts only what is fast enough while something is on the stack', () => {
    const waiting = reduce(ruled([[BEARS, 'hand'], [BEARS, 'hand'], [GROWTH, 'hand'], ...forests(5), ...blanks(3)]), { type: 'play', iid: 'c0' })
    expect(waiting.stack).toHaveLength(1)
    // The other Bears cannot be cast now; the Giant Growth can.
    expect(canAct(waiting)).toBe(true)
    const slow = reduce(ruled([[BEARS, 'hand'], [BEARS, 'hand'], ...forests(4), ...blanks(3)]), { type: 'play', iid: 'c0' })
    expect(canAct(slow)).toBe(false)
  })
})

describe('the stack, left to itself', () => {
  it('resolves what you could not respond to', () => {
    const cast = reduce(ruled([[BEARS, 'hand'], [BEARS, 'hand'], ...forests(4), ...blanks(3)]), { type: 'play', iid: 'c0' })
    const done = autoPass(cast)
    expect(at(done, 'c0').zone).toBe('battlefield')
    // And stops there: the second Bears can be cast.
    expect(done).toMatchObject({ stack: [], turn: 1, step: 'main1' })
  })

  it('waits while there is something you could do first', () => {
    const cast = reduce(ruled([[BEARS, 'hand'], [GROWTH, 'hand'], ...forests(3), ...blanks(3)]), { type: 'play', iid: 'c0' })
    expect(autoPass(cast)).toBe(cast)
  })

  it('stops at a question', () => {
    const omen = card('Omen', 'Sorcery', { mana_cost: '{G}', oracle_text: 'Scry 2.' })
    const cast = reduce(ruled([[omen, 'hand'], ...forests(1), ...blanks(4)]), { type: 'play', iid: 'c0' })
    expect(autoPass(cast).pending).toMatchObject({ kind: 'arrange' })
  })

  it('leaves a spell to be carried out by hand where it is', () => {
    const cast = reduce(ruled([[RIDDLE, 'hand'], ...forests(1), ...blanks(4)]), { type: 'play', iid: 'c0' })
    const done = autoPass(cast)
    // Resolved, and posted: the turn does not pass with that still to do.
    expect(done.reminders).toHaveLength(1)
    expect(done).toMatchObject({ stack: [], turn: 1, step: 'main1' })
  })
})

describe('a turn with nothing left in it', () => {
  it('passes, and the next one stops where there is something to do', () => {
    // Nothing in hand; the card drawn next turn is a land.
    const start = ruled([...forests(2), [FOREST, 'library'], ...blanks(3)])
    const next = autoPass(start)
    expect(next).toMatchObject({ turn: 2, step: 'main1', pending: null })
    expect(hand(next)).toEqual(['c2'])
    expect(next.log).toContain('Nothing left to do — the turn passes')
  })

  it('stops to ask about attackers on the way', () => {
    const start = ruled([[BEARS, 'battlefield'], ...forests(2), ...blanks(3)])
    const asked = autoPass(start)
    expect(asked).toMatchObject({ turn: 1, pending: { kind: 'attack', options: ['c0'] } })
    // The answer given, the rest of the turn goes by.
    const table = reduceTable(freshTable(asked), { type: 'attack', iids: ['c0'] })
    expect(table.game.opponent.life).toBe(38)
    expect(table.game.turn).toBeGreaterThan(1)
  })

  it('goes on through turns like it, until there is a discard to make', () => {
    const start = ruled([[dear, 'hand'], [dear, 'hand'], [dear, 'hand'], [dear, 'hand'], [dear, 'hand'], ...blanks(12)])
    const stopped = autoPass(start)
    // Five in hand and one more each turn after the first: eight by the end of turn four.
    expect(stopped).toMatchObject({ turn: 4, pending: { kind: 'discard', count: 1 } })
  })

  it('stays put with something to carry out by hand, with the game decided, or with the rules off', () => {
    const idle = ruled([...forests(2), ...blanks(3)])
    const posted = { ...idle, reminders: [{ id: 'r1', iid: 'c0', name: 'Forest', text: 'Do it.' }] }
    expect(autoPass(posted)).toBe(posted)
    const lost = { ...idle, lost: 'Your life reached 0 on turn 1' }
    expect(autoPass(lost)).toBe(lost)
    const free = game([...forests(2), ...blanks(3)])
    expect(autoPass(free)).toBe(free)
  })
})

describe('at the table', () => {
  it('plays on after a move of yours, and undo takes back the move and all that followed', () => {
    const start = freshTable(ruled([[BEARS, 'hand'], ...forests(2), [PLAINS, 'library'], ...blanks(3)]))
    const played = reduceTable(start, { type: 'play', iid: 'c0' })
    // Cast, resolved, nothing else to do, no attack from a creature that just arrived: next turn.
    expect(at(played.game, 'c0').zone).toBe('battlefield')
    expect(played.game).toMatchObject({ turn: 2, step: 'main1' })
    expect(reduceTable(played, { type: 'undo' }).game).toBe(start.game)
  })

  it('leaves the table alone when a card is only moved by hand, or a step is asked for by name', () => {
    const start = freshTable(ruled([[dear, 'hand'], ...forests(2), ...blanks(3)]))
    expect(reduceTable(start, { type: 'move', iid: 'c0', zone: 'graveyard' }).game.turn).toBe(1)
    expect(reduceTable(start, { type: 'passTo', step: 'end' }).game).toMatchObject({ turn: 1, step: 'end' })
  })
})
