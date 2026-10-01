/**
 * How many, as the game stands: the number an effect's amount comes to when
 * it happens. "Two", X as the spell was cast, one for each land you control,
 * the sacrificed creature's toughness, the cards in your hand.
 */

import { compile } from './compiler/compile'
import type { Count, Filter, Signed } from './compiler/ir'
import { isCreatureType } from './compiler/subtypes'
import { matches, onBattlefield } from './match'
import { find, inZone } from './state'
import { colorsOnBoard, snapshot, stats } from './stats'
import type { GameState, Known } from './types'

/** What an amount is asked on behalf of: the ability resolving, or a
 *  permanent arriving. */
export interface Asking {
  x: number
  source: string
  chosen: readonly string[]
  event: string | null
  known: Record<string, Known>
  last: number
}

export function amount(state: GameState, r: Asking, count: Count): number {
  if (typeof count === 'number') return count
  if (count === 'X') return r.x
  if (count === 'colors') return colorsOnBoard(state)
  if (count === 'life') return state.life
  if (count === 'thatMany') return r.last
  if ('tally' in count) return state.tally[count.tally]
  if ('per' in count) return onBattlefield(state, settled(state, r, count.per), r.source).length
  if ('zone' in count) {
    const { filter } = count
    return inZone(state, count.zone).filter((c) => !filter || matches(c, filter, r.source)).length
  }
  if ('total' in count) {
    return onBattlefield(state, count.of, r.source).reduce((n, c) => n + stats(c, state)[count.total], 0)
  }

  // `each` is asked one permanent at a time, with that permanent as the
  // event — see `counters` in resolve.ts. Asked any other way it has no
  // answer.
  if (count.of === 'each') return 0
  const iid = count.of === 'chosen' ? r.chosen[0] : count.of === 'event' ? r.event : r.source
  if (!iid) return 0
  // The source is asked as it is now; anything else as it was when it was
  // picked or when the trigger saw it, since it may have left since.
  const live = find(state, iid)
  const seen = count.of === 'self' && live?.zone === 'battlefield'
    ? snapshot(live, state)
    : r.known[iid] ?? (live ? snapshot(live, state) : null)
  if (!seen) return 0
  if ('counters' in count) return seen.counters?.[count.counters] ?? 0
  if (count.stat === 'manaValue') return seen.manaValue ?? 0
  if (count.stat === 'gap') return Math.abs(seen.power - seen.toughness)
  return seen[count.stat]
}

/** A filter with any amount in it worked out: "mana value less than or
 *  equal to the number of lands you control" becomes "…3 or less". */
export function settled(state: GameState, r: Asking, asked: Filter): Filter {
  const filter = asked.sharesType ? sharing(state, r, asked) : asked
  const { compare } = filter
  if (!compare || typeof compare.value === 'number') return filter
  return { ...filter, compare: { ...compare, value: amount(state, r, compare.value) } }
}

/** "That shares a creature type with it", as the types that would do. A
 *  changeling shares one with every creature, so it asks for nothing more
 *  than a creature; something with no creature type shares with none. */
function sharing(state: GameState, r: Asking, filter: Filter): Filter {
  const { sharesType, ...rest } = filter
  if (sharesType === 'yours') {
    // With any creature you control: every type there is among them.
    const yours = inZone(state, 'battlefield').filter((c) => /\bCreature\b/.test(c.card.type_line ?? ''))
    const every = yours.some((c) => (c.card.keywords ?? []).some((k) => k.toLowerCase() === 'changeling'))
    if (every) return { ...rest, types: rest.types ?? ['creature'] }
    const among = [...new Set(yours.flatMap((c) => (
      (c.card.type_line ?? '').split(/\s+—\s+/)[1]?.split(/\s+/).filter(isCreatureType) ?? []
    )))]
    return { ...rest, subtypes: among.length ? among : ['—'] }
  }
  const source = find(state, r.source)
  const iid = sharesType === 'host' ? source?.attachedTo ?? r.event
    : sharesType === 'it' ? r.event ?? r.source : r.source
  const with_ = iid ? find(state, iid) : undefined
  if (!with_) return { ...rest, subtypes: ['—'] }
  if ((with_.card.keywords ?? []).some((k) => k.toLowerCase() === 'changeling')) return { ...rest, types: rest.types ?? ['creature'] }
  const types = (with_.card.type_line ?? '').split(/\s+—\s+/)[1]?.split(/\s+/).filter(isCreatureType) ?? []
  // What it "is in addition to its other types" counts too.
  if (with_.chosenType && compile(with_.card).statics.some((fixed) => fixed.kind === 'isChosenType')) types.push(with_.chosenType)
  return { ...rest, subtypes: types.length ? types : ['—'] }
}

/** A change to power or toughness, as a number. */
export const signed = (state: GameState, r: Asking, by: Signed): number =>
  (typeof by === 'number' ? by : by.sign * amount(state, r, by.count))
