/**
 * Cards printed with two faces.
 *
 * An adventure, a split card, a card that transforms: the mirror keeps one
 * row for the whole piece of cardboard — "Beanstalk Giant // Fertile
 * Footsteps", both costs in one string, the rules text on its faces rather
 * than on the card. The engine plays one face at a time, so it reads the card
 * as one: the front, wherever it is dealt and whenever it is not being cast
 * as its other half; the back, for the time it spends on the stack as that.
 */

import type { Card } from '../lib/api'

/** Layouts whose second face is a spell of its own that can be cast: the
 *  other half of a split card, the adventure. A transforming card's back is
 *  not cast, and a modal one's is not offered yet. */
const CASTABLE = new Set(['split', 'adventure'])

function view(card: Card, index: 0 | 1): Card {
  const face = card.card_faces![index]
  return {
    ...card,
    face: index,
    name: face.name,
    mana_cost: face.mana_cost ?? null,
    type_line: face.type_line ?? card.type_line,
    oracle_text: face.oracle_text ?? '',
    power: face.power ?? null,
    toughness: face.toughness ?? null,
  }
}

/** Has it two faces with words of their own? A reversible printing — the
 *  same card on both sides — and a card already read as one face do not. */
const twoFaced = (card: Card) =>
  card.face === undefined && (card.card_faces?.length ?? 0) === 2 && !card.oracle_text
  && card.card_faces!.some((face) => face.oracle_text || face.type_line)

/** The card as its front face. A card with one face is itself. */
export function frontOf(card: Card): Card {
  return twoFaced(card) ? view(card, 0) : card
}

/** Its other half, where that can be cast — or null. */
export function backOf(card: Card): Card | null {
  if ((card.card_faces?.length ?? 0) !== 2 || !CASTABLE.has(card.layout ?? '')) return null
  if (card.face === 1) return null
  return view(card, 1)
}
