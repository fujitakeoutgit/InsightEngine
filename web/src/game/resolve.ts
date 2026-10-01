/**
 * Carrying out what a card says.
 *
 * The top of the stack resolves: a permanent arrives, a spell or an ability
 * runs its compiled effects one after another. Whenever an effect needs
 * something from you — which creature, which land, top or bottom — the game
 * stops with the question pending and `resolving` remembering where it was;
 * your answer picks it up from there. Nothing is held in a closure, so a game
 * waiting on a choice is still just data: it saves, and it undoes.
 *
 * Targets are chosen as the effect resolves rather than as the spell is cast.
 * With nobody to respond in between, the two are the same thing, and it means
 * a spell can be cast to see what it would cost before deciding what it hits.
 */

import type { Card } from '../lib/api'
import { enterBattlefield, isPermanentSpell, remind, remindUnread, rulesText } from './cast'
import { compile } from './compiler/compile'
import type { Aim, Count, Effect, Filter, TokenSpec } from './compiler/ir'
import { autotap, parseCost } from './mana'
import { matches, onBattlefield } from './match'
import { seatFor } from './seat'
import { isCreature, manaSources } from './sources'
import { draw, find, inZone, mint, noted, relocate, shuffleLibrary } from './state'
import { stats } from './stats'
import type { Action, Decision, GameState, Instance, Resolution } from './types'

/** How many, as the game stands. */
function amount(state: GameState, r: Resolution, count: Count): number {
  if (typeof count === 'number') return count
  if (count === 'X') return r.x
  if ('per' in count) return onBattlefield(state, count.per, r.source).length
  const iid = count.of === 'chosen' ? r.chosen[0] : count.of === 'event' ? r.event : r.source
  if (!iid) return 0
  // The source is asked as it is now; anything else as it was when it was
  // picked or when the trigger saw it, since it may have left since.
  const live = find(state, iid)
  if (count.of === 'self' && live) return stats(live)[count.stat]
  return r.known[iid]?.[count.stat] ?? (live ? stats(live)[count.stat] : 0)
}

/** The permanents an effect acts on. */
function aimed(state: GameState, r: Resolution, aim: Aim): Instance[] {
  const one = (iid: string | null) => {
    const inst = iid ? find(state, iid) : undefined
    return inst ? [inst] : []
  }
  switch (aim.kind) {
    case 'self': return one(r.source)
    case 'event': return one(r.event)
    case 'chosen': return r.chosen.flatMap((iid) => one(iid))
    case 'each': return onBattlefield(state, aim.filter, r.source)
    default: return []
  }
}

const change = (state: GameState, iids: readonly string[], to: (c: Instance) => Instance): GameState => {
  const set = new Set(iids)
  return { ...state, cards: state.cards.map((c) => (set.has(c.iid) ? to(c) : c)) }
}

const names = (cards: readonly Instance[]) => cards.map((c) => c.card.name).join(', ')

/** "Wall of Omens'", "Aesi's". */
const possessive = (name: string) => `${name}${name.endsWith('s') ? "'" : "'s"}`

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/** Put `top` on top of the library, in that order, and `bottom` beneath it. */
function arrange(cards: readonly Instance[], top: readonly string[], bottom: readonly string[]): Instance[] {
  const moving = new Set([...top, ...bottom])
  const byId = new Map(cards.map((c) => [c.iid, c]))
  const rest = cards.filter((c) => !moving.has(c.iid))
  const first = rest.findIndex((c) => c.zone === 'library')
  const upper = top.map((iid) => byId.get(iid)!)
  const placed = first < 0 ? [...rest, ...upper] : [...rest.slice(0, first), ...upper, ...rest.slice(first)]
  return [...placed, ...bottom.map((iid) => byId.get(iid)!)]
}

/** A token, made and seated where its type belongs. */
function makeToken(state: GameState, spec: TokenSpec, tapped: boolean): GameState {
  const slug = spec.name.toLowerCase().replace(/\W+/g, '-')
  const [iid, minted] = mint(state, `token-${slug}-`)
  const art = state.tokenArt[spec.name.toLowerCase()] ?? null
  const [power, toughness] = spec.pt ? spec.pt.split('/') : [null, null]
  const card = {
    oracle_id: `token-${slug}`,
    name: spec.name,
    type_line: spec.typeLine,
    power,
    toughness,
    colors: spec.colors,
    color_identity: spec.colors,
    keywords: spec.keywords,
    image_small: art,
    image_normal: art,
    mana_cost: null,
    oracle_text: null,
    cmc: 0,
  } as unknown as Card
  const made: Instance = { iid, card, zone: 'battlefield', tapped, x: 0.5, y: 0.5, token: true }
  const seat = seatFor(minted.cards, made)
  return { ...minted, cards: [...minted.cards, { ...made, ...seat, sick: isCreature(made) }] }
}

/** How lifegain is multiplied: once for each Rhox Faithmender. */
function lifeGainFactor(state: GameState) {
  let factor = 1
  for (const inst of inZone(state, 'battlefield')) {
    for (const fixed of compile(inst.card).statics) if (fixed.kind === 'doubleLifeGain') factor *= 2
  }
  return factor
}

/** A filter back in words, for a question: "up to 2 basic land cards",
 *  "a creature". `noun` is what to call one when the filter names no type —
 *  a card in the library, a permanent on the battlefield. */
function asked(filter: Filter, count: number, upTo: boolean, noun: 'card' | 'permanent'): string {
  const kind = [
    filter.other ? 'other' : '',
    filter.basic ? 'basic' : '',
    filter.nontoken ? 'nontoken' : '',
    ...(filter.not ?? []).map((t) => `non${t}`),
    (filter.subtypes ?? []).join(' or '),
    (filter.types ?? []).join(' or '),
  ].filter(Boolean).join(' ')
  const one = [kind, noun === 'card' || !kind ? noun : ''].filter(Boolean).join(' ')
  const many = count === 1 ? one : `${one}s`
  const article = /^[aeiou]/.test(one) ? 'an' : 'a'
  return `${upTo ? 'up to ' : ''}${count === 1 ? (upTo ? 'one' : article) : count} ${many}`
}

type Outcome = { state: GameState; wait?: Decision }

/** Carry out one effect, or stop on the question it has to ask first. */
function perform(state: GameState, r: Resolution, effect: Effect): Outcome {
  const n = effect.op === 'draw' || effect.op === 'life' || effect.op === 'damage'
    || effect.op === 'scry' || effect.op === 'surveil' || effect.op === 'mill'
    || effect.op === 'token' || effect.op === 'counters'
    ? amount(state, r, effect.count) : 0

  switch (effect.op) {
    case 'choose': {
      const options = onBattlefield(state, effect.filter, r.source).map((c) => c.iid)
      const set = (chosen: string[]): GameState => ({
        ...state,
        resolving: {
          ...r,
          chosen,
          known: { ...r.known, ...Object.fromEntries(chosen.map((iid) => [iid, stats(find(state, iid)!)])) },
        },
      })
      if (!options.length) return { state: noted(set([]), `${r.name}: nothing to choose`) }
      // A choice with no choice in it is not asked.
      if (effect.must && options.length <= effect.count) return { state: set(options) }
      return {
        state,
        wait: {
          kind: 'pick',
          zone: 'battlefield',
          prompt: `${r.name}: choose ${asked(effect.filter, effect.count, effect.upTo, 'permanent')}`,
          options,
          min: effect.must ? Math.min(effect.count, options.length) : 0,
          max: Math.min(effect.count, options.length),
        },
      }
    }

    case 'draw':
      return { state: n > 0 ? draw(state, n) : state }

    case 'life': {
      if (n <= 0) return { state }
      if (effect.who === 'opponent') {
        const life = state.opponent.life + effect.sign * n
        return { state: noted({ ...state, opponent: { ...state.opponent, life } }, `The opponent ${effect.sign > 0 ? 'gains' : 'loses'} ${n} life`) }
      }
      const gained = effect.sign > 0 ? n * lifeGainFactor(state) : -n
      return { state: noted({ ...state, life: state.life + gained }, `You ${gained > 0 ? 'gain' : 'lose'} ${Math.abs(gained)} life`) }
    }

    case 'damage': {
      if (n <= 0) return { state }
      if (effect.to.kind === 'opponent') {
        return { state: noted({ ...state, opponent: { ...state.opponent, life: state.opponent.life - n } }, `${r.name} deals ${n} damage to the opponent`) }
      }
      if (effect.to.kind === 'you') {
        return { state: noted({ ...state, life: state.life - n }, `${r.name} deals ${n} damage to you`) }
      }
      const hit = aimed(state, r, effect.to)
      if (!hit.length) return { state }
      const marked = change(state, hit.map((c) => c.iid), (c) => ({ ...c, damage: (c.damage ?? 0) + n }))
      return { state: noted(marked, `${r.name} deals ${n} damage to ${names(hit)}`) }
    }

    case 'scry':
    case 'surveil': {
      const cards = inZone(state, 'library').slice(0, n).map((c) => c.iid)
      return cards.length ? { state, wait: { kind: 'arrange', mode: effect.op, cards } } : { state }
    }

    case 'mill': {
      const top = inZone(state, 'library').slice(0, n)
      if (!top.length) return { state }
      let cards = state.cards
      for (const c of top) cards = relocate(cards, c.iid, 'graveyard')
      return { state: noted({ ...state, cards }, `Milled ${names(top)}`) }
    }

    case 'token': {
      let next = state
      for (let i = 0; i < n; i += 1) next = makeToken(next, effect.token, effect.tapped)
      return { state: n > 0 ? noted(next, `Created ${n > 1 ? `${n} ${effect.token.name} tokens` : `a ${effect.token.name} token`}`) : state }
    }

    case 'counters': {
      const on = aimed(state, r, effect.to)
      if (!on.length || n <= 0) return { state }
      const added = change(state, on.map((c) => c.iid), (c) => ({
        ...c, counters: { ...c.counters, [effect.counter]: (c.counters?.[effect.counter] ?? 0) + n },
      }))
      return { state: noted(added, `${plural(n, `${effect.counter} counter`)} on ${names(on)}`) }
    }

    case 'search': {
      const options = inZone(state, 'library').filter((c) => matches(c, effect.filter, r.source)).map((c) => c.iid)
      if (!options.length) {
        return { state: noted(shuffleLibrary(state), `${r.name}: found nothing, then shuffled`) }
      }
      return {
        state,
        wait: {
          kind: 'pick',
          zone: 'library',
          prompt: `${r.name}: search for ${asked(effect.filter, effect.count, effect.upTo, 'card')}${
            effect.restToHand ? ' — the first goes onto the battlefield, the other into your hand' : ''}`,
          options,
          // A search of a hidden zone may always come up empty (CR 701.19b).
          min: 0,
          max: Math.min(effect.count, options.length),
        },
      }
    }

    case 'topCard': {
      const top = inZone(state, 'library')[0]
      if (!top) return { state }
      const land = /\bLand\b/.test(top.card.type_line ?? '')
      if (land && effect.land === 'battlefield' && effect.ask) {
        return { state, wait: { kind: 'confirm', prompt: `${r.name}: put ${top.card.name} onto the battlefield?` } }
      }
      return { state: revealTop(state, r, effect, true) }
    }

    case 'fromHand': {
      const options = inZone(state, 'hand').filter((c) => matches(c, effect.filter, r.source)).map((c) => c.iid)
      if (!options.length) return { state: noted(state, `${r.name}: nothing in hand to put onto the battlefield`) }
      return {
        state,
        wait: {
          kind: 'pick',
          zone: 'hand',
          prompt: `${r.name}: put ${asked(effect.filter, effect.count, effect.upTo, 'card')} from your hand onto the battlefield`,
          options,
          min: 0,
          max: Math.min(effect.count, options.length),
        },
      }
    }

    case 'move': {
      const what = aimed(state, r, effect.what)
      if (!what.length) return { state }
      let cards = state.cards
      for (const c of what) cards = relocate(cards, c.iid, effect.to)
      const verb = effect.to === 'graveyard' ? 'to the graveyard' : effect.to === 'exile' ? 'exiled' : 'returned to hand'
      return { state: noted({ ...state, cards }, `${names(what)} ${verb}`) }
    }

    case 'reanimate': {
      const options = inZone(state, 'graveyard').filter((c) => matches(c, effect.filter, r.source)).map((c) => c.iid)
      if (!options.length) return { state: noted(state, `${r.name}: nothing in your graveyard to return`) }
      return {
        state,
        wait: {
          kind: 'pick',
          zone: 'graveyard',
          prompt: `${r.name}: return ${asked(effect.filter, effect.count, effect.upTo, 'card')} from your graveyard`,
          options,
          min: 0,
          max: Math.min(effect.count, options.length),
        },
      }
    }

    case 'untap':
    case 'tap': {
      const what = aimed(state, r, effect.what)
      return { state: change(state, what.map((c) => c.iid), (c) => ({ ...c, tapped: effect.op === 'tap' })) }
    }

    case 'extraLand':
      return { state: noted({ ...state, extraLands: state.extraLands + effect.count }, `You may play ${effect.count === 1 ? 'an additional land' : `${effect.count} additional lands`} this turn`) }

    case 'addMana': {
      const pool = { ...state.pool }
      for (const unit of effect.makes) pool[unit[0]] += 1
      return { state: { ...state, pool } }
    }

    case 'pay': {
      const paid = autotap(parseCost(effect.cost), manaSources(state), { pool: state.pool, life: state.life })
      if (!paid) {
        // Cannot pay: the same as saying no.
        return { state: noted({ ...state, resolving: { ...r, declined: true } }, `${r.name}: cannot pay ${effect.cost}`) }
      }
      const tapping = new Set(paid.taps.map((t) => t.id))
      return {
        state: noted({
          ...change(state, [...tapping], (c) => ({ ...c, tapped: true })),
          pool: paid.pool,
          life: state.life - paid.life,
        }, `${r.name}: paid ${effect.cost}`),
      }
    }

    case 'mode':
      return {
        state,
        wait: { kind: 'mode', prompt: `${r.name}: choose one`, modes: effect.modes.map((m) => m.text) },
      }

    case 'nothing':
      return { state: noted(state, `${r.name}: ${effect.why.charAt(0).toLowerCase()}${effect.why.slice(1)}`) }
  }
}

/** Coiling Oracle and its kind: the top card shown, and sent on its way. */
function revealTop(
  state: GameState, r: Resolution, effect: Extract<Effect, { op: 'topCard' }>, takeLand: boolean,
): GameState {
  const top = inZone(state, 'library')[0]
  if (!top) return state
  const land = /\bLand\b/.test(top.card.type_line ?? '')
  const to = land ? (takeLand ? effect.land : 'stay') : effect.other
  if (to === 'battlefield') {
    return noted(enterBattlefield(state, top.iid).state, `${r.name} revealed ${top.card.name} — onto the battlefield`)
  }
  if (to === 'hand') {
    return noted({ ...state, cards: relocate(state.cards, top.iid, 'hand'), drawn: [top.iid] }, `${r.name} revealed ${top.card.name} — into your hand`)
  }
  return noted(state, `${r.name} looked at ${top.card.name}`)
}

/** On to the next effect. */
const advance = (state: GameState): GameState => {
  const r = state.resolving!
  return { ...state, resolving: { ...r, at: r.at + 1, agreed: false } }
}

/** All of it is done: the spell goes to the graveyard, and whatever was not
 *  understood is posted for you to finish. */
function finish(state: GameState): GameState {
  const r = state.resolving!
  let next: GameState = { ...state, resolving: null }
  if (r.spell && find(next, r.source)?.zone === 'stack') {
    next = { ...next, cards: relocate(next.cards, r.source, 'graveyard') }
  }
  return r.leftover ? remind(next, r.source, r.name, r.leftover) : next
}

/** Run until the ability is finished or has a question. */
export function carryOn(state: GameState): GameState {
  let next = state
  for (let guard = 0; guard < 500; guard += 1) {
    const r = next.resolving
    if (!r) return next
    if (r.at >= r.effects.length) return finish(next)
    const effect = r.effects[r.at]
    if (effect.ifDone && r.declined) {
      next = advance(next)
      continue
    }
    if (!effect.ifDone && r.declined) {
      next = { ...next, resolving: { ...r, declined: false } }
      continue
    }
    if (effect.optional && !r.agreed) {
      return { ...next, pending: { kind: 'confirm', prompt: `${r.name} — you may:\n${r.text}` } }
    }
    const out = perform(next, r, effect)
    if (out.wait) return { ...out.state, pending: out.wait }
    next = advance(out.state)
  }
  return next
}

/** Your answer to what a resolving ability asked. */
export function answer(state: GameState, action: Action): GameState {
  const { resolving: r, pending } = state
  if (!r || !pending) return state
  const effect = r.effects[r.at]
  const settled: GameState = { ...state, pending: null }

  if (pending.kind === 'confirm' && action.type === 'confirm') {
    // Into the Wilds asks about the card, not about the ability.
    if (effect.op === 'topCard' && (!effect.optional || r.agreed)) {
      return carryOn(advance(revealTop(settled, r, effect, action.yes)))
    }
    if (action.yes) return carryOn({ ...settled, resolving: { ...r, agreed: true } })
    return carryOn(advance({ ...settled, resolving: { ...r, declined: true } }))
  }

  if (pending.kind === 'pick' && action.type === 'choose') {
    const picked = [...new Set(action.iids)]
    if (picked.length < pending.min || picked.length > pending.max) return state
    if (!picked.every((iid) => pending.options.includes(iid))) return state
    return carryOn(advance(applyPick(settled, r, effect, picked)))
  }

  if (pending.kind === 'arrange' && action.type === 'arrange') {
    const all = new Set([...action.keep, ...action.away])
    if (all.size !== pending.cards.length || !pending.cards.every((iid) => all.has(iid))) return state
    const said = `${pending.mode === 'scry' ? 'Scried' : 'Surveilled'} ${pending.cards.length}: ${action.keep.length} on top`
    if (pending.mode === 'scry') {
      return carryOn(advance(noted({ ...settled, cards: arrange(settled.cards, action.keep, action.away) }, said)))
    }
    let cards = arrange(settled.cards, action.keep, [])
    for (const iid of action.away) cards = relocate(cards, iid, 'graveyard')
    return carryOn(advance(noted({ ...settled, cards }, said)))
  }

  if (pending.kind === 'mode' && action.type === 'mode' && effect.op === 'mode') {
    const mode = effect.modes[action.index]
    if (!mode) return state
    // The chosen mode's effects take the place of the choice.
    const effects = [...r.effects.slice(0, r.at + 1), ...mode.effects, ...r.effects.slice(r.at + 1)]
    const leftover = mode.complete ? r.leftover : [r.leftover, mode.text].filter(Boolean).join('\n')
    return carryOn(advance(noted({ ...settled, resolving: { ...r, effects, leftover } }, `${r.name}: ${mode.text}`)))
  }
  return state
}

/** What was picked, put where the effect says. */
function applyPick(state: GameState, r: Resolution, effect: Effect, picked: string[]): GameState {
  const cards = picked.map((iid) => find(state, iid)!)
  switch (effect.op) {
    case 'choose':
      return {
        ...state,
        resolving: {
          ...r,
          chosen: picked,
          known: { ...r.known, ...Object.fromEntries(cards.map((c) => [c.iid, stats(c)])) },
        },
      }

    case 'search': {
      let next = state
      picked.forEach((iid, i) => {
        const toHand = effect.to === 'hand' || (effect.restToHand && i > 0)
        if (toHand) next = { ...next, cards: relocate(next.cards, iid, 'hand') }
        else if (effect.to === 'battlefield') next = enterBattlefield(next, iid, { forceTapped: effect.tapped }).state
      })
      next = shuffleLibrary(next)
      // On top means on top of the shuffled library.
      if (effect.to === 'top') next = { ...next, cards: arrange(next.cards, picked, []) }
      const where = effect.to === 'hand' ? 'into your hand' : effect.to === 'top' ? 'on top' : `onto the battlefield${effect.tapped ? ' tapped' : ''}`
      return noted(next, picked.length
        ? `${r.name}: found ${names(cards)} — ${where}${effect.restToHand && picked.length > 1 ? ', the other into your hand' : ''}, then shuffled`
        : `${r.name}: took nothing, then shuffled`)
    }

    case 'fromHand': {
      let next = state
      for (const iid of picked) next = enterBattlefield(next, iid, { forceTapped: effect.tapped }).state
      return picked.length ? noted(next, `${r.name}: put ${names(cards)} onto the battlefield${effect.tapped ? ' tapped' : ''}`) : next
    }

    case 'reanimate': {
      let next = state
      for (const iid of picked) {
        next = effect.to === 'battlefield'
          ? enterBattlefield(next, iid).state
          : { ...next, cards: relocate(next.cards, iid, 'hand') }
      }
      return picked.length ? noted(next, `${r.name}: returned ${names(cards)} ${effect.to === 'hand' ? 'to your hand' : 'to the battlefield'}`) : next
    }

    default:
      return state
  }
}

/**
 * The top of the stack resolves.
 *
 * A permanent spell becomes a permanent, and whatever it does on arrival
 * triggers from there. An instant, a sorcery or an ability runs what the
 * compiler made of it; what the compiler could not read is posted beside the
 * board for you to carry out, as all of it was before there was a compiler.
 */
export function resolveTop(state: GameState): GameState {
  const top = state.stack[state.stack.length - 1]
  if (!top) return state
  const stack = state.stack.slice(0, -1)
  const inst = find(state, top.iid)
  const blank = { at: 0, x: top.x, chosen: [], agreed: false, declined: false }

  if (top.ability) {
    const name = inst?.card.name ?? 'An ability'
    return carryOn({
      ...noted({ ...state, stack }, `${possessive(name)} ability resolves`),
      resolving: {
        ...blank,
        source: top.iid,
        name,
        text: top.ability.text,
        effects: top.ability.effects,
        event: top.ability.event,
        known: top.ability.known,
        spell: false,
        leftover: top.ability.complete ? null : top.ability.text,
      },
    })
  }
  if (!inst) return { ...state, stack }

  if (isPermanentSpell(inst.card)) {
    const entered = enterBattlefield({ ...state, stack }, inst.iid, { x: top.x }).state
    return remindUnread(noted(entered, `${inst.card.name} resolves`), inst)
  }

  const spell = compile(inst.card).spell
  const begun = noted({ ...state, stack }, `${inst.card.name} resolves`)
  if (!spell?.effects.length) {
    return remind({ ...begun, cards: relocate(begun.cards, inst.iid, 'graveyard') }, inst.iid, inst.card.name, rulesText(inst.card))
  }
  return carryOn({
    ...begun,
    resolving: {
      ...blank,
      source: inst.iid,
      name: inst.card.name,
      text: spell.text.split('~').join(inst.card.name),
      effects: spell.effects,
      event: null,
      known: {},
      spell: true,
      leftover: spell.complete ? null : rulesText(inst.card),
    },
  })
}

