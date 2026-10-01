/**
 * Triggered abilities.
 *
 * What happened is read off the difference between the game before an action
 * and after it: a card that was not on the battlefield and now is has
 * entered, a creature that was and is now in the graveyard has died, a card
 * that was in your hand and is now in your graveyard was discarded. That
 * covers moves you make by hand as well as ones the engine makes — drag a
 * creature to the graveyard and it has died, with everything that watches for
 * that — and it needs no bookkeeping in the code that moves cards. The few
 * things a difference cannot show — a creature connived, you scried — are
 * noted as they happen, in `events`, and read from there.
 *
 * Each ability that saw the event goes on the stack, to resolve when you pass.
 * The same pass keeps the turn's tally: how many creatures have died, how
 * much life was gained.
 */

import { remind } from './cast'
import { combatDamage } from './combat'
import { compile } from './compiler/compile'
import type { TriggeredAbility, TriggerEvent } from './compiler/ir'
import { holds } from './holds'
import { matches } from './match'
import { isCreature } from './sources'
import { inZone, mint, noted } from './state'
import { snapshot } from './stats'
import type { GameState, Instance, Known, Tally } from './types'

type About = 'enters' | 'dies' | 'cast' | 'attacks' | 'combatDamage' | 'discard' | 'tapped' | 'untapped' | 'connives'

type Happened =
  | { on: About; card: Instance }
  /** Damage marked on a creature: how much more than it had. */
  | { on: 'damaged'; card: Instance; amount: number }
  /** A Class has become this level. */
  | { on: 'level'; card: Instance; level: number }
  | { on: 'lifeGain' | 'landPlay' | 'attack' | 'scry' }
  /** One card drawn: the `nth` this turn. */
  | { on: 'draw'; nth: number }

function happened(before: GameState, after: GameState): { events: Happened[]; tally: Tally } {
  const out: Happened[] = []
  const tally = { ...after.tally }
  const was = new Map(before.cards.map((c) => [c.iid, c]))
  const is = new Map(after.cards.map((c) => [c.iid, c]))

  for (const now of after.cards) {
    const prev = was.get(now.iid)
    if (now.zone === 'battlefield' && prev?.zone !== 'battlefield') out.push({ on: 'enters', card: now })
    // Dying is going to the graveyard from the battlefield, and only
    // creatures do it. The card is taken as it was, counters and all.
    if (prev?.zone === 'battlefield' && now.zone === 'graveyard' && isCreature(prev)) {
      out.push({ on: 'dies', card: prev })
      tally.died += 1
    }
    if (prev && prev.zone !== 'graveyard' && now.zone === 'graveyard' && isCreature(now) && !now.token) tally.binned += 1
    // From your hand to your graveyard, and not by way of the stack.
    if (prev?.zone === 'hand' && now.zone === 'graveyard') {
      out.push({ on: 'discard', card: now })
      tally.discarded += 1
    }
    if (prev?.zone === 'battlefield' && now.zone === 'battlefield' && prev.tapped !== now.tapped) {
      out.push({ on: now.tapped ? 'tapped' : 'untapped', card: now })
    }
    const hurt = now.zone === 'battlefield' ? (now.damage ?? 0) - (prev?.zone === 'battlefield' ? prev.damage ?? 0 : 0) : 0
    if (hurt > 0) out.push({ on: 'damaged', card: now, amount: hurt })
  }
  // Leaving is counted from what was there, since a token that has left is
  // soon nowhere at all.
  for (const prev of before.cards) {
    if (prev.zone === 'battlefield' && is.get(prev.iid)?.zone !== 'battlefield') tally.left += 1
  }

  const stacked = new Set(before.stack.map((item) => item.id))
  for (const item of after.stack) {
    if (item.ability || stacked.has(item.id)) continue
    const card = is.get(item.iid)
    if (card) out.push({ on: 'cast', card })
  }
  // Attackers are declared together, and each is an attack of its own.
  if (after.attacking.length && !before.attacking.length) {
    out.push({ on: 'attack' })
    for (const iid of after.attacking) {
      const card = is.get(iid)
      if (card) out.push({ on: 'attacks', card })
    }
  }
  if (after.dealt !== before.dealt) {
    for (const iid of after.dealt) {
      const card = is.get(iid)
      if (card) out.push({ on: 'combatDamage', card })
    }
  }
  if (after.life > before.life) {
    out.push({ on: 'lifeGain' })
    tally.gained += after.life - before.life
  }
  if (after.life < before.life) tally.lost += before.life - after.life
  if (after.landsPlayed > before.landsPlayed) out.push({ on: 'landPlay' })
  // Draws are counted where they happen; a new turn starts the count again,
  // which is not a draw.
  for (let nth = before.tally.drawn + 1; nth <= after.tally.drawn; nth += 1) out.push({ on: 'draw', nth })

  for (const event of after.events) {
    if (event.on === 'scry') {
      out.push({ on: 'scry' })
      continue
    }
    const card = is.get(event.iid)
    if (!card) continue
    out.push(event.on === 'level' ? { on: 'level', card, level: event.level } : { on: 'connives', card })
  }
  return { events: out, tally }
}

function sees(when: TriggerEvent, event: Happened, source: Instance, state: GameState): boolean {
  if (when.on !== event.on) return false
  if (when.on === 'draw') return !when.nth || when.nth === (event as Extract<Happened, { on: 'draw' }>).nth
  if (when.on === 'level') {
    const became = event as Extract<Happened, { on: 'level' }>
    return became.card.iid === source.iid && became.level === when.level
  }
  if (!('card' in event)) return true
  const { card } = event
  if (when.on === 'cast') return matches(card, when.filter, source.iid, state)
  if (when.on === 'discard') return !when.filter || matches(card, when.filter, source.iid, state)
  if ('who' in when) {
    if (when.who === 'self') return card.iid === source.iid
    // "Equipped creature": what this is on.
    if (when.who === 'attached') return source.attachedTo === card.iid
    // A creature that has died is asked as the card it was: off the
    // battlefield it has no board to be sized by.
    return matches(card, when.who, source.iid, when.on === 'dies' ? undefined : state)
  }
  return true
}

/** Put one ability on the stack — or, if nothing of it was understood, post
 *  its words straight away: there is nothing for the stack to resolve. */
function fire(
  state: GameState, source: Instance, index: number, ability: TriggeredAbility,
  about: Instance | null, known: Known | null, amount?: number,
): GameState {
  if (ability.condition) {
    const asking = {
      x: 0, source: source.iid, chosen: [], event: about?.iid ?? null, last: 0,
      known: about && known ? { [about.iid]: known } : {},
    }
    if (!holds(state, asking, ability.condition)) return state
  }
  let next = state
  if (ability.oncePerTurn) {
    const key = `${source.iid}#${index}`
    if (state.triggered.includes(key)) return state
    next = { ...next, triggered: [...next.triggered, key] }
  }
  const text = ability.text.split('~').join(source.card.name)
  if (!ability.effects.length) return remind(next, source.iid, source.card.name, text)

  const [id, minted] = mint(next, 's')
  return noted({
    ...minted,
    stack: [...minted.stack, {
      id,
      iid: source.iid,
      x: 0,
      ability: {
        text,
        effects: ability.effects,
        complete: ability.complete,
        event: about?.iid ?? null,
        known: about && known ? { [about.iid]: known } : {},
        ...(amount === undefined ? {} : { amount }),
      },
    }],
  }, `${source.card.name} triggers`)
}

const sameTally = (a: Tally, b: Tally) => (Object.keys(a) as (keyof Tally)[]).every((key) => a[key] === b[key])

/** Everything that triggered between two states, onto the stack. */
export function collectTriggers(before: GameState, after: GameState): GameState {
  const { events, tally } = happened(before, after)
  if (!events.length && !after.events.length && sameTally(tally, after.tally)) return after
  let next: GameState = { ...after, tally, events: after.events.length ? [] : after.events }
  /** "One or more": the abilities that have answered this time round. */
  const answered = new Set<string>()
  for (const event of events) {
    // A death is seen by what was on the battlefield as it happened, the dead
    // included: creatures that leave together each see the others go. A card
    // in the graveyard watches too, for the abilities that work from there.
    const watching = [
      ...(event.on === 'dies' ? inZone(before, 'battlefield') : inZone(next, 'battlefield')),
      ...inZone(next, 'graveyard').filter((c) => compile(c.card).triggers.some((ability) => ability.from === 'graveyard')),
    ]
    for (const source of watching) {
      compile(source.card).triggers.forEach((ability, index) => {
        // Each ability works from one place: the battlefield, unless it says.
        if ((ability.from ?? 'battlefield') !== (source.zone === 'graveyard' && event.on !== 'dies' ? 'graveyard' : 'battlefield')) return
        if (!sees(ability.when, event, source, next)) return
        const key = `${source.iid}#${index}`
        if (ability.batch && answered.has(key)) return
        answered.add(key)
        // What it was as it left, for a death; what it is, for the rest.
        const about = 'card' in event ? event.card : null
        const known = about ? snapshot(about, event.on === 'dies' ? before : next) : null
        // How much, for the abilities that ask: damage taken, or dealt.
        const amount = event.on === 'damaged' ? event.amount
          : event.on === 'combatDamage' ? combatDamage(next, event.card) : undefined
        next = fire(next, source, index, ability, about, known, amount)
      })
    }
  }
  return askOrder(after, next)
}

/** Abilities that triggered together go on the stack in an order you choose
 *  (CR 603.3b). Asked when more than one did and they do different things —
 *  and not in the middle of something else that is being asked. */
function askOrder(before: GameState, after: GameState): GameState {
  if (after.pending || after.resolving) return after
  const had = new Set(before.stack.map((item) => item.id))
  const added = after.stack.filter((item) => item.ability && !had.has(item.id))
  if (new Set(added.map((item) => item.ability!.text)).size < 2) return after
  return { ...after, pending: { kind: 'order', ids: added.map((item) => item.id) } }
}

/** "At the beginning of your upkeep", as the step begins. Text nothing reads
 *  yet is posted, so an upkeep the engine cannot do is not one you forget. */
export function stepTriggers(state: GameState, step: 'upkeep' | 'main' | 'combat' | 'end'): GameState {
  let next = state
  const opening = step === 'upkeep' ? /^at the beginning of (your|each) upkeep\b/i
    : step === 'main' ? /^at the beginning of your (first|precombat) main phase\b/i
      : step === 'combat' ? /^at the beginning of combat\b/i
        : /^at the beginning of (your|each|the) end step\b/i
  for (const source of inZone(state, 'battlefield')) {
    const compiled = compile(source.card)
    compiled.triggers.forEach((ability, index) => {
      if (ability.when.on === 'step' && ability.when.step === step) {
        next = fire(next, source, index, ability, null, null)
      }
    })
    const unread = compiled.unread.filter((line) => opening.test(line) || (step === 'upkeep' && /^cumulative upkeep\b/i.test(line)))
    if (unread.length) {
      next = remind(next, source.iid, source.card.name, unread.join('\n').split('~').join(source.card.name))
    }
    // Echo, owed since it arrived: pay it now, or the permanent goes.
    const echo = step === 'upkeep' && source.echo ? compiled.statics.find((fixed) => fixed.kind === 'echo') : undefined
    if (echo?.kind === 'echo') {
      const [id, minted] = mint(next, 's')
      next = noted({
        ...minted,
        cards: minted.cards.map((c) => (c.iid === source.iid ? { ...c, echo: undefined } : c)),
        stack: [...minted.stack, {
          id,
          iid: source.iid,
          x: 0,
          ability: {
            text: `Echo ${echo.cost} — pay it, or sacrifice ${source.card.name}.`,
            effects: [
              { op: 'pay', cost: echo.cost, optional: true },
              { op: 'move', what: { kind: 'self' }, to: 'graveyard', ifNot: true },
            ],
            complete: true,
            event: null,
            known: {},
          },
        }],
      }, `${source.card.name}: echo`)
    }
  }
  return next
}
