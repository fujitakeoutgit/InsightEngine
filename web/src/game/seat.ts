/**
 * Where a permanent is dealt, as fractions of the mat.
 *
 * The left two thirds is the board proper — creatures and planeswalkers up
 * top where combat happens, lands along the bottom where you tap them. The
 * right third holds artifacts and enchantments, which sit to one side and are
 * rarely touched once they are down. Nothing is enforced: this is only where a
 * card *lands*, and dragging it elsewhere is always allowed.
 */

import type { Instance, Spot } from './types'

const REGIONS = {
  creatures: { x: 0.02, y: 0.03, dx: 0.105, dy: 0.20, cols: 6 },
  lands: { x: 0.02, y: 0.52, dx: 0.105, dy: 0.20, cols: 6 },
  sides: { x: 0.68, y: 0.03, dx: 0.105, dy: 0.20, cols: 3 },
} as const

/** Land wins over Creature, so an Artifact Land is a land and an Artifact
 *  Creature is a creature. */
function regionFor(line: string): keyof typeof REGIONS {
  if (/\bLand\b/.test(line)) return 'lands'
  if (/\b(Creature|Planeswalker|Battle)\b/.test(line)) return 'creatures'
  return 'sides'
}

/**
 * The first square in this card's region that nothing is sitting on.
 *
 * Every card on the board counts, not just this region's: a permanent dragged
 * out of the creature rows and parked among the lands is in the way of the
 * lands now, whatever its type line says. The regions decide where a card is
 * *dealt*; they do not own the squares.
 *
 * Occupied means "near enough to collide with", not "was dealt here". Dealing
 * to the index of the region's card count assumed every card was still where
 * it was dealt — drag a creature out of the front row and every later one was
 * dealt past the gap. A card claims the square it is nearest to, so nudging
 * one keeps its place, and one dragged clear across the mat gives up its old
 * square and takes whichever it landed on.
 */
export function seatFor(cards: readonly Instance[], arriving: Instance): Spot {
  const region = REGIONS[regionFor(arriving.card.type_line ?? '')]
  const taken = cards.filter((c) => c.zone === 'battlefield' && c.iid !== arriving.iid)

  const square = (i: number) => ({
    x: region.x + (i % region.cols) * region.dx,
    y: region.y + Math.floor(i / region.cols) * region.dy,
  })

  for (let i = 0; i < region.cols * 6; i += 1) {
    const at = square(i)
    const clash = taken.some((c) => (
      Math.abs(c.x - at.x) < region.dx / 2 && Math.abs(c.y - at.y) < region.dy / 2
    ))
    if (!clash) return at
  }
  // Nowhere left. Deal past the end rather than refuse to play the card.
  return square(taken.length)
}
