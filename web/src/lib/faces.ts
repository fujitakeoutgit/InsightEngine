import { useState } from 'react'

import type { Card } from './api'

/**
 * Which face of a card is showing.
 *
 * Transforming cards, modal DFCs and battles all carry a `card_faces` array
 * whose entries have their own `image_uris`, so flipping is a matter of
 * swapping which face's image is used -- no extra request. Cards whose faces
 * lack images (split and adventure cards print both halves on one piece of
 * cardboard) are not flippable, and asking would give you the same picture.
 */
export function useCardFace(card: Card | null | undefined) {
  const [index, setIndex] = useState(0)

  const faces = card?.card_faces ?? []
  const flippable =
    faces.length > 1 && faces.every((f) => Boolean(f.image_uris?.normal))

  const src = flippable
    ? faces[index % faces.length].image_uris!.normal
    : card?.image_normal ?? card?.image_small ?? null

  return {
    flippable,
    /** Name of the face currently showing, for titles and alt text. */
    faceName: flippable ? faces[index % faces.length].name : card?.name ?? '',
    src,
    flip: () => setIndex((i) => (i + 1) % Math.max(1, faces.length)),
  }
}
