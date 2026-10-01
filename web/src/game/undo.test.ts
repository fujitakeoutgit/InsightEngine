import { describe, expect, it } from 'vitest'

import { FOREST, PLAINS } from './testing'
import type { GameState } from './types'
import { freshTable, reduceTable, UNDO_LIMIT } from './undo'

const game: GameState = {
  cards: [
    { iid: 'a', card: FOREST, zone: 'library', tapped: false, x: 0.5, y: 0.5 },
    { iid: 'b', card: PLAINS, zone: 'library', tapped: false, x: 0.5, y: 0.5 },
  ],
  turn: 1, life: 40, log: [], drawn: [], seed: 7, serial: 0,
}

describe('undo', () => {
  it('takes back the last action', () => {
    const start = freshTable(game)
    const drawn = reduceTable(start, { type: 'draw' })
    expect(drawn.past).toEqual([game])
    const undone = reduceTable(drawn, { type: 'undo' })
    expect(undone.game).toBe(game)
    expect(undone.past).toEqual([])
  })

  it('does nothing with nothing to undo', () => {
    const start = freshTable(game)
    expect(reduceTable(start, { type: 'undo' })).toBe(start)
  })

  it('records no step for an action that changed nothing', () => {
    const start = freshTable(game)
    expect(reduceTable(start, { type: 'tap', iid: 'missing' })).toBe(start)
  })

  it('lets a note ride along without becoming a step', () => {
    const drawn = reduceTable(freshTable(game), { type: 'draw' })
    const noted = reduceTable(drawn, { type: 'note', line: 'Rolled a 4' })
    expect(noted.past).toBe(drawn.past)
    expect(noted.game.log[0]).toBe('Rolled a 4')
  })

  it('replays a shuffle exactly after undoing it', () => {
    const start = freshTable(game)
    const once = reduceTable(start, { type: 'shuffle' })
    const again = reduceTable(reduceTable(once, { type: 'undo' }), { type: 'shuffle' })
    expect(again.game.cards).toEqual(once.game.cards)
  })

  it(`remembers at most ${UNDO_LIMIT} steps`, () => {
    let table = freshTable(game)
    for (let i = 0; i < UNDO_LIMIT + 5; i += 1) table = reduceTable(table, { type: 'life', by: -1 })
    expect(table.past).toHaveLength(UNDO_LIMIT)
    expect(table.past[0].life).toBe(35)
  })
})
