/**
 * Is it so? What follows an "if" on a card, asked of the game as it stands:
 * whether you control a Bird, whether the land that entered is a Forest,
 * whether the creature that died was big enough.
 */

import { amount, type Asking } from './amount'
import type { Test } from './compiler/ir'
import { isCreatureType } from './compiler/subtypes'
import { hasSubtype, sweeping } from './kinds'
import { matches, onBattlefield } from './match'
import { partySize } from './party'
import { find, inZone } from './state'
import type { GameState } from './types'

export function holds(state: GameState, r: Asking, test: Test): boolean {
  if ('all' in test) return test.all.every((part) => holds(state, r, part))
  if ('not' in test) return !holds(state, r, test.not)
  if ('sharedType' in test) {
    // The most creatures of yours that have any one type in common.
    const creatures = inZone(state, 'battlefield').filter((c) => /\bCreature\b/.test(c.card.type_line ?? ''))
    const types = new Set(creatures.flatMap((c) => (
      (c.card.type_line ?? '').split(/\s+—\s+/)[1]?.split(/\s+/).filter(isCreatureType) ?? []
    )))
    // Changelings are every type, so with no type named they still share.
    if (!types.size) types.add('Shapeshifter')
    const sweep = sweeping(state)
    return [...types].some((type) => creatures.filter((c) => hasSubtype(c, type, sweep)).length >= test.sharedType)
  }
  if ('exiled' in test) {
    return state.cards.filter((c) => c.zone === 'exile' && c.exiledBy === r.source).length >= test.exiled
  }
  if ('party' in test) return partySize(state) >= test.party
  // Of a spell as it resolves — or of the permanent it became.
  if ('kicked' in test) return Boolean(r.kicked ?? find(state, r.source)?.kicked)
  if ('tally' in test) return state.tally[test.tally] >= test.atLeast
  if ('control' in test) return onBattlefield(state, test.control, r.source).length >= test.atLeast
  if ('graveyard' in test) {
    const { filter } = test
    return inZone(state, 'graveyard').filter((c) => !filter || matches(c, filter, r.source)).length >= test.graveyard
  }
  if ('is' in test) {
    const iid = test.of === 'chosen' ? r.chosen[0] : test.of === 'event' ? r.event : r.source
    const inst = iid ? find(state, iid) : undefined
    return Boolean(inst) && matches(inst!, test.is, r.source, state)
  }
  if ('counters' in test) return amount(state, r, { counters: test.counters, of: test.of }) >= test.atLeast
  const n = amount(state, r, { stat: test.stat, of: test.of })
  return test.op === '>=' ? n >= test.value : n <= test.value
}
