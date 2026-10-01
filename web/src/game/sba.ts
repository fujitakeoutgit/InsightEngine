/**
 * State-based actions (CR 704): what the game checks for itself whenever a
 * player would get priority, whoever caused it. Only with the rules on — in
 * the sandbox a token dragged to the graveyard stays there, because you put
 * it there.
 *
 * One pass at a time. Dying is an event abilities watch for, so the caller
 * looks for triggers between passes rather than after them all.
 */

import { hasKeyword, isCreature } from './sources'
import { noted, relocate } from './state'
import { sizeKnown, toughness } from './stats'
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

  for (const c of next.cards) {
    if (c.zone !== 'battlefield') continue

    // +1/+1 and -1/-1 counters cancel each other out (704.5q).
    const plus = c.counters?.['+1/+1'] ?? 0
    const minus = c.counters?.['-1/-1'] ?? 0
    if (plus && minus) {
      const off = Math.min(plus, minus)
      const counters = { ...c.counters, '+1/+1': plus - off, '-1/-1': minus - off }
      next = { ...next, cards: next.cards.map((x) => (x.iid === c.iid ? { ...x, counters } : x)) }
    }

    // Only a creature whose size the engine is sure of — see `sizeKnown`.
    // Killing one over a number it could not work out would punish the card
    // for the engine's ignorance.
    if (isCreature(c) && sizeKnown(c)) {
      // Toughness 0 or less: into the graveyard (704.5f).
      if (toughness(c) <= 0) {
        next = noted({ ...next, cards: relocate(next.cards, c.iid, 'graveyard') }, `${c.card.name} dies — toughness ${toughness(c)}`)
        continue
      }
      // Lethal damage destroys it (704.5g), unless nothing can.
      if ((c.damage ?? 0) > 0 && (c.damage ?? 0) >= toughness(c) && !hasKeyword(c, 'Indestructible')) {
        next = noted({ ...next, cards: relocate(next.cards, c.iid, 'graveyard') }, `${c.card.name} dies — lethal damage`)
        continue
      }
    }

    // A planeswalker with no loyalty goes to the graveyard (704.5i).
    if (isWalker(c.card.type_line) && (c.loyalty ?? 0) <= 0) {
      next = noted({ ...next, cards: relocate(next.cards, c.iid, 'graveyard') }, `${c.card.name} has no loyalty left`)
    }
  }

  // A commander in a graveyard or exile may go home instead (903.9a). It
  // always does here: keeping it in the graveyard is a choice nobody makes
  // without a reason the engine cannot see. Only one that was already there
  // as this pass began: a commander that dies in this pass spends it in the
  // graveyard, where the abilities that watch for deaths can see it.
  for (const c of state.cards) {
    if (c.commander && (c.zone === 'graveyard' || c.zone === 'exile')) {
      next = noted({ ...next, cards: relocate(next.cards, c.iid, 'command') }, `${c.card.name} returns to the command zone`)
    }
  }

  // No life left loses the game (704.5a) — yours, or theirs.
  if (next.life <= 0 && !next.lost) {
    next = noted({ ...next, lost: `Your life reached ${next.life} on turn ${next.turn}` }, 'You are out of life')
  }
  if (next.opponent.life <= 0 && !next.won) {
    next = noted({ ...next, won: `The opponent reached ${next.opponent.life} life on turn ${next.turn}` }, 'The opponent is out of life')
  }
  return next
}
