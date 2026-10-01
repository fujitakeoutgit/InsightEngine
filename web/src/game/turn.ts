/**
 * The turn: its steps in order, what the game does as each begins, and where
 * passing stops to ask you something.
 */

import { emptyPool, MANA_TYPES } from './mana'
import { draw, inZone, noted } from './state'
import type { GameState, Step } from './types'

export const STEPS: readonly Step[] = [
  'untap', 'upkeep', 'draw',
  'main1',
  'combatBegin', 'combatAttackers', 'combatEnd',
  'main2',
  'end', 'cleanup',
]

/** Where passing with an empty stack stops: the two main phases, where
 *  nearly everything is done. The other steps happen and are recorded. */
const STOPS: ReadonlySet<Step> = new Set(['main1', 'main2'])

export const MAX_HAND = 7

export const isMain = (step: Step) => step === 'main1' || step === 'main2'

/** Reliquary Tower and its kind. */
function noMaximumHandSize(state: GameState) {
  return state.cards.some((c) => (
    c.zone === 'battlefield' && /you have no maximum hand size/i.test(c.card.oracle_text ?? '')
  ))
}

/** What the game does as a step begins (CR 502–514). */
function enter(state: GameState): GameState {
  switch (state.step) {
    case 'untap': {
      // Everything untaps, and a creature you have had since this turn began
      // is no longer summoning sick — which, at the start of your turn, is
      // every creature you have.
      const cards = state.cards.map((c) => (
        c.zone === 'battlefield' && (c.tapped || c.sick) ? { ...c, tapped: false, sick: false } : c
      ))
      return noted({ ...state, cards, landsPlayed: 0 }, `Turn ${state.turn}`)
    }
    case 'draw':
      // Turn 1 skips its draw, as the first player's does in a two-player
      // game (CR 103.8a) and as the table always has.
      return state.turn === 1 ? state : draw(state, 1)
    case 'cleanup': {
      if (noMaximumHandSize(state)) return state
      const over = inZone(state, 'hand').length - MAX_HAND
      return over > 0 ? { ...state, pending: { kind: 'discard', count: over } } : state
    }
    default:
      return state
  }
}

/** One step on. Mana empties from the pool as a step ends (CR 500.4), and
 *  cleanup gives way to the next turn's untap. */
export function nextStep(state: GameState): GameState {
  const i = STEPS.indexOf(state.step)
  const last = i === STEPS.length - 1
  const unspent = MANA_TYPES.reduce((n, kind) => n + state.pool[kind], 0)
  const emptied = unspent ? noted(state, `${unspent} unspent mana left the pool`) : state
  return enter({
    ...emptied,
    pool: unspent ? emptyPool() : state.pool,
    step: last ? 'untap' : STEPS[i + 1],
    turn: last ? state.turn + 1 : state.turn,
  })
}

/** On through the steps until one that needs you, or a choice. */
export function toNextStop(state: GameState): GameState {
  let next = state
  do next = nextStep(next)
  while (!next.pending && !STOPS.has(next.step))
  return next
}

/** The opening hand is kept: turn 1 begins, and runs to its first main phase. */
export function begin(state: GameState): GameState {
  let next = enter({ ...state, pending: null, step: 'untap', turn: 1 })
  while (!next.pending && !STOPS.has(next.step)) next = nextStep(next)
  return next
}
