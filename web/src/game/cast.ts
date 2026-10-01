/**
 * Playing cards by the rules: casting a spell onto the stack and paying for
 * it, playing a land, tapping a permanent for mana, and what happens as a
 * permanent arrives.
 *
 * Each check answers with the reason it fails, in words for the table, so the
 * same function decides what is allowed and explains why something is not.
 */

import { entersTapped } from '../lib/landTiming'
import type { Card } from '../lib/api'
import { compile } from './compiler/compile'
import { onBattlefield } from './match'
import { autotap, demand, formatCost, parseCost, type Cost, type ManaType, type Payment } from './mana'
import { seatFor } from './seat'
import { canTapForMana, hasKeyword, isCreature, manaAbilities, manaSources } from './sources'
import { find, inZone, mint, noted, relocate } from './state'
import { isMain } from './turn'
import type { GameState, Instance, Spot } from './types'

/** The printed cost of the face that is cast — a double-faced card keeps it
 *  on its front face rather than on the card. */
export const manaCostOf = (card: Card) => card.mana_cost ?? card.card_faces?.[0]?.mana_cost ?? null

export const isLand = (card: Card) => /\bLand\b/.test(card.type_line ?? '')

/** Lands are permanents too, but they are played rather than cast. */
export const isPermanentSpell = (card: Card) =>
  /\b(Artifact|Creature|Enchantment|Planeswalker|Battle)\b/.test(card.type_line ?? '')

export const rulesText = (card: Card) =>
  card.oracle_text ?? (card.card_faces ?? []).map((f) => f.oracle_text ?? '').filter(Boolean).join('\n')

/** "Forest ×2, Plains" — what was tapped, for the record. */
function listOf(names: string[]) {
  const counts = new Map<string, number>()
  for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1)
  return [...counts].map(([name, n]) => (n > 1 ? `${name} ×${n}` : name)).join(', ')
}

/** Post words beside the board, for you to carry out. */
export function remind(state: GameState, iid: string, name: string, text: string): GameState {
  if (!text.trim()) return state
  const [id, next] = mint(state, 'r')
  return { ...next, reminders: [...next.reminders, { id, iid, name, text }] }
}

/** What a permanent says happens as it enters that nothing here reads yet.
 *  The abilities the compiler did read go on the stack instead. */
export function remindUnread(state: GameState, inst: Instance): GameState {
  const lines = compile(inst.card).unread
    .filter((line) => /^(when|whenever|as) [^,.]*\benters\b/i.test(line))
    .map((line) => line.split('~').join(inst.card.name))
  return remind(state, inst.iid, inst.card.name, lines.join('\n'))
}

/**
 * Put a card onto the battlefield, dealt to its square unless told where.
 *
 * A land works out whether it arrives tapped from the board as it stands —
 * a check land coming down untapped on turn four is the whole reason it is in
 * the deck. `forceTapped` is a fetch land talking: "put it onto the
 * battlefield tapped" is an instruction from the card that found it.
 */
export function enterBattlefield(
  state: GameState,
  iid: string,
  { at, forceTapped = false, x = 0 }: { at?: Spot; forceTapped?: boolean; x?: number } = {},
): { state: GameState; tapped: boolean; why?: string } {
  const inst = find(state, iid)
  if (!inst) return { state, tapped: false }
  const verdict = entersTapped(
    inst.card,
    inZone(state, 'battlefield').filter((c) => c.iid !== iid).map((c) => c.card),
    inZone(state, 'hand').filter((c) => c.iid !== iid).map((c) => c.card),
  )
  const tapped = forceTapped || verdict.tapped
  const seat = at ?? seatFor(state.cards, inst)
  const sick = state.rules && isCreature(inst)
  // "Enters with three +1/+1 counters on it" — or X of them, as it was cast.
  let counters = inst.counters
  for (const fixed of state.rules ? compile(inst.card).statics : []) {
    if (fixed.kind !== 'entersWithCounters') continue
    const n = typeof fixed.count === 'number' ? fixed.count
      : fixed.count === 'X' ? x
        : 'per' in fixed.count ? onBattlefield(state, fixed.count.per, iid).length : 0
    counters = { ...counters, [fixed.counter]: (counters?.[fixed.counter] ?? 0) + n }
  }
  const cards = state.cards.map((c) => (
    c.iid === iid
      ? { ...c, zone: 'battlefield' as const, tapped, sick, ...seat, ...(counters ? { counters } : {}) }
      : c
  ))
  return { state: { ...state, cards }, tapped, why: forceTapped ? undefined : verdict.why }
}

/** Why this land cannot be played now, or null if it can. */
export function landProblem(state: GameState, iid: string): string | null {
  const inst = find(state, iid)
  if (!inst || inst.zone !== 'hand') return 'Only a land in your hand can be played'
  if (!isLand(inst.card)) return 'That is not a land'
  if (state.pending) return 'Finish the choice in front of you first'
  if (!isMain(state.step) || state.stack.length) {
    return 'Lands are played in a main phase, with the stack empty'
  }
  if (state.landsPlayed >= landDrops(state)) {
    return landDrops(state) > 1
      ? 'You have played all your lands for this turn'
      : 'You have already played a land this turn'
  }
  return null
}

/** How many lands you may play this turn: one, plus what effects have
 *  granted, plus one for each Exploration-like permanent you control. */
export function landDrops(state: GameState): number {
  let drops = 1 + state.extraLands
  for (const inst of inZone(state, 'battlefield')) {
    for (const fixed of compile(inst.card).statics) {
      if (fixed.kind === 'extraLand') drops += fixed.count
    }
  }
  return drops
}

/** Play a land: a special action, so no stack and no priority (CR 305). */
export function playLand(state: GameState, iid: string, at?: Spot): GameState {
  if (landProblem(state, iid)) return state
  const inst = find(state, iid)!
  const entered = enterBattlefield(state, iid, { at })
  const because = entered.why ? ` — ${entered.why}` : ''
  const next = noted(
    { ...entered.state, landsPlayed: state.landsPlayed + 1 },
    `Played ${inst.card.name}${entered.tapped ? ' tapped' : ''}${because}`,
  )
  return remindUnread(next, inst)
}

/** The cost as it is paid: the printed cost, plus two for each time a
 *  commander has already been cast from the command zone (CR 903.8). */
export function costOf(state: GameState, inst: Instance): Cost {
  const cost = parseCost(manaCostOf(inst.card))
  if (inst.commander && inst.zone === 'command') {
    return { ...cost, generic: cost.generic + 2 * (state.casts[inst.iid] ?? 0) }
  }
  return cost
}

/** What the rest of the hand wants, so the land it is waiting on is not the
 *  one tapped. */
function wantedBy(state: GameState, except: string) {
  return demand(inZone(state, 'hand')
    .filter((c) => c.iid !== except)
    .map((c) => parseCost(manaCostOf(c.card))))
}

export interface CastCheck {
  /** Why it cannot be cast now; absent when it can. */
  why?: string
  cost: Cost
  /** How it would be paid: what the tapper would tap. */
  payment: Payment | null
}

export function checkCast(state: GameState, iid: string, x = 0): CastCheck {
  const inst = find(state, iid)
  const cost = inst ? costOf(state, inst) : parseCost(null)
  const fail = (why: string): CastCheck => ({ why, cost, payment: null })
  if (!inst) return fail('That card is not here')
  if (state.pending) return fail('Finish the choice in front of you first')
  if (inst.zone !== 'hand' && !(inst.zone === 'command' && inst.commander)) {
    return fail('Only a card in your hand can be cast')
  }
  if (isLand(inst.card)) return fail('Lands are played, not cast')
  const fast = /\bInstant\b/.test(inst.card.type_line ?? '') || hasKeyword(inst, 'Flash')
  if (!fast && !isMain(state.step)) return fail('Sorcery speed — only in a main phase')
  if (!fast && state.stack.length) return fail('Sorcery speed — wait for the stack to resolve')

  const payment = autotap(cost, manaSources(state, wantedBy(state, iid)), {
    x, pool: state.pool, life: state.life,
  })
  if (!payment) return fail(`Not enough mana — it costs ${formatCost(cost)}`)
  return { cost, payment }
}

/** Cast a spell: pay for it, and put it on the stack. */
export function castSpell(state: GameState, iid: string, x = 0): GameState {
  const inst = find(state, iid)
  const check = checkCast(state, iid, x)
  if (!inst || check.why || !check.payment) return state
  const { payment } = check

  const tapping = new Set(payment.taps.map((t) => t.id))
  const cards = relocate(
    state.cards.map((c) => (tapping.has(c.iid) ? { ...c, tapped: true } : c)),
    iid, 'stack',
  )
  const [id, minted] = mint({ ...state, cards }, 's')
  const casts = inst.zone === 'command'
    ? { ...state.casts, [iid]: (state.casts[iid] ?? 0) + 1 }
    : state.casts

  const tapped = payment.taps.map((t) => find(state, t.id)?.card.name ?? '?')
  const line = `Cast ${inst.card.name}${x ? ` (X = ${x})` : ''}${
    tapped.length ? ` — tapped ${listOf(tapped)}` : ''}${
    payment.life ? `, paid ${payment.life} life` : ''}`
  return noted({
    ...minted,
    pool: payment.pool,
    life: state.life - payment.life,
    casts,
    stack: [...state.stack, { id, iid, x }],
  }, line)
}

/** The ways a permanent can be tapped for mana: one per choice of kinds. */
export function manaOptions(state: GameState, iid: string) {
  const inst = find(state, iid)
  if (!inst) return []
  const out: { ability: number; kinds: ManaType[] }[] = []
  manaAbilities(inst, state).forEach((ability, index) => {
    // Every combination of a kind for each mana it makes. Two mana of five
    // colors is the most any card asks, so this stays small.
    let combos: ManaType[][] = [[]]
    for (const unit of ability.makes) {
      combos = combos.flatMap((combo) => unit.map((kind) => [...combo, kind]))
    }
    const seen = new Set<string>()
    for (const kinds of combos) {
      const key = [...kinds].sort().join('')
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ ability: index, kinds })
    }
  })
  return out
}

/** Why this permanent cannot be tapped for mana now, or null if it can. */
export function manaProblem(state: GameState, iid: string): string | null {
  const inst = find(state, iid)
  if (!inst || inst.zone !== 'battlefield') return 'It is not on the battlefield'
  if (inst.tapped) return 'It is already tapped'
  if (!manaAbilities(inst, state).length) return 'It does not make mana'
  if (!canTapForMana(inst)) return 'Summoning sick — it has not been yours since your turn began'
  return null
}

/** Tap a permanent for mana, into the pool. Mana abilities do not use the
 *  stack (CR 605.3). An input, like a Signet's {1}, is paid as a cost is:
 *  from the pool first, then by tapping. */
export function tapForMana(state: GameState, iid: string, ability = 0, kinds: ManaType[] = []): GameState {
  if (manaProblem(state, iid)) return state
  const inst = find(state, iid)!
  const chosen = manaAbilities(inst, state)[ability]
  if (!chosen) return state
  const made = chosen.makes.map((options, i) => (options.includes(kinds[i]) ? kinds[i] : options[0]))

  let next = state
  if (chosen.input) {
    const input: Cost = { generic: chosen.input, pips: [], twobrid: [], phyrexian: [], x: 0 }
    const paid = autotap(input, manaSources(state, {}, new Set([iid])), { pool: state.pool })
    if (!paid) return state
    const tapping = new Set(paid.taps.map((t) => t.id))
    next = {
      ...next,
      pool: paid.pool,
      cards: next.cards.map((c) => (tapping.has(c.iid) ? { ...c, tapped: true } : c)),
    }
  }

  const pool = { ...next.pool }
  for (const kind of made) pool[kind] += 1
  const cards = next.cards.map((c) => (c.iid === iid ? { ...c, tapped: true } : c))
  return noted({ ...next, pool, cards }, `Tapped ${inst.card.name} for ${made.map((k) => `{${k}}`).join('')}`)
}

/** Everything in hand — and a commander at home — that could be played or
 *  cast right now. The table lights these. */
export function playable(state: GameState): Set<string> {
  const out = new Set<string>()
  if (!state.rules || state.pending) return out
  for (const inst of state.cards) {
    const home = inst.zone === 'command' && inst.commander
    if (inst.zone !== 'hand' && !home) continue
    const ok = isLand(inst.card) ? !landProblem(state, inst.iid) : !checkCast(state, inst.iid).why
    if (ok) out.add(inst.iid)
  }
  return out
}
