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
import { amount } from './amount'
import { compile } from './compiler/compile'
import { isCreatureType } from './compiler/subtypes'
import { holds } from './holds'
import { forSource, isKind, sweeping } from './kinds'
import { matches, onBattlefield } from './match'
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
  // Everything is new the turn it arrives, creature or not: a Vehicle
  // crewed, or a land brought to life, cannot attack until it has been here
  // since a turn began.
  const sick = state.rules
  // Echo is owed at the upkeep after it arrives.
  const echo = state.rules && compile(inst.card).statics.some((fixed) => fixed.kind === 'echo')
  // "Enters with three +1/+1 counters on it" — or X of them, as it was cast.
  let counters = inst.counters
  for (const fixed of state.rules ? compile(inst.card).statics : []) {
    if (fixed.kind !== 'entersWithCounters') continue
    const n = amount(state, { x, source: iid, chosen: [], event: null, known: {}, last: 0 }, fixed.count)
    counters = { ...counters, [fixed.counter]: (counters?.[fixed.counter] ?? 0) + n }
  }
  // A Saga begins with its first chapter.
  if (state.rules && compile(inst.card).statics.some((fixed) => fixed.kind === 'saga')) {
    counters = { ...counters, lore: (counters?.lore ?? 0) + 1 }
  }
  const cards = state.cards.map((c) => (
    c.iid === iid
      ? {
          ...c, zone: 'battlefield' as const, tapped, sick, ...seat,
          ...(counters ? { counters } : {}), ...(echo ? { echo } : {}),
          mayPlay: undefined, exiledBy: undefined,
        }
      : c
  ))
  return { state: { ...state, cards }, tapped, why: forceTapped ? undefined : verdict.why }
}

/** The top card of your library, while something lets you look at it. */
export function revealedTop(state: GameState): Instance | null {
  if (!state.rules) return null
  const seen = inZone(state, 'battlefield').some((c) => (
    compile(c.card).statics.some((fixed) => fixed.kind === 'lookTop' || fixed.kind === 'playTop')
  ))
  return seen ? state.cards.find((c) => c.zone === 'library') ?? null : null
}

/** May the top card of the library be played from there? Something on the
 *  battlefield has to say so, of lands or of spells like this one. */
function topPlay(state: GameState, inst: Instance): boolean {
  if (state.cards.find((c) => c.zone === 'library')?.iid !== inst.iid) return false
  return inZone(state, 'battlefield').some((source) => compile(source.card).statics.some((fixed) => (
    fixed.kind === 'playTop' && (isLand(inst.card)
      ? fixed.lands
      : fixed.spells !== null && matches(inst, fixed.spells, source.iid, state))
  )))
}

/** Where a card would be played from, if it may be played from where it is:
 *  your hand, the command zone for a commander, exile for a card you were
 *  told you may play, the top of your library when a permanent allows it. */
export function playedFrom(state: GameState, inst: Instance): 'hand' | 'command' | 'exile' | 'top' | null {
  if (inst.zone === 'hand') return 'hand'
  if (inst.zone === 'command') return inst.commander ? 'command' : null
  if (inst.zone === 'exile') return inst.mayPlay ? 'exile' : null
  return inst.zone === 'library' && topPlay(state, inst) ? 'top' : null
}

/** The permanent that would let this spell be cast without paying this
 *  turn — One with the Multiverse, not yet used — if there is one. */
export function freeSource(state: GameState, inst: Instance): Instance | null {
  const from = playedFrom(state, inst)
  if (!state.rules || isLand(inst.card) || (from !== 'hand' && from !== 'top')) return null
  return inZone(state, 'battlefield').find((c) => (
    compile(c.card).statics.some((fixed) => fixed.kind === 'freeSpell') && !state.triggered.includes(`free:${c.iid}`)
  )) ?? null
}

/** Why this land cannot be played now, or null if it can. */
export function landProblem(state: GameState, iid: string): string | null {
  const inst = find(state, iid)
  if (!inst || !playedFrom(state, inst)) return 'Only a land in your hand can be played'
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
  const tax = inst.commander && inst.zone === 'command' ? 2 * (state.casts[inst.iid] ?? 0) : 0
  const less = discount(state, inst)
  // Morophon takes off colored mana: one pip of each color it names, where
  // the spell has one.
  const pips = [...cost.pips]
  for (const color of less.colored) {
    const at = pips.findIndex((pip) => pip.length === 1 && pip[0] === color)
    if (at >= 0) pips.splice(at, 1)
  }
  // Everything else takes off generic mana, and no further than none of it.
  return { ...cost, pips, generic: Math.max(0, cost.generic + tax - less.generic) }
}

/** How many creature types there are among creatures you control. One
 *  changeling is all of them, which is more than anything asks for. */
function creatureTypes(state: GameState): number {
  const creatures = inZone(state, 'battlefield').filter(isCreature)
  if (sweeping(state).creatures || creatures.some((c) => hasKeyword(c, 'Changeling', state))) return 300
  return new Set(creatures.flatMap((c) => (
    (c.card.type_line ?? '').split(/\s+—\s+/)[1]?.split(/\s+/).filter(isCreatureType) ?? []
  ))).size
}

/** Generic mana taken off a spell: by permanents that say so ("blue spells
 *  you cast cost {1} less"), and by the spell itself ("costs {1} less to
 *  cast for each creature on the battlefield"). */
function discount(state: GameState, inst: Instance): { generic: number; colored: string } {
  if (!state.rules) return { generic: 0, colored: '' }
  let less = 0
  let colored = ''
  for (const source of inZone(state, 'battlefield')) {
    for (const fixed of compile(source.card).statics) {
      if (fixed.kind !== 'costLess') continue
      if (!isKind(inst, forSource(fixed.filter, source), source.iid, sweeping(state))) continue
      less += fixed.amount
      colored += fixed.colored ?? ''
    }
  }
  const asking = { x: 0, source: inst.iid, chosen: [], event: null, known: {}, last: 0 }
  for (const fixed of compile(inst.card).statics) {
    if (fixed.kind !== 'selfCostLess') continue
    let mine = 0
    if (fixed.per) mine = fixed.amount * onBattlefield(state, fixed.per, inst.iid).length
    else if (fixed.perType) mine = fixed.amount * creatureTypes(state)
    else if (!fixed.when || holds(state, asking, fixed.when)) mine = fixed.amount
    less += fixed.max === undefined ? mine : Math.min(mine, fixed.max)
  }
  return { generic: less, colored }
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

/** `free` asks after casting it without paying its mana cost, as the turn's
 *  one spell that something on the battlefield allows that of. A card in
 *  exile that may be played for nothing always is. */
export function checkCast(state: GameState, iid: string, x = 0, free = false): CastCheck {
  const inst = find(state, iid)
  const gratis = Boolean(inst && (free || inst.mayPlay?.free))
  const cost = !inst || gratis ? parseCost(null) : costOf(state, inst)
  const fail = (why: string): CastCheck => ({ why, cost, payment: null })
  if (!inst) return fail('That card is not here')
  if (state.pending) return fail('Finish the choice in front of you first')
  if (!playedFrom(state, inst)) return fail('Only a card in your hand can be cast')
  if (isLand(inst.card)) return fail('Lands are played, not cast')
  const fast = /\bInstant\b/.test(inst.card.type_line ?? '') || hasKeyword(inst, 'Flash')
  if (!fast && !isMain(state.step)) return fail('Sorcery speed — only in a main phase')
  if (!fast && state.stack.length) return fail('Sorcery speed — wait for the stack to resolve')
  if (free && !inst.mayPlay?.free && !freeSource(state, inst)) return fail('Nothing lets it be cast without paying')
  if (gratis) return { cost, payment: { taps: [], life: 0, pool: state.pool } }

  const payment = autotap(cost, manaSources(state, wantedBy(state, iid)), {
    x, pool: state.pool, life: state.life,
  })
  if (!payment) return fail(`Not enough mana — it costs ${formatCost(cost)}`)
  return { cost, payment }
}

/** Cast a spell: pay for it — or, `free`, do not — and put it on the stack. */
export function castSpell(state: GameState, iid: string, asked = 0, free = false): GameState {
  const inst = find(state, iid)
  const gratis = Boolean(inst && (free || inst.mayPlay?.free))
  // With no mana cost paid, X is nothing (CR 107.3b).
  const x = gratis ? 0 : asked
  const check = checkCast(state, iid, x, free)
  if (!inst || check.why || !check.payment) return state
  const { payment } = check
  // The turn's one free spell is spent on this.
  const allowing = free && !inst.mayPlay?.free ? freeSource(state, inst) : null

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
  const from = playedFrom(state, inst)
  const line = `Cast ${inst.card.name}${x ? ` (X = ${x})` : ''}${
    from === 'exile' ? ' from exile' : from === 'top' ? ' from the top of your library' : ''}${
    gratis ? ' without paying its mana cost' : ''}${
    tapped.length ? ` — tapped ${listOf(tapped)}` : ''}${
    payment.life ? `, paid ${payment.life} life` : ''}`
  return noted({
    ...minted,
    pool: payment.pool,
    life: state.life - payment.life,
    casts,
    triggered: allowing ? [...minted.triggered, `free:${allowing.iid}`] : minted.triggered,
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
  if (!canTapForMana(inst, state)) return 'Summoning sick — it has not been yours since your turn began'
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

/** Everything in hand — and a commander at home, a card in exile you may
 *  play, the top of the library when that is allowed — that could be played
 *  or cast right now. The table lights these. */
export function playable(state: GameState): Set<string> {
  const out = new Set<string>()
  if (!state.rules || state.pending) return out
  const top = state.cards.find((c) => c.zone === 'library')
  for (const inst of state.cards) {
    // Of the library, only its top card could be.
    if (inst.zone === 'library' ? inst !== top : !playedFrom(state, inst)) continue
    const ok = isLand(inst.card)
      ? !landProblem(state, inst.iid)
      : !checkCast(state, inst.iid).why || (freeSource(state, inst) !== null && !checkCast(state, inst.iid, 0, true).why)
    if (ok) out.add(inst.iid)
  }
  return out
}
