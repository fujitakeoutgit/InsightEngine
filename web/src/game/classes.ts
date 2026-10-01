/**
 * Classes: enchantments that gain levels.
 *
 * A Class has the abilities printed above its first "{cost}: Level N" line,
 * and that line is an ability that gains the level. Here a Class at a higher
 * level is the same card with that line taken out — so the abilities under it
 * are simply part of its text from then on, and everything that reads cards
 * reads a leveled Class without knowing there are levels.
 */

import type { Card } from '../lib/api'

const LEVEL = /^(?:\{[^}]+\})+: Level (\d+)$/i

/** The card one level up, and which level that is; null if there is no
 *  level left to gain. */
export function leveled(card: Card): { card: Card; level: number } | null {
  const lines = (card.oracle_text ?? '').split('\n')
  const at = lines.findIndex((line) => LEVEL.test(line.trim()))
  if (at < 0) return null
  const level = Number(LEVEL.exec(lines[at].trim())![1])
  return { level, card: { ...card, oracle_text: lines.filter((_, i) => i !== at).join('\n') } }
}
