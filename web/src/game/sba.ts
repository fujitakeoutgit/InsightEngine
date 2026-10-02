/**
 * State-based actions (CR 704): what the game checks for itself whenever a
 * player would get priority, whoever caused it. Only with the rules on — in
 * the sandbox a token dragged to the graveyard stays there, because you put
 * it there.
 *
 * One pass at a time. Dying is an event abilities watch for, so the caller
 * looks for triggers between passes rather than after them all.
 */

import { compile } from './compiler/compile'
import { hasKeyword, isCreature } from './sources'
import { cantLose, noted, relocate } from './state'
import { sizeKnown, toughness } from './stats'
import type { GameState, Instance } from './types'

/**
 * The legend rule (704.5j): the legendary permanents that share a name with
 * another, the first such set — or null. It is the one state-based action
 * that needs an answer, so it is asked rather than carried out: see `askType`
 * in priority.ts. Not while something says the rule does not apply.
 */
export function legendTwins(state: GameState): Instance[] | null {
  if (!state.rules) return null
  const here = state.cards.filter((c) => c.zone === 'battlefield')
  if (here.some((c) => compile(c.card).statics.some((fixed) => fixed.kind === 'noLegendRule'))) return null
  const legends = here.filter((c) => /\bLegendary\b/.test(c.card.type_line ?? ''))
  for (const c of legends) {
    const twins = legends.filter((other) => other.card.name === c.card.name)
    if (twins.length > 1) return twins
  }
  return null
}

/** One is kept, and the rest are put into the graveyard — neither destroyed
 *  nor sacrificed, so nothing saves them. */
export function keepLegend(state: GameState, twins: readonly string[], keep: string): GameState {
  const kept = state.cards.find((c) => c.iid === keep)
  let cards = state.cards
  for (const iid of twins) if (iid !== keep) cards = relocate(cards, iid, 'graveyard')
  return noted({ ...state, cards }, `Legend rule: kept one ${kept?.card.name ?? 'of them'}, the other${
    twins.length > 2 ? 's go' : ' goes'} to the graveyard`)
}

const isWalker = (line: string | null) => /\bPlaneswalker\b/.test(line ?? '')

export function stateBased(state: GameState): GameState {
  if (!state.rules) return state
  let next = state

  // A token anywhere but the battlefield ceases to exist (704.5d).
  const vanished = next.cards.filter((c) => c.token && c.zone !== 'battlefield')
  if (vanished.length) {
    next = { ...next, cards: next.cards.filter((c) => !(c.token && c.zone !== 'battlefield')) }
    for (const c of vanished) next = noted(next, `${c.card.name} ceases to exist`)
  }

  for (const c of next.cards) {
    if (c.zone !== 'battlefield') continue

    // +1/+1 and -1/-1 counters cancel each other out (704.5q).
    const plus = c.counters?.['+1/+1'] ?? 0
    const minus = c.counters?.['-1/-1'] ?? 0
    if (plus && minus) {
      const off = Math.min(plus, minus)
      const counters = { ...c.counters, '+1/+1': plus - off, '-1/-1': minus - off }
      next = { ...next, cards: next.cards.map((x) => (x.iid === c.iid ? { ...x, counters } : x)) }
    }

    // Only a creature whose size the engine is sure of — see `sizeKnown`.
    // Killing one over a number it could not work out would punish the card
    // for the engine's ignorance.
    if (isCreature(c) && sizeKnown(c)) {
      // Toughness 0 or less: into the graveyard (704.5f).
      const tough = toughness(c, next)
      if (tough <= 0) {
        next = noted({ ...next, cards: relocate(next.cards, c.iid, 'graveyard') }, `${c.card.name} dies — toughness ${tough}`)
        continue
      }
      // Lethal damage destroys it (704.5g), unless nothing can.
      if ((c.damage ?? 0) > 0 && (c.damage ?? 0) >= tough && !hasKeyword(c, 'Indestructible', next)) {
        next = noted({ ...next, cards: relocate(next.cards, c.iid, 'graveyard') }, `${c.card.name} dies — lethal damage`)
        continue
      }
    }

    // A Saga whose last chapter has been told is sacrificed (704.5s) — once
    // that chapter is off the stack.
    const saga = compile(c.card).statics.find((fixed) => fixed.kind === 'saga')
    if (saga?.kind === 'saga' && (c.counters?.lore ?? 0) >= saga.last
      && !next.stack.some((item) => item.iid === c.iid) && next.resolving?.source !== c.iid) {
      next = noted({ ...next, cards: relocate(next.cards, c.iid, 'graveyard') }, `${c.card.name} is finished, and sacrificed`)
      continue
    }

    // A planeswalker with no loyalty goes to the graveyard (704.5i).
    if (isWalker(c.card.type_line) && (c.loyalty ?? 0) <= 0) {
      next = noted({ ...next, cards: relocate(next.cards, c.iid, 'graveyard') }, `${c.card.name} has no loyalty left`)
    }
  }

  // What is attached to something no longer there comes off: an Equipment
  // stays, unattached, and an Aura with nothing to enchant goes to the
  // graveyard (704.5m, 704.5n).
  for (const c of next.cards) {
    if (c.zone !== 'battlefield') continue
    const aura = /\bAura\b/.test(c.card.type_line ?? '')
    const host = c.attachedTo ? next.cards.find((h) => h.iid === c.attachedTo) : undefined
    if (c.attachedTo && host?.zone !== 'battlefield') {
      next = aura
        ? noted({ ...next, cards: relocate(next.cards, c.iid, 'graveyard') }, `${c.card.name} has nothing to enchant`)
        : { ...next, cards: next.cards.map((x) => (x.iid === c.iid ? { ...x, attachedTo: undefined } : x)) }
    } else if (aura && !c.attachedTo && !next.resolving) {
      next = noted({ ...next, cards: relocate(next.cards, c.iid, 'graveyard') }, `${c.card.name} has nothing to enchant`)
    }
  }

  // What is something else only while another permanent is attached to it,
  // or is on the battlefield at all, is itself again once that is not so.
  for (const c of next.cards) {
    if (c.zone !== 'battlefield' || !c.was || (c.revert !== 'attached' && c.revert !== 'source')) continue
    const by = next.cards.find((x) => x.iid === c.revertBy)
    const holds = by?.zone === 'battlefield' && (c.revert === 'source' || by.attachedTo === c.iid)
    // An Aura still arriving has not been put on anything yet.
    if (holds || next.resolving?.source === c.revertBy) continue
    next = noted({
      ...next,
      cards: next.cards.map((x) => (x.iid === c.iid ? { ...x, card: c.was!, was: undefined, revert: undefined, revertBy: undefined } : x)),
    }, `${c.was.name} is itself again`)
  }

  // A commander in a graveyard or exile may go home instead (903.9a). It
  // always does here: keeping it in the graveyard is a choice nobody makes
  // without a reason the engine cannot see. Only one that was already there
  // as this pass began: a commander that dies in this pass spends it in the
  // graveyard, where the abilities that watch for deaths can see it.
  for (const c of state.cards) {
    if (c.commander && (c.zone === 'graveyard' || c.zone === 'exile')) {
      next = noted({ ...next, cards: relocate(next.cards, c.iid, 'command') }, `${c.card.name} returns to the command zone`)
    }
  }

  // The city's blessing: with something that ascends and ten permanents,
  // you have it — for the rest of the game (CR 702.131).
  if (!next.blessing) {
    const permanents = next.cards.filter((c) => c.zone === 'battlefield')
    if (permanents.length >= 10 && permanents.some((c) => compile(c.card).statics.some((fixed) => fixed.kind === 'ascend'))) {
      next = noted({ ...next, blessing: true }, "You have the city's blessing")
    }
  }

  // No life left loses the game (704.5a) — yours, or theirs.
  if (next.life <= 0 && !next.lost && !cantLose(next)) {
    next = noted({ ...next, lost: `Your life reached ${next.life} on turn ${next.turn}` }, 'You are out of life')
  }
  if (!next.won) {
    // Theirs: no life (704.5a), ten poison (704.5c), or 21 combat damage
    // from one commander (903.10a).
    const { life, poison, commander } = next.opponent
    const lethal = Object.entries(commander).find(([, n]) => n >= 21)
    const how = life <= 0 ? `The opponent reached ${life} life`
      : poison >= 10 ? `The opponent has ${poison} poison counters`
        : lethal ? `${next.cards.find((c) => c.iid === lethal[0])?.card.name ?? 'Your commander'} dealt ${lethal[1]} commander damage`
          : null
    if (how) next = noted({ ...next, won: `${how} on turn ${next.turn}` }, 'The opponent has lost')
  }
  return next
}
