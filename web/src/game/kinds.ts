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

/** What the board makes true of whole kinds of card at once: every
 *  creature every creature type (Maskwood Nexus), every land every basic
 *  land type (Dryad of the Ilysian Grove). */
export interface Sweeping {
  creatures: boolean
  lands: boolean
  /** Types given to particular permanents for the turn: "until end of turn,
   *  it becomes a Villain in addition to its other types". */
  granted: Record<string, string[]>
}

const NOTHING: Sweeping = { creatures: false, lands: false, granted: {} }

const BASIC_LAND_TYPES = ['Plains', 'Island', 'Swamp', 'Mountain', 'Forest']

/**
 * Does it have this subtype? A changeling is every creature type; so is
 * every creature, and every land every basic land type, while something on
 * the board says so; and a permanent that "is the chosen type" is the type
 * chosen for it.
 */
export function hasSubtype(inst: Instance, subtype: string, sweep: Sweeping = NOTHING): boolean {
  const line = inst.card.type_line ?? ''
  if (word(line, subtype)) return true
  if (sweep.granted[inst.iid]?.includes(subtype)) return true
  if (sweep.lands && BASIC_LAND_TYPES.includes(subtype) && word(line, 'Land')) return true
  if (!isCreatureType(subtype)) return false
  if (inst.chosenType === subtype && compile(inst.card).statics.some((fixed) => fixed.kind === 'isChosenType')) {
    return true
  }
  return word(line, 'Creature')
    && (sweep.creatures || (inst.card.keywords ?? []).some((k) => k.toLowerCase() === 'changeling'))
}

const sweeps = new WeakMap<GameState, Sweeping>()

/** What is true of every creature, and of every land, as the board stands.
 *  Asked once of each state. */
export function sweeping(state: GameState): Sweeping {
  const known = sweeps.get(state)
  if (known) return known
  const has = (kind: 'everyCreatureType' | 'everyLandType') => state.cards.some((c) => (
    c.zone === 'battlefield' && compile(c.card).statics.some((fixed) => fixed.kind === kind)
  ))
  const granted: Record<string, string[]> = {}
  for (const boost of state.boosts) {
    for (const iid of boost.types ? boost.iids : []) granted[iid] = [...(granted[iid] ?? []), ...boost.types!]
  }
  const sweep = { creatures: has('everyCreatureType'), lands: has('everyLandType'), granted }
  sweeps.set(state, sweep)
  return sweep
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
export function isKind(inst: Instance, filter: Filter, source?: string, sweep: Sweeping = NOTHING): boolean {
  // The other side of the table has nothing on it.
  if (filter.controller === 'opponent') return false
  // Whose chosen type, whose name? See `forSource`, which has to have
  // answered first.
  if (filter.chosenType || filter.sameName) return false
  if (filter.name && inst.card.name !== filter.name) return false
  if (filter.either && !filter.either.some((one) => isKind(inst, one, source, sweep))) return false
  const line = inst.card.type_line ?? ''
  if (filter.types && !filter.types.some((t) => word(line, t))) return false
  if (filter.also && !filter.also.every((t) => word(line, t))) return false
  if (filter.not?.some((t) => word(line, t))) return false
  if (filter.subtypes && !filter.subtypes.some((t) => hasSubtype(inst, t, sweep))) return false
  if (filter.notSubtypes?.some((t) => hasSubtype(inst, t, sweep))) return false
  if (filter.basic && !word(line, 'Basic')) return false
  if (filter.colors && !filter.colors.some((color) => (inst.card.colors ?? '').includes(color))) return false
  if (filter.colorless && inst.card.colors) return false
  if (filter.commander !== undefined && Boolean(inst.commander) !== filter.commander) return false
  if (filter.tapped !== undefined && inst.tapped !== filter.tapped) return false
  if (filter.nontoken && inst.token) return false
  if (filter.token && !inst.token) return false
  // With what? See `settled` in amount.ts, which has to have answered first.
  if (filter.sharesType) return false
  if (filter.other && inst.iid === source) return false
  return true
}
