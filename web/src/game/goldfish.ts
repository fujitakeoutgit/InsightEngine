/**
 * A player with no judgement: it plays a land, casts what it can, answers
 * whatever the game asks with a legal answer, and passes. Not for the table —
 * for running whole games through the engine, to find the states it gets
 * stuck in or falls over on. Imported only by tests and scripts.
 */

import type { Card } from '../lib/api'
import type { DeckCard } from '../lib/deckModel'
import { abilitiesOf, activationProblem, usedFrom } from './activate'
import { checkCast, isLand, playable } from './cast'
import { next as roll } from './random'
import { deal, reduce } from './reducer'
import type { Action, GameState } from './types'

type Entry = Card & { decks?: string[] }

const BASICS: [string, string][] = [['Plains', 'W'], ['Island', 'U'], ['Swamp', 'B'], ['Mountain', 'R'], ['Forest', 'G']]

/** A deck out of a corpus: every card in it once, and basic lands of its
 *  colors to make up the hundred. */
export function deckFrom(cards: readonly Entry[], deck: string): DeckCard[] {
  const mine = cards.filter((c) => (c.decks ?? []).includes(deck))
  const colors = new Set(mine.flatMap((c) => [...(c.color_identity ?? '')]))
  const basics = BASICS.filter(([, color]) => colors.has(color))
  const lands = Math.max(0, 100 - mine.length)
  const out: DeckCard[] = mine.map((card, i) => ({ uid: `card${i}`, quantity: 1, card, section: 'main' }))
  basics.forEach(([name], i) => {
    const quantity = Math.floor(lands / basics.length) + (i < lands % basics.length ? 1 : 0)
    if (!quantity) return
    const card = { oracle_id: `basic-${name}`, name, type_line: `Basic Land — ${name}`, mana_cost: null, oracle_text: null } as unknown as Card
    out.push({ uid: `basic${i}`, quantity, card, section: 'main' })
  })
  return out
}

/** The answers worth trying to what is being asked, most natural first. */
function answers(state: GameState, pick: (n: number) => number): Action[] {
  const p = state.pending
  if (!p) return []
  const hand = state.cards.filter((c) => c.zone === 'hand').map((c) => c.iid)
  switch (p.kind) {
    case 'mulligan': return [{ type: 'keep' }]
    case 'bottom':
    case 'discard': return [{ type: 'choose', iids: hand.slice(0, p.count) }]
    case 'confirm': return pick(4) ? [{ type: 'confirm', yes: true }, { type: 'confirm', yes: false }] : [{ type: 'confirm', yes: false }]
    case 'number': return [{ type: 'number', value: p.min }]
    case 'arrange': return [{ type: 'arrange', keep: p.cards, away: [] }]
    case 'attack': return [{ type: 'attack', iids: p.options }]
    case 'type': return [{ type: 'pickType', subtype: p.options[pick(Math.min(3, p.options.length))] }]
    case 'order': return [{ type: 'order', ids: p.ids }]
    case 'way': return [{ type: 'cast', way: p.ways[pick(p.ways.length)].key }, { type: 'cast', way: null }]
    case 'mode': {
      const open = p.modes.map((_, i) => i)
        .filter((i) => (p.repeat ? (p.costs?.[i] ?? 0) <= (p.left ?? 0) : !p.taken.includes(i)))
      return [
        ...(open.length ? [{ type: 'mode' as const, index: open[pick(open.length)] }] : []),
        ...open.map((index) => ({ type: 'mode' as const, index })),
        { type: 'mode', index: -1 },
      ]
    }
    case 'pick': {
      const some = (n: number) => ({ type: 'choose' as const, iids: p.options.slice(0, n) })
      // Convoke: the creatures the tapper would reach for are ones that pay.
      const { casting } = state
      const helping = casting?.way === 'convoke'
        ? checkCast({ ...state, pending: null }, casting.iid, casting.x, 'convoke').payment?.taps
          .map((tap) => tap.id).filter((id) => p.options.includes(id))
        : undefined
      // What it must be at least, then one more, then all — a party or a
      // budget may refuse some of these — and each one alone, and none.
      return [
        ...(helping && pick(2) ? [{ type: 'choose' as const, iids: helping }] : []),
        some(p.min), some(Math.min(p.max, p.min + 1)), some(p.max),
        ...p.options.map((iid) => ({ type: 'choose' as const, iids: [iid] })),
        ...p.options.flatMap((a, i) => p.options.slice(i + 1).map((b) => ({ type: 'choose' as const, iids: [a, b] }))),
        { type: 'choose', iids: [] },
        ...(helping ? [{ type: 'choose' as const, iids: helping }] : []),
        ...(p.cancel ? [{ type: 'cast' as const, way: null }] : []),
      ]
    }
  }
}

/** What to do with priority and nothing to answer: a land, a spell, now and
 *  then an ability — or pass. */
function moves(state: GameState, pick: (n: number) => number): Action[] {
  if (state.stack.length) return [{ type: 'pass' }]
  const can = [...playable(state)]
  const land = can.find((iid) => isLand(state.cards.find((c) => c.iid === iid)!.card))
  const spells = can.filter((iid) => iid !== land).map((iid): Action => {
    // X as large as it can be paid for, up to three.
    const x = [3, 2, 1].find((n) => !checkCast(state, iid, n).why && checkCast(state, iid, n).cost.x > 0) ?? 0
    return { type: 'play', iid, x }
  })
  const abilities = pick(3) === 0
    ? state.cards.flatMap((c) => abilitiesOf(c)
      .map((ability, index) => ({ c, ability, index }))
      .filter(({ ability, index }) => usedFrom(ability) === c.zone && !ability.mana && !activationProblem(state, c.iid, index))
      .map(({ index }): Action => ({ type: 'activate', iid: c.iid, index })))
    : []
  return [
    ...(land ? [{ type: 'play' as const, iid: land }] : []),
    ...spells,
    ...(abilities.length ? [abilities[pick(abilities.length)]] : []),
    { type: 'pass' },
  ]
}

export interface Played {
  state: GameState
  actions: number
  /** Set if the game stopped taking anything it was offered, or was found
   *  in a state no game should be in — and then this is where. */
  stuck: string | null
}

/** Play a deck for some turns, checking the game after every action. Throws
 *  what the engine throws. */
export function goldfish(
  deck: readonly DeckCard[], seed: number, turns: number, watch?: (state: GameState) => void,
): Played {
  let state = deal(deck, seed, true, [], true)
  let chance = seed
  const pick = (n: number) => {
    const [value, after] = roll(chance)
    chance = after
    return Math.min(n - 1, Math.floor(value * n))
  }
  let actions = 0
  for (; actions < 6000 && state.turn <= turns; actions += 1) {
    const offered = state.pending ? answers(state, pick) : moves(state, pick)
    const moved = offered.map((action) => reduce(state, action)).find((after) => after !== state)
    if (!moved) {
      return { state, actions, stuck: `turn ${state.turn}, ${state.step}: ${JSON.stringify(state.pending ?? 'priority').slice(0, 200)}` }
    }
    state = moved
    watch?.(state)
    const wrong = broken(state, deck)
    if (wrong) return { state, actions, stuck: `turn ${state.turn}, ${state.step}: ${wrong}` }
  }
  return { state, actions, stuck: actions >= 6000 ? `still going after ${actions} actions, on turn ${state.turn}` : null }
}

/** What must be true of any game, however it was played. */
function broken(state: GameState, deck: readonly DeckCard[]): string | null {
  const dealt = deck.reduce((n, entry) => n + entry.quantity, 0)
  const real = state.cards.filter((c) => !c.token)
  if (real.length !== dealt) return `${real.length} cards in a ${dealt}-card deck`
  const seen = new Set(state.cards.map((c) => c.iid))
  if (seen.size !== state.cards.length) return 'two cards with one id'
  const stray = state.stack.find((item) => !item.ability && !item.copy && state.cards.find((c) => c.iid === item.iid)?.zone !== 'stack')
  if (stray) return `a spell on the stack whose card is elsewhere: ${stray.iid}`
  const lost = state.cards.find((c) => c.zone === 'stack' && !state.stack.some((item) => item.iid === c.iid) && state.resolving?.source !== c.iid)
  if (lost) return `${lost.card.name} is in the stack zone with nothing to resolve it`
  // Numbers that are not numbers, and words that are not words.
  if (![state.life, state.opponent.life, state.opponent.poison].every(Number.isFinite)) return 'a life total that is not a number'
  const counted = state.cards.find((c) => Object.values(c.counters ?? {}).some((n) => !Number.isInteger(n) || n < 0))
  if (counted) return `${counted.card.name} has a counter count that is not one: ${JSON.stringify(counted.counters)}`
  const said = state.log.find((line) => /\bundefined\b|\bNaN\b|\[object /.test(line))
  if (said) return `the record says: ${said}`
  const posted = state.reminders.find((r) => /\bundefined\b|\bNaN\b|\[object /.test(r.text))
  if (posted) return `a reminder says: ${posted.text}`
  return null
}
