/**
 * Undo, which immutable state makes almost free: every action produces a new
 * game and leaves the old one untouched, so taking something back is handing
 * the old one back. Unchanged cards are shared between the states, so two
 * hundred of them cost little more than one.
 */

import { autoPass, MOVES } from './auto'
import { reduce } from './reducer'
import type { Action, GameState } from './types'

/** How far back undo reaches. */
export const UNDO_LIMIT = 200

/** The game, and the games it was before each of your actions. */
export interface Table {
  game: GameState
  /** Oldest first. */
  past: GameState[]
  /** Auto: the stack resolves without asking, even where you could respond.
   *  Off — Manual — it waits for you then. The table's, not the game's: it
   *  is how you are playing, so undo and a new deal leave it as it is. */
  auto: boolean
}

export type TableAction = Action | { type: 'undo' } | { type: 'auto'; on: boolean }

export function freshTable(game: GameState, auto = false): Table {
  return { game, past: [], auto }
}

export function reduceTable(table: Table, action: TableAction): Table {
  if (action.type === 'undo') {
    if (!table.past.length) return table
    return { ...table, game: table.past[table.past.length - 1], past: table.past.slice(0, -1) }
  }
  if (action.type === 'auto') {
    if (action.on === Boolean(table.auto)) return table
    // Switched on with something waiting on the stack: it resolves now, and
    // that — not the switch — is the step undo takes back.
    const game = action.on ? autoPass(table.game, true) : table.game
    return game === table.game
      ? { ...table, auto: action.on }
      : { game, past: [...table.past, table.game].slice(-UNDO_LIMIT), auto: action.on }
  }
  const moved = reduce(table.game, action)
  if (moved === table.game) return table
  // After a move of yours the game plays on for as long as there is nothing
  // to decide: one action to you, and one step for undo to take back.
  const game = MOVES.has(action.type) ? autoPass(moved, Boolean(table.auto)) : moved
  /* A note records something that is not part of the game — a die rolled,
   * the coin flipped — so it is not a step undo walks back through. It rides
   * along on the current state, and goes with it. */
  if (action.type === 'note') return { ...table, game }
  return { ...table, game, past: [...table.past, table.game].slice(-UNDO_LIMIT) }
}
