/**
 * Playing on by itself.
 *
 * Passing priority is a decision only when there is another one to make
 * instead. With nothing you could cast, play or activate, the top of the
 * stack resolves without being told to, and a turn with nothing left in it
 * passes — and so does the next, if it is the same — until the game has
 * something to ask or you have something you could do.
 *
 * This sits on top of the rules rather than in them: `reduce` still takes one
 * step at a time, which is what the tests of the rules walk through, and the
 * table runs this after each of your moves.
 */

import { abilitiesOf, activationProblem, usedFrom } from './activate'
import { playable } from './cast'
import { pass } from './priority'
import { noted } from './state'
import type { Action, GameState } from './types'

/** Whether there is anything you could do right now, other than pass: a land
 *  to play, a spell you can pay for at this speed, an ability you can
 *  activate. Tapping for mana that would only sit in the pool is not one. */
export function canAct(state: GameState): boolean {
  if (playable(state).size) return true
  return state.cards.some((c) => abilitiesOf(c).some((ability, index) => (
    !ability.mana && usedFrom(ability) === c.zone && !activationProblem(state, c.iid, index)
  )))
}

/** Whether the game is yours to move at all: not while it is asking
 *  something, not once it is decided, and not with something posted for you
 *  to carry out by hand — that comes first. */
const idle = (state: GameState) =>
  state.rules && !state.pending && !state.resolving && !state.lost && !state.won && !state.reminders.length

/**
 * Pass for as long as passing is all there is to do.
 *
 * What is on the stack waits for you while there is something you could do
 * first — unless `eager`, the table's Auto setting, says not to ask: then it
 * resolves whatever you hold. A turn is never passed while you could still
 * act, either way; that is a different thing to give up.
 */
export function autoPass(state: GameState, eager = false): GameState {
  let next = state
  // Far more passes than any run of empty turns takes: a hand fills, or the
  // library runs out, long before.
  for (let guard = 0; guard < 400; guard += 1) {
    if (!idle(next)) return next
    if (!(eager && next.stack.length) && canAct(next)) return next
    const leaving = !next.stack.length && next.step === 'main2'
    const after = pass(leaving ? noted(next, 'Nothing left to do — the turn passes') : next)
    if (after === next) return next
    next = after
  }
  return next
}

/** Your moves in the game, after which it plays on. Not the table's tools —
 *  a card dragged somewhere, a counter set by hand, a new deal — and not a
 *  step asked for by name: those leave the game where you put it. */
export const MOVES: ReadonlySet<Action['type']> = new Set<Action['type']>([
  'play', 'cast', 'activate', 'crack', 'pass', 'attack',
  'choose', 'confirm', 'mode', 'number', 'arrange', 'pickType', 'order', 'done',
])
