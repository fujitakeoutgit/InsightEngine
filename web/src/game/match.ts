/**
 * Does this card answer to that phrase? The filters the compiler reads out of
 * "another nontoken creature you control with power 2 or less", applied.
 */

import type { Filter } from './compiler/ir'
import { forSource, isKind, sweeping } from './kinds'
import { hasKeyword, power, toughness } from './stats'
import type { GameState, Instance } from './types'

/** `source` is the card whose ability is asking, which "another" excludes.
 *  With the game, size and keywords are what the board makes them. */
export function matches(inst: Instance, asked: Filter, source?: string, state?: GameState): boolean {
  // "Of the chosen type" is answered by the permanent that is asking.
  const filter = (asked.chosenType || asked.sameName) && state && source
    ? forSource(asked, state.cards.find((c) => c.iid === source))
    : asked
  if (!isKind(inst, filter, source, state ? sweeping(state) : undefined)) return false
  if (filter.attacking && !state?.attacking.includes(inst.iid)) return false
  if (filter.keyword && !hasKeyword(inst, filter.keyword, state)) return false
  if (filter.compare) {
    const { stat, op, value } = filter.compare
    // An amount still in words has no answer here: see `settled` in
    // amount.ts, which works it out first.
    if (typeof value !== 'number') return false
    const n = stat === 'power' ? power(inst, state)
      : stat === 'toughness' ? toughness(inst, state) : (inst.card.cmc ?? 0)
    if (op === '<=' ? n > value : n < value) return false
  }
  return true
}

/** Everything on the battlefield a filter means. */
export function onBattlefield(state: GameState, filter: Filter, source?: string): Instance[] {
  return state.cards.filter((c) => c.zone === 'battlefield' && matches(c, filter, source, state))
}
