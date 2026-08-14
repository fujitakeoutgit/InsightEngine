import type { Card } from './api'
import type { Category } from './api'

/**
 * Does this card do one of the four jobs?
 *
 * Read off the card's own text, here in the browser. The server's category
 * recommender cannot answer this: it exists to suggest cards you do *not*
 * have, and the question a binder asks is which of the cards you *do* have
 * would ramp, or kill something, or draw you cards.
 *
 * These are heuristics and are meant to be. A rules-accurate classifier would
 * need the oracle tag vocabulary and would still argue with you about Solemn
 * Simulacrum; a filter over your own collection wants to be roughly right and
 * instant, and to be wrong in the direction of showing you too much rather
 * than hiding something you own.
 */

const RAMP = /\badd \{[wubrgc]\}|\badd (one|two|three|X) mana|search your library for (a|up to \w+) .*\bland/i
const REMOVAL = /\bdestroy target|\bexile target|deals? \d+ damage to (target|any target)|target creature gets -|target player sacrifices|fight target/i
const COUNTER = /\bcounter target\b/i
const DRAW = /\bdraw (a|one|two|three|four|five|X|\d+) card/i

/** Every face's text, because a modal or double-faced card does its job on
 *  whichever side says so. */
function allText(card: Card): string {
  const faces = (card.card_faces ?? []).map((f) => f.oracle_text ?? '')
  return [card.oracle_text ?? '', ...faces].join(' \n ')
}

export function doesJob(card: Card, job: Category): boolean {
  const text = allText(card)
  const line = card.type_line ?? ''

  switch (job) {
    case 'ramp':
      // Lands are excluded on purpose. Every land taps for mana, so counting
      // them would return the whole manabase and tell you nothing.
      return !/\bLand\b/.test(line) && RAMP.test(text)
    case 'removal':
      return REMOVAL.test(text)
    case 'counterspell':
      return COUNTER.test(text)
    case 'draw':
      return DRAW.test(text)
    default:
      return false
  }
}
