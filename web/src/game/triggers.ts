/**
 * Triggered abilities.
 *
 * What happened is read off the difference between the game before an action
 * and after it: a card that was not on the battlefield and now is has
 * entered, a creature that was and is now in the graveyard has died. That
 * covers moves you make by hand as well as ones the engine makes — drag a
 * creature to the graveyard and it has died, with everything that watches for
 * that — and it needs no bookkeeping in the code that moves cards.
 *
 * Each ability that saw the event goes on the stack, to resolve when you pass.
 */

import { remind } from './cast'
import { compile } from './compiler/compile'
import type { TriggeredAbility, TriggerEvent } from './compiler/ir'
import { matches, onBattlefield } from './match'
import { isCreature } from './sources'
import { inZone, mint, noted } from './state'
import { stats } from './stats'
import type { GameState, Instance, Known } from './types'

type Happened =
  | { on: 'enters' | 'dies' | 'cast' | 'attacks' | 'combatDamage'; card: Instance }
  | { on: 'lifeGain' | 'landPlay' | 'attack' }

function happened(before: GameState, after: GameState): Happened[] {
  const out: Happened[] = []
  const was = new Map(before.cards.map((c) => [c.iid, c]))
  for (const now of after.cards) {
    const prev = was.get(now.iid)
    if (now.zone === 'battlefield' && prev?.zone !== 'battlefield') out.push({ on: 'enters', card: now })
    // Dying is going to the graveyard from the battlefield, and only
    // creatures do it. The card is taken as it was, counters and all.
    if (prev?.zone === 'battlefield' && now.zone === 'graveyard' && isCreature(prev)) {
      out.push({ on: 'dies', card: prev })
    }
  }
  const stacked = new Set(before.stack.map((item) => item.id))
  for (const item of after.stack) {
    if (item.ability || stacked.has(item.id)) continue
    const card = after.cards.find((c) => c.iid === item.iid)
    if (card) out.push({ on: 'cast', card })
  }
  // Attackers are declared together, and each is an attack of its own.
  if (after.attacking.length && !before.attacking.length) {
    out.push({ on: 'attack' })
    for (const iid of after.attacking) {
      const card = after.cards.find((c) => c.iid === iid)
      if (card) out.push({ on: 'attacks', card })
    }
  }
  if (after.dealt !== before.dealt) {
    for (const iid of after.dealt) {
      const card = after.cards.find((c) => c.iid === iid)
      if (card) out.push({ on: 'combatDamage', card })
    }
  }
  if (after.life > before.life) out.push({ on: 'lifeGain' })
  if (after.landsPlayed > before.landsPlayed) out.push({ on: 'landPlay' })
  return out
}

function sees(when: TriggerEvent, event: Happened, source: Instance): boolean {
  if (when.on !== event.on) return false
  if (when.on === 'enters' || when.on === 'dies' || when.on === 'attacks' || when.on === 'combatDamage') {
    const { card } = event as Extract<Happened, { card: Instance }>
    if (when.who === 'self') return card.iid === source.iid
    // "Equipped creature": what this is on.
    if (when.who === 'attached') return source.attachedTo === card.iid
    return matches(card, when.who, source.iid)
  }
  if (when.on === 'cast') {
    return matches((event as Extract<Happened, { card: Instance }>).card, when.filter, source.iid)
  }
  return true
}

/** Put one ability on the stack — or, if nothing of it was understood, post
 *  its words straight away: there is nothing for the stack to resolve. */
function fire(
  state: GameState, source: Instance, index: number, ability: TriggeredAbility,
  about: Instance | null, known: Known | null,
): GameState {
  if (ability.condition
    && onBattlefield(state, ability.condition.filter, source.iid).length < ability.condition.atLeast) {
    return state
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
      },
    }],
  }, `${source.card.name} triggers`)
}

/** Everything that triggered between two states, onto the stack. */
export function collectTriggers(before: GameState, after: GameState): GameState {
  const events = happened(before, after)
  if (!events.length) return after
  let next = after
  for (const event of events) {
    // A death is seen by what was on the battlefield as it happened, the dead
    // included: creatures that leave together each see the others go.
    const watching = event.on === 'dies' ? inZone(before, 'battlefield') : inZone(next, 'battlefield')
    for (const source of watching) {
      compile(source.card).triggers.forEach((ability, index) => {
        if (sees(ability.when, event, source)) {
          // What it was as it left, for a death; what it is, for the rest.
          const about = 'card' in event ? event.card : null
          const known = about ? stats(about, event.on === 'dies' ? before : next) : null
          next = fire(next, source, index, ability, about, known)
        }
      })
    }
  }
  return next
}

/** "At the beginning of your upkeep", as the step begins. Text nothing reads
 *  yet is posted, so an upkeep the engine cannot do is not one you forget. */
export function stepTriggers(state: GameState, step: 'upkeep' | 'combat' | 'end'): GameState {
  let next = state
  const opening = step === 'upkeep' ? /^at the beginning of (your|each) upkeep\b/i
    : step === 'combat' ? /^at the beginning of combat\b/i
      : /^at the beginning of (your|each|the) end step\b/i
  for (const source of inZone(state, 'battlefield')) {
    const compiled = compile(source.card)
    compiled.triggers.forEach((ability, index) => {
      if (ability.when.on === 'step' && ability.when.step === step) {
        next = fire(next, source, index, ability, null, null)
      }
    })
    const unread = compiled.unread.filter((line) => opening.test(line))
    if (unread.length) {
      next = remind(next, source.iid, source.card.name, unread.join('\n').split('~').join(source.card.name))
    }
  }
  return next
}
