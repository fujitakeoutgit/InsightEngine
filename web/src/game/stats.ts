/**
 * A permanent's numbers and keywords as the board has them.
 *
 * Printed power and toughness, then everything that changes them: its
 * counters, its own text ("gets +1/+1 for each land you control"), other
 * permanents' ("creatures you control get +1/+1"), what is attached to it,
 * and what it was given until end of turn. Keywords are gathered the same
 * way. It is the layer system in one layer — enough for sizes and keyword
 * grants, which is nearly all of what a goldfish meets; copy effects and
 * type-changing effects are not here, and stay by hand.
 *
 * Without the game — just the card — the answer is what is printed plus
 * counters, which is all a card off the battlefield has.
 */

import { compile } from './compiler/compile'
import type { Boost, Filter, Measure } from './compiler/ir'
import type { GameState, Instance, Known } from './types'

const printed = (inst: Instance, field: 'power' | 'toughness') =>
  inst.card[field] ?? inst.card.card_faces?.[0]?.[field] ?? null

const counted = (inst: Instance) =>
  (inst.counters?.['+1/+1'] ?? 0) - (inst.counters?.['-1/-1'] ?? 0)

const word = (line: string, w: string) => new RegExp(`\\b${w}\\b`, 'i').test(line)

/** Does a permanent answer to a static ability's filter? By type only: no
 *  standing effect here asks about size, which would be asking this module
 *  about itself. */
function fits(inst: Instance, filter: Filter, source: string): boolean {
  if (filter.controller === 'opponent') return false
  const line = inst.card.type_line ?? ''
  if (filter.types && !filter.types.some((t) => word(line, t))) return false
  if (filter.not?.some((t) => word(line, t))) return false
  if (filter.subtypes && !filter.subtypes.some((t) => word(line, t))) return false
  if (filter.notSubtypes?.some((t) => word(line, t))) return false
  if (filter.basic && !word(line, 'Basic')) return false
  if (filter.nontoken && inst.token) return false
  if (filter.other && inst.iid === source) return false
  return true
}

const onBoard = (state: GameState) => state.cards.filter((c) => c.zone === 'battlefield')

/** How many there are of what a "for each" counts. */
function measure(state: GameState, of: Filter | 'colors' | Measure, source: string): number {
  if (of === 'colors') {
    return new Set(onBoard(state).flatMap((c) => [...(c.card.colors ?? '')])).size
  }
  if ('devotion' in of) {
    // Devotion: that color's symbols in the costs of your permanents.
    return onBoard(state).reduce((n, c) => (
      n + [...(c.card.mana_cost ?? '').matchAll(/\{([^}]+)\}/g)]
        .filter((m) => m[1].split('/').includes(of.devotion)).length
    ), 0)
  }
  const filter = 'per' in of ? of.per : of
  return onBoard(state).filter((c) => fits(c, filter as Filter, source)).length
}

interface Applied { power: number; toughness: number; keywords: string[] }

/** Everything standing on the board that changes this permanent. */
function applied(inst: Instance, state: GameState): Applied {
  const out: Applied = { power: 0, toughness: 0, keywords: [] }
  if (inst.zone !== 'battlefield') return out
  const add = (boost: Boost, times: number) => {
    out.power += boost.power * times
    out.toughness += boost.toughness * times
    out.keywords.push(...boost.keywords)
  }
  for (const source of onBoard(state)) {
    for (const fixed of compile(source.card).statics) {
      if (fixed.kind !== 'boost') continue
      const mine = fixed.to === 'self' ? source.iid === inst.iid
        : fixed.to === 'attached' ? source.attachedTo === inst.iid
          : fits(inst, fixed.to, source.iid)
      if (!mine) continue
      if (fixed.condition
        && measure(state, fixed.condition.filter, source.iid) < fixed.condition.atLeast) continue
      add(fixed.boost, fixed.boost.per ? measure(state, fixed.boost.per, source.iid) : 1)
    }
  }
  for (const boost of state.boosts) {
    if (boost.iids.includes(inst.iid)) add(boost, 1)
  }
  return out
}

/** What it is before anything is added: printed, or what its own text says
 *  it is in place of a printed `*`. */
function base(inst: Instance, field: 'power' | 'toughness', state?: GameState) {
  if (state) {
    for (const fixed of compile(inst.card).statics) {
      if (fixed.kind === 'size' && fixed.stats.includes(field)) {
        return fixed.plus + measure(state, fixed.measure, inst.iid)
      }
    }
  }
  const n = Number.parseInt(printed(inst, field) ?? '', 10)
  return Number.isFinite(n) ? n : 0
}

export function power(inst: Instance, state?: GameState) {
  return base(inst, 'power', state) + counted(inst) + (state ? applied(inst, state).power : 0)
}

export function toughness(inst: Instance, state?: GameState) {
  return base(inst, 'toughness', state) + counted(inst) + (state ? applied(inst, state).toughness : 0)
}

export const stats = (inst: Instance, state?: GameState): Known =>
  ({ power: power(inst, state), toughness: toughness(inst, state) })

/** Its own keywords, and any the board gives it. */
export function hasKeyword(inst: Instance, keyword: string, state?: GameState) {
  const wanted = keyword.toLowerCase()
  if ((inst.card.keywords ?? []).some((k) => k.toLowerCase() === wanted)) return true
  return Boolean(state) && applied(inst, state!).keywords.some((k) => k.toLowerCase() === wanted)
}

/** Text by which a card sets or changes its own size. */
const SELF_SIZED = /\b(gets [+-]\d|power and toughness are each|(power|toughness) is equal|enters with)/i

/**
 * Whether the engine knows this creature's real size well enough to act on
 * it — to let it die of it.
 *
 * It does when the size is printed as a number, or its own text for it was
 * read. It does not when the card says something about its own size that the
 * compiler left in words: then the number here is missing a piece, and
 * killing the creature over it would punish the card for the engine's
 * ignorance.
 */
export function sizeKnown(inst: Instance) {
  const compiled = compile(inst.card)
  if (compiled.unread.some((line) => SELF_SIZED.test(line))) return false
  if (compiled.statics.some((fixed) => fixed.kind === 'size' && fixed.stats.includes('toughness'))) return true
  return /^\d+$/.test(printed(inst, 'toughness') ?? '')
}

/** Whether the board has changed it from what is printed — the table shows
 *  its size only then, since the card already shows the rest. */
export function resized(inst: Instance, state?: GameState) {
  if (counted(inst) !== 0 || (inst.damage ?? 0) > 0) return true
  if (!state) return false
  const now = stats(inst, state)
  const was = { power: printed(inst, 'power'), toughness: printed(inst, 'toughness') }
  return String(now.power) !== was.power || String(now.toughness) !== was.toughness
}

/** Its size for the table: "3/4" where that is known, and only what its
 *  counters add — "+2/+2" — where the card works out the rest in words. */
export function sizeLabel(inst: Instance, state?: GameState) {
  if (sizeKnown(inst)) return `${power(inst, state)}/${toughness(inst, state)}`
  const n = counted(inst)
  const signed = `${n >= 0 ? '+' : '−'}${Math.abs(n)}`
  return n ? `${signed}/${signed}` : ''
}
