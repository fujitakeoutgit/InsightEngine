/**
 * What kind of thing a card is: the part of a filter that is answered by the
 * card alone — its types, its colors, whether it is a token — without asking
 * the board how big it is. `match.ts` builds the rest on top of this, and
 * `stats.ts` uses it as it stands, since a size cannot be asked about while
 * it is being worked out.
 */

import type { Filter } from './compiler/ir'
import { isCreatureType } from './compiler/subtypes'
import type { Instance } from './types'

const word = (line: string, w: string) => new RegExp(`\\b${w}\\b`, 'i').test(line)

/** Does it have this subtype? A changeling is every creature type. */
export function hasSubtype(inst: Instance, subtype: string): boolean {
  const line = inst.card.type_line ?? ''
  if (word(line, subtype)) return true
  return isCreatureType(subtype)
    && word(line, 'Creature')
    && (inst.card.keywords ?? []).some((k) => k.toLowerCase() === 'changeling')
}

/** `source` is the card whose ability is asking, which "another" excludes. */
export function isKind(inst: Instance, filter: Filter, source?: string): boolean {
  // The other side of the table has nothing on it.
  if (filter.controller === 'opponent') return false
  const line = inst.card.type_line ?? ''
  if (filter.types && !filter.types.some((t) => word(line, t))) return false
  if (filter.not?.some((t) => word(line, t))) return false
  if (filter.subtypes && !filter.subtypes.some((t) => hasSubtype(inst, t))) return false
  if (filter.notSubtypes?.some((t) => hasSubtype(inst, t))) return false
  if (filter.basic && !word(line, 'Basic')) return false
  if (filter.colors && !filter.colors.some((color) => (inst.card.colors ?? '').includes(color))) return false
  if (filter.colorless && inst.card.colors) return false
  if (filter.commander && !inst.commander) return false
  if (filter.tapped !== undefined && inst.tapped !== filter.tapped) return false
  if (filter.nontoken && inst.token) return false
  if (filter.other && inst.iid === source) return false
  return true
}
