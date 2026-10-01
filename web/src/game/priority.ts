/**
 * Priority, and what the game does each time you would get it.
 *
 * You always hold priority, and the opponent — who has nothing to do — always
 * passes it straight back, so passing means one of two things: the top of the
 * stack resolves, or, with the stack empty, the game moves on.
 *
 * Before you get it back, the game settles: state-based actions are checked,
 * and whatever triggered goes on the stack (CR 117.5). `settle` is that, and
 * everything here that moves the game on calls it after each move.
 */

import { resolveTop } from './resolve'
import { stateBased } from './sba'
import { collectTriggers, stepTriggers } from './triggers'
import { firstTurn, nextStep, STEPS, STOPS } from './turn'
import type { GameState, Step } from './types'

/** State-based actions and triggers, until nothing more happens. Triggers
 *  are looked for between passes, because a death is something abilities
 *  watch for, and a state-based action is what causes most of them. */
export function settle(before: GameState, after: GameState): GameState {
  if (after === before || !after.rules) return after
  let prev = before
  let next = after
  for (let guard = 0; guard < 30; guard += 1) {
    next = collectTriggers(prev, next)
    const checked = stateBased(next)
    if (checked === next) return next
    prev = next
    next = checked
  }
  return next
}

/** One step on, with what begins in it. */
function stepOn(state: GameState): GameState {
  const moved = nextStep(state)
  const begun = moved.step === 'upkeep' || moved.step === 'end' ? stepTriggers(moved, moved.step)
    : moved.step === 'main1' ? stepTriggers(moved, 'main')
      : moved.step === 'combatBegin' ? stepTriggers(moved, 'combat')
        : moved
  return settle(state, begun)
}

/** Does the game need you here? A choice to make, something on the stack to
 *  respond to, or a step you always stop in. */
const needsYou = (state: GameState) =>
  Boolean(state.pending) || state.stack.length > 0 || STOPS.has(state.step)

/** On through the steps until one that needs you. */
export function toNextStop(state: GameState): GameState {
  let next = state
  do next = stepOn(next)
  while (!needsYou(next))
  return next
}

/** The opening hand is kept: turn 1 begins, and runs to its first main phase. */
export function begin(state: GameState): GameState {
  let next = settle(state, firstTurn(state))
  while (!needsYou(next)) next = stepOn(next)
  return next
}

export function pass(state: GameState): GameState {
  if (state.pending) return state
  if (state.stack.length) return settle(state, resolveTop(state))
  return toNextStop(state)
}

/** Keep passing until the next time this step comes round — later this turn
 *  if it is still ahead, next turn if not. Whatever is on the stack resolves
 *  on the way, and a choice stops the run where it comes up. */
export function passTo(state: GameState, step: Step): GameState {
  const turn = STEPS.indexOf(step) > STEPS.indexOf(state.step) ? state.turn : state.turn + 1
  let next = state
  for (let guard = 0; guard < 400; guard += 1) {
    if (next.pending) return next
    if (next.stack.length) {
      next = settle(next, resolveTop(next))
      continue
    }
    if (next.turn > turn || (next.turn === turn && next.step === step)) return next
    next = stepOn(next)
  }
  return next
}
