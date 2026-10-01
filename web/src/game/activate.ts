/**
 * Activating abilities: "cost: effect".
 *
 * The cost is paid in full and then the ability goes on the stack — or, for
 * a mana ability, straight into the pool. Whether it may be activated at all
 * is one check that also says why not, the same as casting.
 *
 * A cost that needs a choice — which creature to sacrifice — asks first.
 * Nothing is paid until that is answered, so backing out costs nothing.
 */

import { compile } from './compiler/compile'
import type { ActivatedAbility } from './compiler/ir'
import { autotap, demand, formatCost, parseCost, type ManaType } from './mana'
import { onBattlefield } from './match'
import { identity, isCreature, manaSources } from './sources'
import { find, inZone, mint, noted, relocate } from './state'
import { hasKeyword, stats } from './stats'
import { isMain } from './turn'
import type { GameState, Instance } from './types'

export const abilitiesOf = (inst: Instance): ActivatedAbility[] => compile(inst.card).activated

/** The cost in a few words, for the menu. */
export function costLabel(ability: ActivatedAbility): string {
  const { cost } = ability
  if (cost.loyalty !== null) return cost.loyalty > 0 ? `+${cost.loyalty}` : cost.loyalty < 0 ? `−${-cost.loyalty}` : '0'
  return [
    cost.mana,
    cost.tap ? '{T}' : '',
    cost.life ? `${cost.life} life` : '',
    cost.sacrificeSelf ? 'sacrifice' : '',
    cost.sacrifice ? 'sacrifice another' : '',
    cost.discardSelf ? 'discard' : '',
    cost.remove ? `−${cost.remove.count} ${cost.remove.counter}` : '',
  ].filter(Boolean).join(', ') || 'free'
}

/** What could be sacrificed to pay for it. */
function sacrificeable(state: GameState, inst: Instance, ability: ActivatedAbility): Instance[] {
  if (!ability.cost.sacrifice) return []
  return onBattlefield(state, ability.cost.sacrifice, inst.iid)
    // "Sacrifice ~" and "a creature" in one cost are two different things.
    .filter((c) => !(ability.cost.sacrificeSelf && c.iid === inst.iid))
}

/** The sources its mana may come from: not itself, if it taps or goes. */
function payers(state: GameState, inst: Instance, ability: ActivatedAbility) {
  const except = new Set(ability.cost.tap || ability.cost.sacrificeSelf ? [inst.iid] : [])
  return manaSources(state, demand(inZone(state, 'hand').map((c) => parseCost(c.card.mana_cost))), except)
}

/** Why this ability cannot be activated now, or null if it can. */
export function activationProblem(state: GameState, iid: string, index: number): string | null {
  const inst = find(state, iid)
  const ability = inst && abilitiesOf(inst)[index]
  if (!inst || !ability) return 'There is no such ability'
  if (state.pending) return 'Finish the choice in front of you first'
  if (inst.zone !== (ability.fromHand ? 'hand' : 'battlefield')) {
    return ability.fromHand ? 'Only from your hand' : 'It is not on the battlefield'
  }
  if (ability.sorcery && !(isMain(state.step) && !state.stack.length)) {
    return 'Only in a main phase, with the stack empty'
  }
  const { cost } = ability
  if (cost.tap) {
    if (inst.tapped) return 'It is already tapped'
    if (isCreature(inst) && inst.sick && !hasKeyword(inst, 'Haste', state)) {
      return 'Summoning sick — it has not been yours since your turn began'
    }
  }
  if (ability.oncePerTurn && state.triggered.includes(`act:${iid}#${index}`)) return 'Only once each turn'
  if (cost.loyalty !== null) {
    // One loyalty ability a turn, for each planeswalker (CR 606.3).
    if (state.triggered.includes(`loyalty:${iid}`)) return 'One loyalty ability a turn'
    if ((inst.loyalty ?? 0) + cost.loyalty < 0) return 'Not enough loyalty'
  }
  if (cost.life > state.life) return 'Not enough life'
  if (cost.remove && (inst.counters?.[cost.remove.counter] ?? 0) < cost.remove.count) {
    return `Not enough ${cost.remove.counter} counters`
  }
  if (cost.sacrifice && !sacrificeable(state, inst, ability).length) return 'Nothing to sacrifice'
  if (cost.mana && !autotap(parseCost(cost.mana), payers(state, inst, ability), { pool: state.pool, life: state.life })) {
    return `Not enough mana — it costs ${formatCost(parseCost(cost.mana))}`
  }
  return null
}

/** Which of a mana ability's kinds to make, when it could make any: the
 *  color the hand most wants, among the commander's. */
function chooseKind(state: GameState, kinds: ManaType[]): ManaType {
  if (kinds.length === 1) return kinds[0]
  const allowed = kinds.filter((k) => (identity(state) as ManaType[]).includes(k))
  const wanted = demand(inZone(state, 'hand').map((c) => parseCost(c.card.mana_cost)))
  const from = allowed.length ? allowed : kinds
  return from.reduce((best, k) => (wanted[k] > wanted[best] ? k : best), from[0])
}

/** Pay everything, and put the ability on the stack. */
function complete(state: GameState, iid: string, index: number, sacrificed: string[]): GameState {
  const inst = find(state, iid)!
  const ability = abilitiesOf(inst)[index]
  const { cost } = ability
  // As they were when the cost was paid: the ability may ask after them.
  const known = Object.fromEntries([iid, ...sacrificed].map((id) => [id, stats(find(state, id)!, state)]))
  let next: GameState = { ...state, pending: null, paying: null }

  if (cost.mana) {
    const paid = autotap(parseCost(cost.mana), payers(next, inst, ability), { pool: next.pool, life: next.life })
    if (!paid) return state
    const tapping = new Set(paid.taps.map((t) => t.id))
    next = {
      ...next,
      pool: paid.pool,
      life: next.life - paid.life,
      cards: next.cards.map((c) => (tapping.has(c.iid) ? { ...c, tapped: true } : c)),
    }
  }
  const marks = [
    ...(ability.oncePerTurn ? [`act:${iid}#${index}`] : []),
    ...(cost.loyalty !== null ? [`loyalty:${iid}`] : []),
  ]
  next = {
    ...next,
    life: next.life - cost.life,
    triggered: marks.length ? [...next.triggered, ...marks] : next.triggered,
    cards: next.cards.map((c) => {
      if (c.iid !== iid) return c
      const counters = cost.remove
        ? { ...c.counters, [cost.remove.counter]: (c.counters?.[cost.remove.counter] ?? 0) - cost.remove.count }
        : c.counters
      return {
        ...c,
        tapped: cost.tap ? true : c.tapped,
        ...(counters ? { counters } : {}),
        ...(cost.loyalty !== null ? { loyalty: (c.loyalty ?? 0) + cost.loyalty } : {}),
      }
    }),
  }
  for (const gone of [...sacrificed, ...(cost.sacrificeSelf || cost.discardSelf ? [iid] : [])]) {
    next = { ...next, cards: relocate(next.cards, gone, 'graveyard') }
  }

  if (ability.mana) {
    const pool = { ...next.pool }
    const made = ability.mana.map((kinds) => chooseKind(state, kinds))
    for (const kind of made) pool[kind] += 1
    return noted({ ...next, pool }, `${inst.card.name}: added ${made.map((k) => `{${k}}`).join('')}`)
  }

  const [id, minted] = mint(next, 's')
  return noted({
    ...minted,
    stack: [...minted.stack, {
      id,
      iid,
      x: 0,
      ability: {
        text: ability.text.split('~').join(inst.card.name),
        effects: ability.effects,
        complete: ability.complete,
        // What was sacrificed for it, if anything: "the sacrificed
        // creature's toughness".
        event: sacrificed[0] ?? null,
        known,
      },
    }],
  }, `Activated ${inst.card.name} — ${costLabel(ability)}`)
}

export function activate(state: GameState, iid: string, index: number): GameState {
  if (activationProblem(state, iid, index)) return state
  const inst = find(state, iid)!
  const ability = abilitiesOf(inst)[index]
  const options = sacrificeable(state, inst, ability)
  if (ability.cost.sacrifice && options.length > 1) {
    return {
      ...state,
      paying: { iid, index },
      pending: {
        kind: 'pick',
        zone: 'battlefield',
        prompt: `${inst.card.name}: sacrifice which?`,
        options: options.map((c) => c.iid),
        min: 1,
        max: 1,
      },
    }
  }
  return complete(state, iid, index, options.map((c) => c.iid))
}

/** The sacrifice is chosen: now pay, and activate. */
export function paid(state: GameState, picked: string[]): GameState {
  const { paying, pending } = state
  if (!paying || pending?.kind !== 'pick' || picked.length !== 1 || !pending.options.includes(picked[0])) return state
  return complete(state, paying.iid, paying.index, picked)
}

