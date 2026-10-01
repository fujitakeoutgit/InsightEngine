/**
 * Playing cards by the rules: casting a spell onto the stack and paying for
 * it, resolving it, playing a land, tapping a permanent for mana.
 *
 * Each check answers with the reason it fails, in words for the table, so the
 * same function decides what is allowed and explains why something is not.
 */

import { entersTapped } from '../lib/landTiming'
import type { Card } from '../lib/api'
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
const isPermanentSpell = (card: Card) =>
  /\b(Artifact|Creature|Enchantment|Planeswalker|Battle)\b/.test(card.type_line ?? '')

const rulesText = (card: Card) =>
  card.oracle_text ?? (card.card_faces ?? []).map((f) => f.oracle_text ?? '').filter(Boolean).join('\n')

/** "When this creature enters, …" — the part of a permanent's text that
 *  happens on arrival, which nothing here does for you yet. */
function entersText(card: Card) {
  return rulesText(card)
    .split('\n')
    .filter((line) => /^When(ever)? [^.]*\benters\b/i.test(line.trim()))
    .join('\n')
}

/** "Forest ×2, Plains" — what was tapped, for the record. */
function listOf(names: string[]) {
  const counts = new Map<string, number>()
  for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1)
  return [...counts].map(([name, n]) => (n > 1 ? `${name} ×${n}` : name)).join(', ')
}

function remind(state: GameState, inst: Instance, text: string): GameState {
  if (!text.trim()) return state
  const [id, next] = mint(state, 'r')
  return { ...next, reminders: [...next.reminders, { id, iid: inst.iid, name: inst.card.name, text }] }
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
  { at, forceTapped = false }: { at?: Spot; forceTapped?: boolean } = {},
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
  const cards = state.cards.map((c) => (
    c.iid === iid ? { ...c, zone: 'battlefield' as const, tapped, sick, ...seat } : c
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
  if (state.landsPlayed >= 1) return 'You have already played a land this turn'
  return null
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
  return remind(next, inst, entersText(inst.card))
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

/**
 * The top of the stack resolves.
 *
 * A permanent spell becomes a permanent. Anything else does what it says —
 * which nothing here can do for you yet, so it goes to the graveyard and its
 * words go up beside the board for you to carry out. A permanent that does
 * something as it enters gets the same treatment for that part.
 */
export function resolveTop(state: GameState): GameState {
  const top = state.stack[state.stack.length - 1]
  if (!top) return state
  const stack = state.stack.slice(0, -1)
  const inst = find(state, top.iid)
  if (!inst) return { ...state, stack }

  if (isPermanentSpell(inst.card)) {
    const entered = enterBattlefield({ ...state, stack }, inst.iid).state
    const next = noted(entered, `${inst.card.name} resolves`)
    return remind(next, inst, entersText(inst.card))
  }

  const next = noted(
    { ...state, stack, cards: relocate(state.cards, inst.iid, 'graveyard') },
    `${inst.card.name} resolves`,
  )
  return remind(next, inst, rulesText(inst.card))
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
