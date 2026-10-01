/**
 * A permanent's numbers as the board has them: printed power and toughness,
 * moved by its +1/+1 and -1/-1 counters.
 *
 * Deliberately not the layer system. A card whose size is defined by its own
 * text — "power and toughness are each equal to the number of lands you
 * control" — prints `*`, which reads as 0 here, and `known` says so: the
 * game does not kill a creature over a number it could not work out.
 */

import type { Instance, Known } from './types'

const printed = (inst: Instance, field: 'power' | 'toughness') =>
  inst.card[field] ?? inst.card.card_faces?.[0]?.[field] ?? null

const counted = (inst: Instance) =>
  (inst.counters?.['+1/+1'] ?? 0) - (inst.counters?.['-1/-1'] ?? 0)

/** Text by which a card changes its own size, which nothing here applies. */
const SELF_SIZED = /\b(gets [+-]\d|power and toughness are each|(power|toughness) is equal)/i

/**
 * Whether the engine knows this creature's real size well enough to act on
 * it — to let it die of it.
 *
 * Not when it prints `*`, and not when it prints a toughness of 0: a 0/0 is
 * alive because of something — counters it entered with, its own "gets +1/+1
 * for each…" — and until all of those are modelled, the honest answer for
 * such a card is that its size is not known. The same goes for any card
 * whose text resizes itself.
 */
export function sizeKnown(inst: Instance) {
  const t = printed(inst, 'toughness')
  if (t === null || !/^\d+$/.test(t) || Number(t) <= 0) return false
  return !SELF_SIZED.test(inst.card.oracle_text ?? inst.card.card_faces?.[0]?.oracle_text ?? '')
}

const base = (inst: Instance, field: 'power' | 'toughness') => {
  const n = Number.parseInt(printed(inst, field) ?? '', 10)
  return Number.isFinite(n) ? n : 0
}

export const power = (inst: Instance) => base(inst, 'power') + counted(inst)
export const toughness = (inst: Instance) => base(inst, 'toughness') + counted(inst)

export const stats = (inst: Instance): Known => ({ power: power(inst), toughness: toughness(inst) })

/** Whether the board has changed it from what is printed — the table shows
 *  its size only then, since the card already shows the rest. */
export function resized(inst: Instance) {
  return counted(inst) !== 0 || (inst.damage ?? 0) > 0
}

/** Its size for the table: "3/4" where that is known, and only what its
 *  counters add — "+2/+2" — where the card works out the rest itself. */
export function sizeLabel(inst: Instance) {
  const numeric = /^\d+$/.test(printed(inst, 'toughness') ?? '')
  const selfSized = SELF_SIZED.test(inst.card.oracle_text ?? inst.card.card_faces?.[0]?.oracle_text ?? '')
  if (numeric && !selfSized) return `${power(inst)}/${toughness(inst)}`
  const n = counted(inst)
  const signed = `${n >= 0 ? '+' : '−'}${Math.abs(n)}`
  return n ? `${signed}/${signed}` : ''
}
