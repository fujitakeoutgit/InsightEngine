/**
 * Is it so? What follows an "if" on a card, asked of the game as it stands:
 * whether you control a Bird, whether the land that entered is a Forest,
 * whether the creature that died was big enough.
 */

import { amount, type Asking } from './amount'
import type { Test } from './compiler/ir'
import { matches, onBattlefield } from './match'
import { find, inZone } from './state'
import type { GameState } from './types'

export function holds(state: GameState, r: Asking, test: Test): boolean {
  if ('control' in test) return onBattlefield(state, test.control, r.source).length >= test.atLeast
  if ('graveyard' in test) return inZone(state, 'graveyard').length >= test.graveyard
  if ('is' in test) {
    const iid = test.of === 'chosen' ? r.chosen[0] : test.of === 'event' ? r.event : r.source
    const inst = iid ? find(state, iid) : undefined
    return Boolean(inst) && matches(inst!, test.is, r.source, state)
  }
  if ('counters' in test) return amount(state, r, { counters: test.counters, of: test.of }) >= test.atLeast
  const n = amount(state, r, { stat: test.stat, of: test.of })
  return test.op === '>=' ? n >= test.value : n <= test.value
}
