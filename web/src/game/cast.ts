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
import type { Filter } from './compiler/ir'
import { isCreatureType } from './compiler/subtypes'
import { backOf } from './faces'
import { holds } from './holds'
import { forSource, isKind, sweeping } from './kinds'
import { matches, onBattlefield } from './match'
import {
  autotap, demand, formatCost, parseCost, type Cost, type ManaSource, type ManaType, type Payment,
} from './mana'
import { seatFor } from './seat'
import { partySize } from './party'
import {
  canTapForMana, hasKeyword, isCreature, manaAbilities, manaSources, realId, tapForPayment, withStorage,
} from './sources'
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
export function playedFrom(
  state: GameState, inst: Instance,
): 'hand' | 'command' | 'exile' | 'top' | 'graveyard' | null {
  if (inst.zone === 'hand') return 'hand'
  if (inst.zone === 'command') return inst.commander ? 'command' : null
  if (inst.zone === 'exile') return inst.mayPlay ? 'exile' : null
  // Mayhem: from the graveyard, the turn it was discarded.
  // …or its aftermath half, any turn.
  if (inst.zone === 'graveyard') {
    if (!state.rules) return null
    const mayhem = inst.discarded === state.turn && compile(inst.card).ways.some((way) => way.kind === 'mayhem')
    return mayhem || aftermath(inst.card) ? 'graveyard' : null
  }
  return inst.zone === 'library' && topPlay(state, inst) ? 'top' : null
}

/** Has it a half that is cast only from the graveyard? */
function aftermath(card: Card): boolean {
  const back = backOf(card)
  return Boolean(back && compile(back).statics.some((fixed) => fixed.kind === 'aftermath'))
}

/** A permanent that lets spells like this be cast for another cost —
 *  Rooftop Storm's {0} for Zombies — and that cost. */
function altCost(state: GameState, inst: Instance): { source: Instance; cost: string } | null {
  for (const source of inZone(state, 'battlefield')) {
    for (const fixed of compile(source.card).statics) {
      if (fixed.kind === 'altCost' && matches(inst, fixed.filter, source.iid, state)) return { source, cost: fixed.cost }
    }
  }
  return null
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
export function costOf(state: GameState, inst: Instance, base: string | null = manaCostOf(inst.card)): Cost {
  const cost = parseCost(base)
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
    else if (fixed.party) mine = fixed.amount * partySize(state)
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

/** What a creature may mutate onto: a non-Human creature you own. */
export const MUTATES_ONTO: Filter = { types: ['creature'], notSubtypes: ['Human'], controller: 'you' }

/** The creatures this spell could mutate onto, as things stand. */
export const mutable = (state: GameState, iid: string): Instance[] => onBattlefield(state, MUTATES_ONTO, iid)

/** Cards in hand that could be exiled to pay for this one. */
export function pitchable(state: GameState, inst: Instance): Instance[] {
  const pitch = compile(inst.card).ways.find((way) => way.kind === 'pitch')
  return pitch?.kind === 'pitch'
    ? inZone(state, 'hand').filter((c) => c.iid !== inst.iid && matches(c, pitch.filter, inst.iid))
    : []
}

/** Creatures that could be tapped to help pay for a spell with convoke: any
 *  untapped one of yours, summoning sick or not. Each pays for one mana of
 *  its colors, or for {1}. They go before the lands: a creature chosen to
 *  convoke is one you mean to tap. */
function convokers(state: GameState): ManaSource[] {
  return inZone(state, 'battlefield')
    .filter((c) => isCreature(c) && !c.tapped)
    .map((c) => {
      const colors = [...(c.card.colors ?? '')].filter((k): k is ManaType => 'WUBRG'.includes(k))
      return { id: c.iid, makes: [colors.length ? colors : ['C' as ManaType]], penalty: 0 }
    })
}

/** How many mana a cost comes to, with X as chosen. */
const owed = (cost: Cost, x: number) =>
  cost.generic + cost.pips.length + cost.phyrexian.length + 2 * cost.twobrid.length + x * cost.x

/**
 * Convoke is a choice: which creatures tap to help. The ones that could, the
 * most that could be of use, and whether any is needed at all — or null,
 * where the spell cannot be convoked.
 */
export function convokeChoice(state: GameState, iid: string, x = 0): { options: string[]; min: number; max: number } | null {
  const open = checkCast(state, iid, x, 'convoke')
  if (!open.payment) return null
  const options = convokers(state).map((c) => c.id)
  return {
    options,
    // With nothing chosen the lands pay for all of it, if they can.
    min: checkCast(state, iid, x, 'convoke', []).payment ? 0 : 1,
    max: Math.min(options.length, owed(open.cost, x)),
  }
}

/** What casting it this way takes, before anything is paid: the mana, and
 *  why not, if the way is not open. */
function wayOf(state: GameState, inst: Instance, way: string): { cost: Cost; why?: string; gratis?: boolean } {
  const zero = parseCost(null)
  const from = playedFrom(state, inst)
  const ways = compile(inst.card).ways
  const printed = inst.mayPlay?.free ? null : manaCostOf(inst.card)
  const closed = (why: string) => ({ cost: zero, why })
  const priced = (kind: 'evoke' | 'kicker' | 'freerunning' | 'mayhem' | 'overload' | 'mutate') => {
    const found = ways.find((other) => other.kind === kind)
    return found && 'cost' in found ? found.cost : null
  }
  switch (way) {
    case 'normal':
      if (from === 'graveyard') return closed('From the graveyard it is cast for its mayhem cost')
      return { cost: costOf(state, inst, printed), gratis: Boolean(inst.mayPlay?.free) }
    case 'free':
      return freeSource(state, inst) ? { cost: zero, gratis: true } : closed('Nothing lets it be cast without paying')
    case 'evoke': {
      const cost = priced('evoke')
      return cost && from !== 'graveyard' ? { cost: costOf(state, inst, cost) } : closed('It has no evoke cost')
    }
    case 'overload': {
      const cost = priced('overload')
      return cost && from !== 'graveyard' ? { cost: costOf(state, inst, cost) } : closed('It has no overload cost')
    }
    case 'kicked': {
      const cost = priced('kicker')
      return cost && from !== 'graveyard' ? { cost: costOf(state, inst, `${printed ?? ''}${cost}`) } : closed('It has no kicker')
    }
    case 'freerunning': {
      const cost = priced('freerunning')
      if (!cost || from === 'graveyard') return closed('It has no freerunning cost')
      return state.tally.struck > 0
        ? { cost: costOf(state, inst, cost) }
        : closed('No Assassin or commander of yours has dealt combat damage to a player this turn')
    }
    case 'mayhem': {
      const cost = priced('mayhem')
      return cost && from === 'graveyard' && inst.discarded === state.turn
        ? { cost: costOf(state, inst, cost) }
        : closed('Mayhem is for a card discarded this turn')
    }
    case 'mutate': {
      const cost = priced('mutate')
      if (!cost || from === 'graveyard') return closed('It has no mutate cost')
      return mutable(state, inst.iid).length
        ? { cost: costOf(state, inst, cost) }
        : closed('No non-Human creature of yours to mutate onto')
    }
    // Its other half: an adventure, or the second half of a split card —
    // which, with aftermath, is cast from the graveyard and nowhere else.
    case 'back': {
      const back = backOf(inst.card)
      if (!back) return closed('It has no other half')
      const buried = aftermath(inst.card)
      if (buried ? from !== 'graveyard' : from === 'graveyard' || from === 'exile') {
        return closed(buried ? `${back.name} is cast only from the graveyard` : `${back.name} is cast from your hand`)
      }
      return { cost: costOf(state, inst, back.mana_cost) }
    }
    case 'alt': {
      const alt = altCost(state, inst)
      return alt && from !== 'graveyard' ? { cost: costOf(state, inst, alt.cost) } : closed('Nothing gives it another cost')
    }
    case 'pitch': {
      const pitch = ways.find((other) => other.kind === 'pitch')
      if (pitch?.kind !== 'pitch' || from === 'graveyard') return closed('It has no other cost')
      return pitchable(state, inst).length >= pitch.count
        ? { cost: zero, gratis: true }
        : closed('Not enough cards in hand to exile for it')
    }
    case 'behold': {
      const behold = ways.find((other) => other.kind === 'behold')
      if (behold?.kind !== 'behold' || from === 'graveyard') return closed('It has nothing to behold')
      const shown = onBattlefield(state, { ...behold.filter, controller: 'you' }, inst.iid).length > 0
        || inZone(state, 'hand').some((c) => c.iid !== inst.iid && matches(c, behold.filter, inst.iid))
      return shown ? { cost: costOf(state, inst, printed) } : closed('Nothing to behold')
    }
    case 'convoke':
      if (!compile(inst.card).statics.some((fixed) => fixed.kind === 'convoke')) return closed('It does not have convoke')
      if (from === 'graveyard') return closed('From the graveyard it is cast for its mayhem cost')
      if (!convokers(state).length) return closed('No creature to tap for it')
      if (!owed(costOf(state, inst, printed), 1)) return closed('It costs nothing to help pay for')
      return { cost: costOf(state, inst, printed) }
    default:
      return closed('There is no such way to cast it')
  }
}

/** Whether it can be cast now, `way` being how: for what it costs, or one of
 *  the other ways the card or the board allows — evoked, kicked, without
 *  paying. A card in exile that may be played for nothing always is.
 *  `helpers` are the creatures chosen to convoke it, every one of which has
 *  to pay for something; left out, any creature may, which is the question
 *  of whether it could be convoked at all. */
export function checkCast(state: GameState, iid: string, x = 0, way = 'normal', helpers?: readonly string[]): CastCheck {
  const inst = find(state, iid)
  const how = inst ? wayOf(state, inst, way) : { cost: parseCost(null) }
  const { cost } = how
  const fail = (why: string): CastCheck => ({ why, cost, payment: null })
  if (!inst) return fail('That card is not here')
  if (state.pending) return fail('Finish the choice in front of you first')
  if (!playedFrom(state, inst)) return fail('Only a card in your hand can be cast')
  if (isLand(inst.card)) return fail('Lands are played, not cast')
  if (inst.mayPlay?.after !== undefined && state.turn <= inst.mayPlay.after) {
    return fail('Plotted this turn — it can be cast on a later one')
  }
  // A plotted card is cast as a sorcery, whatever it is. A card cast as its
  // other half is as fast as that half.
  const casting = way === 'back' ? backOf(inst.card) ?? inst.card : inst.card
  const fast = !inst.mayPlay?.sorcery && (/\bInstant\b/.test(casting.type_line ?? '') || hasKeyword(inst, 'Flash'))
  if (!fast && !isMain(state.step)) return fail('Sorcery speed — only in a main phase')
  if (!fast && state.stack.length) return fail('Sorcery speed — wait for the stack to resolve')
  if (how.why) return fail(how.why)
  if (how.gratis) return { cost, payment: { taps: [], life: 0, pool: state.pool } }

  const wanted = wantedBy(state, iid)
  const sources = manaSources(state, wanted, undefined, { spell: inst })
  // Creatures help only a spell that is being convoked: paid for the
  // ordinary way, it is paid for with mana.
  const helping = way === 'convoke' ? convokers(state).filter((c) => !helpers || helpers.includes(c.id)) : []
  // A creature that could also be tapped for mana is one or the other.
  const paying = [...sources.filter((source) => !helping.some((c) => c.id === source.id)), ...helping]
  const budget = { x, pool: state.pool, life: state.life }
  // Counters stored on a land are spent only when nothing else will do.
  const payment = autotap(cost, paying, budget)
    ?? autotap(cost, withStorage(state, paying, { spell: inst }), budget)
  if (!payment) return fail(`Not enough mana — it costs ${formatCost(cost)}`)
  if (helpers && !helpers.every((id) => payment.taps.some((tap) => tap.id === id))) {
    return fail('Those creatures cannot all help pay for it')
  }
  return { cost, payment }
}

/** A way a spell could be cast right now, in words for the question. */
export interface CastWay { key: string; label: string }

/** "You may exile two green cards from your hand rather than pay this
 *  spell's mana cost", as a button: what you do, and that it is instead. */
function pitchLabel(text: string) {
  const what = text.replace(/^you may /i, '').replace(/ rather than pay .*$/i, '')
  return `${what[0].toUpperCase()}${what.slice(1)} instead of paying`
}

/** Every way this card could be cast as things stand. One of them, usually:
 *  for what it costs. */
export function castWays(state: GameState, inst: Instance): CastWay[] {
  const compiled = compile(inst.card)
  const named = (kind: string) => compiled.ways.find((way) => way.kind === kind)
  const offered: [string, boolean][] = [
    ['normal', true],
    ['free', freeSource(state, inst) !== null],
    ['evoke', Boolean(named('evoke'))],
    ['overload', Boolean(named('overload'))],
    ['kicked', Boolean(named('kicker'))],
    ['freerunning', Boolean(named('freerunning'))],
    ['mayhem', Boolean(named('mayhem'))],
    ['mutate', Boolean(named('mutate'))],
    ['pitch', Boolean(named('pitch'))],
    ['behold', Boolean(named('behold'))],
    ['convoke', compiled.statics.some((fixed) => fixed.kind === 'convoke')],
    ['back', backOf(inst.card) !== null],
    ['alt', altCost(state, inst) !== null],
  ]
  const back = backOf(inst.card)
  const out: CastWay[] = []
  for (const [key, has] of offered) {
    if (!has) continue
    const check = checkCast(state, inst.iid, 0, key)
    if (check.why) continue
    const price = formatCost(check.cost)
    const pitch = named('pitch')
    const behold = named('behold')
    const source = freeSource(state, inst)
    out.push({
      key,
      label: key === 'normal' ? (inst.mayPlay?.free ? 'Cast it' : back ? `${inst.card.name} — ${price}` : `Pay ${price}`)
        : key === 'back' && back ? `${back.name} — ${price}${
          inst.card.layout === 'adventure' ? ', an adventure' : aftermath(inst.card) ? ', then it is exiled' : ''}`
        : key === 'alt' ? `Pay ${price} — ${altCost(state, inst)?.source.card.name ?? ''}`
        : key === 'free' ? `Without paying — ${source?.card.name ?? ''}, once each turn`
          : key === 'evoke' ? `Evoke ${price} — it is sacrificed when it enters`
          : key === 'overload' ? `Overload ${price} — each, where it says target`
            : key === 'kicked' ? `Kicked — ${price}`
              : key === 'freerunning' ? `Freerunning ${price}`
                : key === 'mayhem' ? `Mayhem ${price}`
                : key === 'mutate' ? `Mutate ${price} — onto a non-Human creature of yours`
                  : key === 'pitch' && pitch?.kind === 'pitch' ? pitchLabel(pitch.text)
                    : key === 'behold' && behold?.kind === 'behold' ? `${behold.text} — ${price}`
                      : `Convoke ${price} — choose creatures to help pay`,
    })
  }
  return out
}

/** Cast a spell: pay for it, the way it is being cast, and put it on the
 *  stack. `pitched` is what was chosen to pay with: the cards exiled from
 *  hand where that is the cost, or the creatures that convoke it. */
export function castSpell(
  state: GameState, iid: string, asked = 0, way = 'normal', pitched: readonly string[] = [],
): GameState {
  const inst = find(state, iid)
  const gratis = Boolean(inst && wayOf(state, inst, way).gratis)
  // With no mana cost paid, X is nothing (CR 107.3b).
  const x = gratis ? 0 : asked
  if (way === 'convoke' && new Set(pitched).size !== pitched.length) return state
  const check = checkCast(state, iid, x, way, way === 'convoke' ? pitched : undefined)
  if (!inst || check.why || !check.payment) return state
  const { payment } = check
  // The turn's one free spell is spent on this.
  const allowing = way === 'free' ? freeSource(state, inst) : null
  if (way === 'pitch') {
    const pitch = compile(inst.card).ways.find((other) => other.kind === 'pitch')
    const able = new Set(pitchable(state, inst).map((c) => c.iid))
    if (pitch?.kind !== 'pitch' || pitched.length !== pitch.count || new Set(pitched).size !== pitch.count
      || !pitched.every((id) => able.has(id))) return state
  }

  const tapping = new Set(payment.taps.map((t) => t.id))
  const convoked = way === 'convoke' ? [...pitched] : []
  let paid = tapForPayment(state, tapping)
  for (const gone of way === 'pitch' ? pitched : []) paid = relocate(paid, gone, 'exile')
  // Cast as its other half, it is that half while it is on the stack.
  const half = way === 'back' ? backOf(inst.card) : null
  const cards = relocate(paid, iid, 'stack')
    .map((c) => (c.iid === iid && half ? { ...c, card: half, original: inst.card } : c))
  const [id, minted] = mint({ ...state, cards }, 's')
  const casts = inst.zone === 'command'
    ? { ...state.casts, [iid]: (state.casts[iid] ?? 0) + 1 }
    : state.casts

  const tapped = [...new Set(payment.taps.map((t) => realId(t.id)))].map((tap) => find(state, tap)?.card.name ?? '?')
  const from = playedFrom(state, inst)
  const how = way === 'evoke' ? ' for its evoke cost' : way === 'kicked' ? ', kicked' : way === 'overload' ? ', overloaded'
    : way === 'freerunning' ? ' for its freerunning cost' : way === 'mayhem' ? ' for its mayhem cost'
      : way === 'mutate' ? ' for its mutate cost' : way === 'behold' ? ', beholding' : ''
  const line = `Cast ${half?.name ?? inst.card.name}${x ? ` (X = ${x})` : ''}${how}${
    from === 'exile' ? ' from exile' : from === 'top' ? ' from the top of your library'
      : from === 'graveyard' ? ' from the graveyard' : ''}${
    way === 'pitch' ? ` — exiled ${listOf(pitched.map((gone) => find(state, gone)?.card.name ?? '?'))} from hand`
      : gratis ? ' without paying its mana cost' : ''}${
    tapped.length ? ` — tapped ${listOf(tapped)}` : ''}${
    payment.life ? `, paid ${payment.life} life` : ''}`
  return noted({
    ...minted,
    pool: payment.pool,
    life: state.life - payment.life,
    casts,
    triggered: allowing ? [...minted.triggered, `free:${allowing.iid}`] : minted.triggered,
    stack: [...state.stack, {
      id, iid, x,
      ...(way === 'normal' || way === 'convoke' ? {} : { way }),
      ...(convoked.length ? { convoked } : {}),
    }],
  }, line)
}

/** The ways a permanent can be tapped for mana: one per choice of kinds. */
export function manaOptions(state: GameState, iid: string) {
  const inst = find(state, iid)
  if (!inst) return []
  const out: { ability: number; kinds: ManaType[] }[] = []
  manaAbilities(inst, state).forEach((ability, index) => {
    // Counters stored up are spent by the tapper, as a spell needs them.
    if (ability.storage) return
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
  if (!chosen || chosen.storage) return state
  const made = chosen.makes.map((options, i) => (options.includes(kinds[i]) ? kinds[i] : options[0]))

  let next = state
  if (chosen.input) {
    const input: Cost = { generic: chosen.input, pips: [], twobrid: [], phyrexian: [], x: 0 }
    const paid = autotap(input, manaSources(state, {}, new Set([iid])), { pool: state.pool })
    if (!paid) return state
    const tapping = new Set(paid.taps.map((t) => t.id))
    next = { ...next, pool: paid.pool, cards: tapForPayment(next, tapping) }
  }

  const pool = { ...next.pool }
  for (const kind of made) pool[kind] += 1
  const { rider } = chosen
  const cards = next.cards.map((c) => (
    c.iid === iid
      ? { ...c, tapped: true, ...(rider ? { counters: { ...c.counters, [rider]: (c.counters?.[rider] ?? 0) + 1 } } : {}) }
      : c
  ))
  // Mana in the pool is just mana: what it may be spent on is yours to
  // keep to, when it was tapped by hand.
  return noted({ ...next, pool, cards }, `Tapped ${inst.card.name} for ${made.map((k) => `{${k}}`).join('')}${
    chosen.only ? ' — to be spent only as the card says' : ''}`)
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
    const ok = isLand(inst.card) ? !landProblem(state, inst.iid) : castWays(state, inst).length > 0
    if (ok) out.add(inst.iid)
  }
  return out
}
