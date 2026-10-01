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
import { amount, signed } from './amount'
import { enterBattlefield, isPermanentSpell, remind, remindUnread, rulesText } from './cast'
import { lifeGainFactor } from './combat'
import { compile } from './compiler/compile'
import type { Aim, Effect, Filter, TokenSpec } from './compiler/ir'
import { holds } from './holds'
import { autotap, parseCost } from './mana'
import { matches, onBattlefield } from './match'
import { seatFor } from './seat'
import { isCreature, manaSources } from './sources'
import { draw, find, inZone, mint, noted, relocate, shuffleLibrary } from './state'
import { snapshot } from './stats'
import type { Action, Decision, GameState, Instance, Resolution } from './types'

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

/** Note how many things an effect acted on, for the one after it to ask:
 *  "the number of creatures destroyed this way". */
const acted = (state: GameState, n: number): GameState =>
  (state.resolving ? { ...state, resolving: { ...state.resolving, last: n } } : state)

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

/** Words as a sentence: a capital to start, a full stop to end. */
const sentenceCase = (text: string) =>
  `${text.charAt(0).toUpperCase()}${text.slice(1)}${/[.!?"]$/.test(text) ? '' : '.'}`

/** A token, made and seated where its type belongs. `size` is what an X/X
 *  one comes to. */
function makeToken(state: GameState, spec: TokenSpec, tapped: boolean, size?: number): GameState {
  const slug = spec.name.toLowerCase().replace(/\W+/g, '-')
  const [iid, minted] = mint(state, `token-${slug}-`)
  const art = state.tokenArt[spec.name.toLowerCase()] ?? null
  const [power, toughness] = size !== undefined ? [String(size), String(size)]
    : spec.pt ? spec.pt.split('/') : [null, null]
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
    // "This token" — "~", once normalized — is the card's own name to the
    // compiler, and to whoever reads the token.
    oracle_text: spec.text ? sentenceCase(spec.text.replace(/this token|~/gi, spec.name)) : null,
    cmc: 0,
  } as unknown as Card
  const made: Instance = { iid, card, zone: 'battlefield', tapped, x: 0.5, y: 0.5, token: true }
  const seat = seatFor(minted.cards, made)
  return { ...minted, cards: [...minted.cards, { ...made, ...seat, sick: isCreature(made) }] }
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
    || effect.op === 'token' || effect.op === 'counters' || effect.op === 'search'
    ? amount(state, r, effect.count) : 0

  switch (effect.op) {
    case 'choose': {
      const options = onBattlefield(state, effect.filter, r.source).map((c) => c.iid)
      const set = (chosen: string[]): GameState => ({
        ...state,
        resolving: {
          ...r,
          chosen,
          known: { ...r.known, ...Object.fromEntries(chosen.map((iid) => [iid, snapshot(find(state, iid)!, state)])) },
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
      const size = effect.size === undefined ? undefined : amount(state, r, effect.size)
      let next = state
      for (let i = 0; i < n; i += 1) next = makeToken(next, effect.token, effect.tapped, size)
      const what = `${size === undefined ? '' : `${size}/${size} `}${effect.token.name}`
      return { state: n > 0 ? noted(next, `Created ${n > 1 ? `${n} ${what} tokens` : `a ${what} token`}`) : state }
    }

    case 'counters': {
      const on = aimed(state, r, effect.to).filter((c) => c.zone === 'battlefield')
      const { count } = effect
      if (typeof count === 'object' && 'of' in count && count.of === 'each') {
        // Each gets its own amount: "equal to that creature's toughness".
        const each = new Map(on.map((c) => (
          [c.iid, amount(state, { ...r, event: c.iid, known: {} }, { ...count, of: 'event' } as typeof count)]
        )))
        const added = change(state, on.map((c) => c.iid), (c) => ({
          ...c, counters: { ...c.counters, [effect.counter]: (c.counters?.[effect.counter] ?? 0) + Math.max(0, each.get(c.iid) ?? 0) },
        }))
        return { state: on.length ? noted(added, `${effect.counter} counters on ${names(on)}`) : state }
      }
      if (!on.length || n <= 0) return { state }
      const added = change(state, on.map((c) => c.iid), (c) => ({
        ...c, counters: { ...c.counters, [effect.counter]: (c.counters?.[effect.counter] ?? 0) + n },
      }))
      return { state: noted(added, `${plural(n, `${effect.counter} counter`)} on ${names(on)}`) }
    }

    case 'proliferate': {
      const on = inZone(state, 'battlefield').filter((c) => (
        Object.values(c.counters ?? {}).some((count) => count > 0)
        || (/\bPlaneswalker\b/.test(c.card.type_line ?? '') && (c.loyalty ?? 0) > 0)
      ))
      const poisoned = state.opponent.poison > 0
      if (!on.length && !poisoned) return { state: noted(state, `${r.name}: nothing to proliferate`) }
      const more = change(state, on.map((c) => c.iid), (c) => ({
        ...c,
        ...(c.counters ? { counters: Object.fromEntries(Object.entries(c.counters).map(([kind, count]) => [kind, count > 0 ? count + 1 : count])) } : {}),
        ...(/\bPlaneswalker\b/.test(c.card.type_line ?? '') && (c.loyalty ?? 0) > 0 ? { loyalty: (c.loyalty ?? 0) + 1 } : {}),
      }))
      const opponent = poisoned ? { ...state.opponent, poison: state.opponent.poison + 1 } : state.opponent
      return { state: noted({ ...more, opponent }, `${r.name}: proliferated${on.length ? ` — ${names(on)}` : ''}${poisoned ? ', and the opponent\'s poison' : ''}`) }
    }

    case 'search': {
      const options = inZone(state, 'library').filter((c) => matches(c, effect.filter, r.source)).map((c) => c.iid)
      if (!options.length || n <= 0) {
        return { state: noted(shuffleLibrary(state), `${r.name}: found nothing, then shuffled`) }
      }
      return {
        state,
        wait: {
          kind: 'pick',
          zone: 'library',
          prompt: `${r.name}: search for ${asked(effect.filter, n, effect.upTo, 'card')}${
            effect.restToHand ? ' — the first goes onto the battlefield, the other into your hand' : ''}`,
          options,
          // A search of a hidden zone may always come up empty (CR 701.19b).
          min: 0,
          max: Math.min(n, options.length),
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
      return { state: acted(noted({ ...state, cards }, `${names(what)} ${verb}`), what.length) }
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

    case 'boost': {
      const on = (effect.to.kind === 'you' || effect.to.kind === 'opponent' ? [] : aimed(state, r, effect.to))
        .filter((c) => c.zone === 'battlefield')
      if (!on.length) return { state }
      const [power, toughness] = [signed(state, r, effect.power), signed(state, r, effect.toughness)]
      const boosts = [...state.boosts, { iids: on.map((c) => c.iid), power, toughness, keywords: effect.keywords }]
      const what = [
        power || toughness ? `${power >= 0 ? '+' : ''}${power}/${toughness >= 0 ? '+' : ''}${toughness}` : '',
        effect.keywords.join(', ').toLowerCase(),
      ].filter(Boolean).join(' and ')
      return { state: noted({ ...state, boosts }, `${names(on)}: ${what} until end of turn`) }
    }

    case 'attach': {
      const host = r.chosen[0] ? find(state, r.chosen[0]) : undefined
      const source = find(state, r.source)
      if (!host || !source || host.zone !== 'battlefield' || source.zone !== 'battlefield') return { state }
      // Tucked behind what it is on, a little up and to the right.
      const cards = state.cards.map((c) => (
        c.iid === r.source ? { ...c, attachedTo: host.iid, x: Math.min(0.97, host.x + 0.022), y: Math.max(0, host.y - 0.035) } : c
      ))
      return { state: noted({ ...state, cards }, `${source.card.name} attached to ${host.card.name}`) }
    }

    case 'discard': {
      const hand = inZone(state, 'hand').map((c) => c.iid)
      const owed = Math.min(amount(state, r, effect.count), hand.length)
      if (owed <= 0) return { state }
      return {
        state,
        wait: {
          kind: 'pick', zone: 'hand', prompt: `${r.name}: discard ${plural(owed, 'card')}`,
          options: hand, min: owed, max: owed,
        },
      }
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

    case 'mode': {
      const many = effect.max > 1
      const said = !many ? (effect.min ? 'choose one' : 'choose up to one')
        : effect.min === effect.max ? `choose ${effect.max}`
          : effect.min ? 'choose one or more' : `choose up to ${effect.max}`
      return {
        state,
        wait: {
          kind: 'mode',
          prompt: `${r.name}: ${said}`,
          modes: effect.modes.map((m) => m.text.split('~').join(r.name)),
          taken: r.modes,
          canStop: r.modes.length >= effect.min,
        },
      }
    }

    case 'if': {
      // The branch that holds takes the place of the question.
      const branch = holds(state, r, effect.test) ? effect.then : effect.otherwise
      const effects = [...r.effects.slice(0, r.at + 1), ...branch, ...r.effects.slice(r.at + 1)]
      return { state: { ...state, resolving: { ...r, effects } } }
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
    const stop = action.index === -1
    if (stop ? r.modes.length < effect.min : !effect.modes[action.index] || r.modes.includes(action.index)) return state
    const taken = stop ? r.modes : [...r.modes, action.index]
    // More may be chosen: ask again, with this one taken.
    if (!stop && taken.length < effect.max && taken.length < effect.modes.length) {
      return carryOn({ ...settled, resolving: { ...r, modes: taken } })
    }
    // The chosen modes' effects take the place of the choice, in the order
    // they are printed.
    const chosen = [...taken].sort((a, b) => a - b).map((index) => effect.modes[index])
      .map((mode) => ({ ...mode, text: mode.text.split('~').join(r.name) }))
    const effects = [...r.effects.slice(0, r.at + 1), ...chosen.flatMap((m) => m.effects), ...r.effects.slice(r.at + 1)]
    const leftover = [r.leftover, ...chosen.filter((m) => !m.complete).map((m) => m.text)].filter(Boolean).join('\n') || null
    let said: GameState = { ...settled, resolving: { ...r, effects, leftover, modes: [] } }
    for (const mode of chosen) said = noted(said, `${r.name}: ${mode.text}`)
    return carryOn(advance(said))
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
          known: { ...r.known, ...Object.fromEntries(cards.map((c) => [c.iid, snapshot(c, state)])) },
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

    case 'discard': {
      let hand = state.cards
      for (const iid of picked) hand = relocate(hand, iid, 'graveyard')
      return acted(noted({ ...state, cards: hand }, `${r.name}: discarded ${names(cards)}`), picked.length)
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
  const blank = { at: 0, x: top.x, chosen: [], agreed: false, declined: false, last: 0, modes: [] }

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
    const arrived = remindUnread(noted(entered, `${inst.card.name} resolves`), inst)
    // An Aura goes onto something as it arrives.
    const enchant = /\bAura\b/.test(inst.card.type_line ?? '') ? compile(inst.card).enchant : null
    if (!enchant) return arrived
    return carryOn({
      ...arrived,
      resolving: {
        ...blank,
        source: inst.iid,
        name: inst.card.name,
        text: rulesText(inst.card),
        effects: [{ op: 'choose', filter: enchant, count: 1, upTo: false, must: true }, { op: 'attach' }],
        event: null,
        known: {},
        spell: false,
        leftover: null,
      },
    })
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

