/**
 * The party: up to one each of Cleric, Rogue, Warrior and Wizard, from among
 * the creatures you control (CR 700.8). A creature fills one place, whatever
 * else it is — so two Clerics are one member, and a changeling is whichever
 * the party lacks.
 */

import { hasSubtype, sweeping, type Sweeping } from './kinds'
import { isCreature } from './sources'
import { inZone } from './state'
import type { GameState, Instance } from './types'

const ROLES = ['Cleric', 'Rogue', 'Warrior', 'Wizard']

/** Can it be in a party at all? */
export const hasRole = (inst: Instance, sweep: Sweeping) => ROLES.some((role) => hasSubtype(inst, role, sweep))

/** The most of these that can each take a different place. */
function most(creatures: readonly Instance[], sweep: Sweeping, role = 0, used: ReadonlySet<string> = new Set()): number {
  if (role === ROLES.length) return 0
  // This place left empty…
  let best = most(creatures, sweep, role + 1, used)
  // …or filled by any one of them not already in.
  for (const c of creatures) {
    if (best === ROLES.length - role) break
    if (used.has(c.iid) || !hasSubtype(c, ROLES[role], sweep)) continue
    best = Math.max(best, 1 + most(creatures, sweep, role + 1, new Set([...used, c.iid])))
  }
  return best
}

/** How many creatures are in your party. */
export function partySize(state: GameState): number {
  const sweep = sweeping(state)
  return most(inZone(state, 'battlefield').filter((c) => isCreature(c) && hasRole(c, sweep)), sweep)
}

/** Are these a party: each in a place of its own? */
export function isParty(state: GameState, creatures: readonly Instance[]): boolean {
  return most(creatures, sweeping(state)) === creatures.length
}
