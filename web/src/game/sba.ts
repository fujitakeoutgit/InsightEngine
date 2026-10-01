/**
 * State-based actions (CR 704): what the game checks for itself after every
 * action, whoever took it. Only with the rules on — in the sandbox a token
 * dragged to the graveyard stays there, because you put it there.
 *
 * Toughness is not checked yet. Nothing here puts counters on creatures, and
 * checking it now would kill every X-cost 0/0 the moment it resolved.
 */

import { noted, relocate } from './state'
import type { GameState } from './types'

const isWalker = (line: string | null) => /\bPlaneswalker\b/.test(line ?? '')

export function stateBased(state: GameState): GameState {
  if (!state.rules) return state
  let next = state

  // A token anywhere but the battlefield ceases to exist (704.5d).
  const vanished = next.cards.filter((c) => c.token && c.zone !== 'battlefield')
  if (vanished.length) {
    next = { ...next, cards: next.cards.filter((c) => !(c.token && c.zone !== 'battlefield')) }
    for (const c of vanished) next = noted(next, `${c.card.name} ceases to exist`)
  }

  // A planeswalker with no loyalty goes to the graveyard (704.5i).
  for (const c of next.cards) {
    if (c.zone === 'battlefield' && isWalker(c.card.type_line) && (c.loyalty ?? 0) <= 0) {
      next = noted({ ...next, cards: relocate(next.cards, c.iid, 'graveyard') }, `${c.card.name} has no loyalty left`)
    }
  }

  // A commander in a graveyard or exile may go home instead (903.9a). It
  // always does here: keeping it in the graveyard is a choice nobody makes
  // without a reason the engine cannot see.
  for (const c of next.cards) {
    if (c.commander && (c.zone === 'graveyard' || c.zone === 'exile')) {
      next = noted({ ...next, cards: relocate(next.cards, c.iid, 'command') }, `${c.card.name} returns to the command zone`)
    }
  }

  // No life left loses the game (704.5a).
  if (next.life <= 0 && !next.lost) {
    next = noted({ ...next, lost: `Your life reached ${next.life} on turn ${next.turn}` }, 'You are out of life')
  }
  return next
}
