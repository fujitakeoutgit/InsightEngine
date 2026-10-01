/**
 * Does this card answer to that phrase? The filters the compiler reads out of
 * "another nontoken creature you control with power 2 or less", applied.
 */

import type { Filter } from './compiler/ir'
import { hasKeyword } from './sources'
import { power, toughness } from './stats'
import type { GameState, Instance } from './types'

const word = (line: string, w: string) => new RegExp(`\\b${w}\\b`, 'i').test(line)

/** `source` is the card whose ability is asking, which "another" excludes. */
export function matches(inst: Instance, filter: Filter, source?: string): boolean {
  // The other side of the table has nothing on it.
  if (filter.controller === 'opponent') return false
  const line = inst.card.type_line ?? ''
  if (filter.types && !filter.types.some((t) => word(line, t))) return false
  if (filter.not?.some((t) => word(line, t))) return false
  if (filter.subtypes && !filter.subtypes.some((t) => word(line, t))) return false
  if (filter.notSubtypes?.some((t) => word(line, t))) return false
  if (filter.basic && !word(line, 'Basic')) return false
  if (filter.nontoken && inst.token) return false
  if (filter.other && inst.iid === source) return false
  if (filter.keyword && !hasKeyword(inst, filter.keyword)) return false
  if (filter.compare) {
    const { stat, op, value } = filter.compare
    const n = stat === 'power' ? power(inst) : stat === 'toughness' ? toughness(inst) : (inst.card.cmc ?? 0)
    if (op === '<=' ? n > value : n < value) return false
  }
  return true
}

/** Everything on the battlefield a filter means. */
export function onBattlefield(state: GameState, filter: Filter, source?: string): Instance[] {
  return state.cards.filter((c) => c.zone === 'battlefield' && matches(c, filter, source))
}
