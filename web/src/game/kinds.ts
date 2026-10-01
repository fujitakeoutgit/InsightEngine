/**
 * What kind of thing a card is: the part of a filter that is answered by the
 * card alone — its types, its colors, whether it is a token — without asking
 * the board how big it is. `match.ts` builds the rest on top of this, and
 * `stats.ts` uses it as it stands, since a size cannot be asked about while
 * it is being worked out.
 */

import { compile } from './compiler/compile'
import type { Filter } from './compiler/ir'
import { isCreatureType } from './compiler/subtypes'
import type { GameState, Instance } from './types'

const word = (line: string, w: string) => new RegExp(`\\b${w}\\b`, 'i').test(line)

/**
 * Does it have this subtype? A changeling is every creature type; so is
 * every creature while something says they all are (`every`); and a
 * permanent that "is the chosen type" is the type chosen for it.
 */
export function hasSubtype(inst: Instance, subtype: string, every = false): boolean {
  const line = inst.card.type_line ?? ''
  if (word(line, subtype)) return true
  if (!isCreatureType(subtype)) return false
  if (inst.chosenType === subtype && compile(inst.card).statics.some((fixed) => fixed.kind === 'isChosenType')) {
    return true
  }
  return word(line, 'Creature')
    && (every || (inst.card.keywords ?? []).some((k) => k.toLowerCase() === 'changeling'))
}

const everyTypes = new WeakMap<GameState, boolean>()

/** Is something making every creature every creature type? Maskwood Nexus.
 *  Asked once of each state. */
export function everyType(state: GameState): boolean {
  const known = everyTypes.get(state)
  if (known !== undefined) return known
  const every = state.cards.some((c) => (
    c.zone === 'battlefield' && compile(c.card).statics.some((fixed) => fixed.kind === 'everyCreatureType')
  ))
  everyTypes.set(state, every)
  return every
}

/** A filter as one permanent's ability means it: "of the chosen type" is the
 *  type chosen for that permanent — and, until one has been, nothing. */
export function forSource(filter: Filter, source: Instance | undefined): Filter {
  if (!filter.chosenType && !filter.sameName) return filter
  const { chosenType, sameName, ...rest } = filter
  return {
    ...rest,
    ...(chosenType ? { subtypes: [source?.chosenType ?? '—'] } : {}),
    ...(sameName ? { name: source?.card.name ?? '—' } : {}),
  }
}

/** `source` is the card whose ability is asking, which "another" excludes. */
export function isKind(inst: Instance, filter: Filter, source?: string, every = false): boolean {
  // The other side of the table has nothing on it.
  if (filter.controller === 'opponent') return false
  // Whose chosen type, whose name? See `forSource`, which has to have
  // answered first.
  if (filter.chosenType || filter.sameName) return false
  if (filter.name && inst.card.name !== filter.name) return false
  if (filter.either && !filter.either.some((one) => isKind(inst, one, source, every))) return false
  const line = inst.card.type_line ?? ''
  if (filter.types && !filter.types.some((t) => word(line, t))) return false
  if (filter.also && !filter.also.every((t) => word(line, t))) return false
  if (filter.not?.some((t) => word(line, t))) return false
  if (filter.subtypes && !filter.subtypes.some((t) => hasSubtype(inst, t, every))) return false
  if (filter.notSubtypes?.some((t) => hasSubtype(inst, t, every))) return false
  if (filter.basic && !word(line, 'Basic')) return false
  if (filter.colors && !filter.colors.some((color) => (inst.card.colors ?? '').includes(color))) return false
  if (filter.colorless && inst.card.colors) return false
  if (filter.commander !== undefined && Boolean(inst.commander) !== filter.commander) return false
  if (filter.tapped !== undefined && inst.tapped !== filter.tapped) return false
  if (filter.nontoken && inst.token) return false
  if (filter.other && inst.iid === source) return false
  return true
}
