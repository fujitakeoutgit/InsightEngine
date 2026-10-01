/**
 * Priority. You always hold it, and the opponent — who has nothing to do —
 * always passes it straight back, so passing means one of two things: the top
 * of the stack resolves, or, with the stack empty, the game moves on.
 */

import { resolveTop } from './cast'
import { stateBased } from './sba'
import { nextStep, STEPS, toNextStop } from './turn'
import type { GameState, Step } from './types'

export function pass(state: GameState): GameState {
  if (state.pending) return state
  if (state.stack.length) return resolveTop(state)
  return toNextStop(state)
}

/** Keep passing until the next time this step comes round — later this turn
 *  if it is still ahead, next turn if not. Whatever is on the stack resolves
 *  on the way, and a choice stops the run where it comes up. */
export function passTo(state: GameState, step: Step): GameState {
  const turn = STEPS.indexOf(step) > STEPS.indexOf(state.step) ? state.turn : state.turn + 1
  let next = state
  // Two turns of steps is further than any target can be.
  for (let guard = 0; guard < STEPS.length * 2 + 50; guard += 1) {
    if (next.pending) return next
    if (next.stack.length) {
      // Checked each time a player would get priority back (CR 117.5).
      next = stateBased(resolveTop(next))
      continue
    }
    if (next.turn > turn || (next.turn === turn && next.step === step)) return next
    next = stateBased(nextStep(next))
  }
  return next
}
