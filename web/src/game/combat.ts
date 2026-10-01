/**
 * Combat, against an opponent who never blocks.
 *
 * So there is no assigning of damage and no ordering of blockers: an attacker
 * that is declared connects. What is left is who may attack, what it costs
 * them (tapping, unless vigilance), and how much each one deals — its power,
 * or its toughness under Felothar and her kind — and to what total: life,
 * poison for infect, and the separate count kept for each commander.
 */

import { compile } from './compiler/compile'
import type { Static } from './compiler/ir'
import { hasKeyword, isCreature } from './sources'
import { find, inZone, noted } from './state'
import { power, toughness } from './stats'
import type { GameState, Instance } from './types'

/** Whether anything you control says so. */
const anyStatic = (state: GameState, kind: Static['kind']) =>
  inZone(state, 'battlefield').some((c) => compile(c.card).statics.some((fixed) => fixed.kind === kind))

/** The creatures that could be declared as attackers now: untapped, yours
 *  since the turn began or hasty, and not a defender — unless something lets
 *  defenders attack (CR 508.1a, 302.6, 702.3). */
export function eligibleAttackers(state: GameState): Instance[] {
  const wallsAttack = anyStatic(state, 'defendersAttack')
  return inZone(state, 'battlefield').filter((c) => (
    isCreature(c)
    && !c.tapped
    && (!c.sick || hasKeyword(c, 'Haste', state))
    && (!hasKeyword(c, 'Defender', state) || wallsAttack)
  ))
}

/** What one hit from this creature is worth. */
export function combatDamage(state: GameState, inst: Instance): number {
  const amount = anyStatic(state, 'toughnessDamage') ? toughness(inst, state) : power(inst, state)
  return Math.max(0, amount)
}

/** The damage a set of attackers would deal, for the prompt that asks. */
export function expectedDamage(state: GameState, iids: readonly string[]): number {
  return iids.reduce((total, iid) => {
    const inst = find(state, iid)
    if (!inst) return total
    return total + combatDamage(state, inst) * (hasKeyword(inst, 'Double strike', state) ? 2 : 1)
  }, 0)
}

/** How lifegain is multiplied: doubled once for each Rhox Faithmender. */
export function lifeGainFactor(state: GameState) {
  return inZone(state, 'battlefield').reduce((factor, c) => (
    factor * 2 ** compile(c.card).statics.filter((fixed) => fixed.kind === 'doubleLifeGain').length
  ), 1)
}

/** Declare attackers: they tap, unless they have vigilance. */
export function declareAttackers(state: GameState, iids: readonly string[]): GameState {
  const allowed = new Set(eligibleAttackers(state).map((c) => c.iid))
  const attacking = [...new Set(iids)].filter((iid) => allowed.has(iid))
  const set = new Set(attacking)
  const cards = state.cards.map((c) => (
    set.has(c.iid) && !hasKeyword(c, 'Vigilance', state) ? { ...c, tapped: true } : c
  ))
  const names = attacking.map((iid) => find(state, iid)!.card.name).join(', ')
  return noted({ ...state, cards, attacking, pending: null }, attacking.length ? `Attacked with ${names}` : 'No attack')
}

/**
 * Combat damage. Every attacker still on the battlefield hits the opponent:
 * once, or twice with double strike — first strike changes nothing with no
 * blocker to race. Infect is dealt as poison; lifelink gains you as much;
 * a commander's damage is counted on its own (CR 510, 702.90, 903.10).
 */
export function dealCombatDamage(state: GameState): GameState {
  let next = state
  const dealt: string[] = []
  for (const iid of state.attacking) {
    const inst = find(next, iid)
    if (!inst || inst.zone !== 'battlefield') continue
    const amount = combatDamage(next, inst)
    if (amount <= 0) continue
    const hits = hasKeyword(inst, 'Double strike', next) ? 2 : 1
    for (let hit = 0; hit < hits; hit += 1) {
      const infect = hasKeyword(inst, 'Infect', next)
      const opponent = {
        ...next.opponent,
        life: infect ? next.opponent.life : next.opponent.life - amount,
        poison: infect ? next.opponent.poison + amount : next.opponent.poison,
        commander: inst.commander
          ? { ...next.opponent.commander, [iid]: (next.opponent.commander[iid] ?? 0) + amount }
          : next.opponent.commander,
      }
      next = noted({ ...next, opponent }, `${inst.card.name} deals ${amount} ${infect ? 'poison' : 'damage'} to the opponent`)
      if (hasKeyword(inst, 'Lifelink', next)) next = { ...next, life: next.life + amount * lifeGainFactor(next) }
      dealt.push(iid)
    }
  }
  return { ...next, dealt }
}
