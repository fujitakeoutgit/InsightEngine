/**
 * Activating abilities: "cost: effect".
 *
 * The cost is paid in full and then the ability goes on the stack — or, for
 * a mana ability, straight into the pool. Whether it may be activated at all
 * is one check that also says why not, the same as casting.
 *
 * A cost that needs a choice — which creature to sacrifice, which to tap —
 * asks first. Nothing is paid until that is answered, so backing out costs
 * nothing.
 */

import { compile } from './compiler/compile'
import type { ActivatedAbility } from './compiler/ir'
import { autotap, demand, formatCost, parseCost } from './mana'
import { onBattlefield } from './match'
import { chooseKind, isCreature, manaSources } from './sources'
import { find, inZone, mint, noted, relocate } from './state'
import { hasKeyword, power, snapshot } from './stats'
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
    cost.sacrificeAny ? 'sacrifice any number' : '',
    cost.tapOther ? 'tap another' : '',
    cost.crew ? `tap ${cost.crew} power` : '',
    cost.discardSelf ? 'discard' : '',
    cost.remove ? `−${cost.remove.count} ${cost.remove.counter}` : '',
    cost.add ? `+${cost.add.count} ${cost.add.counter}` : '',
  ].filter(Boolean).join(', ') || 'free'
}

/** What could be sacrificed to pay for it — or, for a cost that taps
 *  something else, what could be tapped. An ability asks for one or the
 *  other. */
function payable(state: GameState, inst: Instance, ability: ActivatedAbility): Instance[] {
  const { cost } = ability
  // Crew: any untapped creature of yours but the Vehicle itself — summoning
  // sick or not, since crewing is not a {T} ability of theirs.
  if (cost.crew) {
    return onBattlefield(state, { types: ['creature'], controller: 'you', tapped: false }, inst.iid)
      .filter((c) => c.iid !== inst.iid)
  }
  if (cost.tapOther) return onBattlefield(state, cost.tapOther, inst.iid)
  if (cost.sacrificeAny) return onBattlefield(state, cost.sacrificeAny, inst.iid).filter((c) => c.iid !== inst.iid)
  if (!cost.sacrifice) return []
  return onBattlefield(state, cost.sacrifice, inst.iid)
    // "Sacrifice ~" and "a creature" in one cost are two different things.
    .filter((c) => !(cost.sacrificeSelf && c.iid === inst.iid))
}

/** The sources its mana may come from: not itself, if it taps or goes. */
function payers(state: GameState, inst: Instance, ability: ActivatedAbility) {
  const except = new Set(ability.cost.tap || ability.cost.sacrificeSelf ? [inst.iid] : [])
  return manaSources(state, demand(inZone(state, 'hand').map((c) => parseCost(c.card.mana_cost))), except)
}

/** Why this ability cannot be activated now, or null if it can. */
export function activationProblem(state: GameState, iid: string, index: number, x = 0): string | null {
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
  if (cost.tapOther && !payable(state, inst, ability).length) return 'Nothing to tap for it'
  if (cost.crew && payable(state, inst, ability).reduce((n, c) => n + Math.max(0, power(c, state)), 0) < cost.crew) {
    return `Not enough power to crew it — it takes ${cost.crew}`
  }
  if (cost.sacrifice && !payable(state, inst, ability).length) return 'Nothing to sacrifice'
  if (cost.mana && !autotap(parseCost(cost.mana), payers(state, inst, ability), { x, pool: state.pool, life: state.life })) {
    return `Not enough mana — it costs ${formatCost(parseCost(cost.mana))}`
  }
  return null
}

/** Pay everything, and put the ability on the stack. `picked` is what was
 *  chosen for the part of the cost that takes a choice. */
function complete(state: GameState, iid: string, index: number, picked: string[], x = 0): GameState {
  const inst = find(state, iid)!
  const ability = abilitiesOf(inst)[index]
  const { cost } = ability
  const tapping = Boolean(cost.tapOther || cost.crew)
  const sacrificed = tapping ? [] : picked
  // As they were when the cost was paid: the ability may ask after them.
  const known = Object.fromEntries([iid, ...sacrificed].map((id) => [id, snapshot(find(state, id)!, state)]))
  let next: GameState = { ...state, pending: null, paying: null }
  // What is tapped as the cost is tapped first, so it is not also tapped
  // for the mana.
  if (tapping) {
    next = { ...next, cards: next.cards.map((c) => (picked.includes(c.iid) ? { ...c, tapped: true } : c)) }
  }

  if (cost.mana) {
    const paid = autotap(parseCost(cost.mana), payers(next, inst, ability), { x, pool: next.pool, life: next.life })
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
      const taken = cost.remove
        ? { ...c.counters, [cost.remove.counter]: (c.counters?.[cost.remove.counter] ?? 0) - cost.remove.count }
        : c.counters
      const counters = cost.add
        ? { ...taken, [cost.add.counter]: (taken?.[cost.add.counter] ?? 0) + cost.add.count }
        : taken
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
      x,
      ability: {
        text: ability.text.split('~').join(inst.card.name),
        effects: ability.effects,
        complete: ability.complete,
        // What was sacrificed for it, if anything: "the sacrificed
        // creature's toughness".
        event: sacrificed[0] ?? null,
        known,
        // …and how many, itself included: "for each creature sacrificed
        // this way".
        amount: sacrificed.length + (cost.sacrificeSelf ? 1 : 0),
      },
    }],
  }, `Activated ${inst.card.name} — ${costLabel(ability)}${x ? ` (X = ${x})` : ''}`)
}

export function activate(state: GameState, iid: string, index: number, x = 0): GameState {
  if (activationProblem(state, iid, index, x)) return state
  const inst = find(state, iid)!
  const ability = abilitiesOf(inst)[index]
  const options = payable(state, inst, ability)
  // Crew: as many as it takes to add up to enough power.
  if (ability.cost.crew) {
    const { crew } = ability.cost
    return {
      ...state,
      paying: { iid, index, x },
      pending: {
        kind: 'pick',
        zone: 'battlefield',
        prompt: `${inst.card.name}: tap creatures with total power ${crew} or more to crew it`,
        options: options.map((c) => c.iid),
        min: 1,
        max: options.length,
        budget: {
          min: crew, max: 9999, of: 'power',
          cost: Object.fromEntries(options.map((c) => [c.iid, Math.max(0, power(c, state))])),
        },
      },
    }
  }
  // Any number of them: asked whenever there is one to give up, since none
  // is an answer too.
  if (ability.cost.sacrificeAny) {
    if (!options.length) return complete(state, iid, index, [], x)
    return {
      ...state,
      paying: { iid, index, x },
      pending: {
        kind: 'pick',
        zone: 'battlefield',
        prompt: `${inst.card.name}: sacrifice any number of these as well`,
        options: options.map((c) => c.iid),
        min: 0,
        max: options.length,
      },
    }
  }
  if (options.length > 1) {
    return {
      ...state,
      paying: { iid, index, x },
      pending: {
        kind: 'pick',
        zone: 'battlefield',
        prompt: `${inst.card.name}: ${ability.cost.tapOther ? 'tap' : 'sacrifice'} which?`,
        options: options.map((c) => c.iid),
        min: 1,
        max: 1,
      },
    }
  }
  return complete(state, iid, index, options.map((c) => c.iid), x)
}

/** What to sacrifice, or to tap, is chosen: now pay, and activate. */
export function paid(state: GameState, picked: string[]): GameState {
  const { paying, pending } = state
  if (!paying || pending?.kind !== 'pick') return state
  const chosen = [...new Set(picked)]
  if (chosen.length < pending.min || chosen.length > pending.max) return state
  if (!chosen.every((iid) => pending.options.includes(iid))) return state
  // Too little power between them to crew it.
  const { budget } = pending
  if (budget?.min && chosen.reduce((n, iid) => n + (budget.cost[iid] ?? 0), 0) < budget.min) return state
  return complete(state, paying.iid, paying.index, chosen, paying.x ?? 0)
}

