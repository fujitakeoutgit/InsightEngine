/**
 * Activated abilities: "cost: effect".
 *
 * The cost is read into parts the engine can pay — mana, tapping, life,
 * sacrifices, counters, loyalty — and the effect is compiled like any other.
 * A cost with a part nothing here knows how to pay is not half-read: the
 * whole ability is left in words, because paying most of a cost is not a
 * thing the rules allow.
 */

import type { ManaType } from '../mana'
import { readAbility } from './effects'
import type { AbilityCost, ActivatedAbility, Effect, Filter } from './ir'
import { readFilter, readNumber, readTest } from './read'

export const FREE: AbilityCost = {
  mana: null, tap: false, life: 0, sacrificeSelf: false, sacrifice: null, sacrificeAny: null,
  discardSelf: false, remove: null, add: null, tapOther: null, loyalty: null,
}

/** "{2}, {T}, Sacrifice ~" → what that takes; null if any part is unknown. */
export function readCost(text: string): AbilityCost | null {
  const cost: AbilityCost = { ...FREE }
  // A planeswalker's: "+1", "−3", "0".
  const loyalty = /^([+−-]?)(\d+)$/.exec(text.trim())
  if (loyalty) return { ...cost, loyalty: (loyalty[1] === '+' || !loyalty[1] ? 1 : -1) * Number(loyalty[2]) }

  // "Remove three quest counters from ~ and sacrifice it" is two costs.
  const parts = text.split(/,\s*/).flatMap((part) => part.split(/ and (?=sacrifice |pay |discard |remove |put |tap |exile )/i))
  for (const part of parts) {
    const p = part.trim().toLowerCase()
    if (p === '{t}') cost.tap = true
    else if (/^(\{[^}]+\})+$/.test(p)) {
      // X is asked for as the ability is activated.
      cost.mana = (cost.mana ?? '') + p.toUpperCase()
    } else if (/^sacrifice ~ and any number of /.test(p)) {
      // Emrakul's Evangel: itself, and as many others as you like.
      const filter = readFilter(p.replace(/^sacrifice ~ and any number of /, ''))
      if (!filter) return null
      cost.sacrificeSelf = true
      cost.sacrificeAny = { ...filter, controller: 'you' }
    } else if (/^sacrifice (~|it)$/.test(p)) cost.sacrificeSelf = true
    else if (/^sacrifice (an?|another) /.test(p)) {
      const filter = readFilter(p.replace(/^sacrifice an? /, '').replace(/^sacrifice another /, 'another '))
      if (!filter) return null
      cost.sacrifice = { ...filter, controller: 'you' }
    } else if (/^pay \d+ life$/.test(p)) cost.life += Number(/\d+/.exec(p)![0])
    else if (/^discard ~$/.test(p)) cost.discardSelf = true
    else if (/^put (an?|\w+) ([+-]\d\/[+-]\d|[a-z]+) counters? on ~$/.test(p)) {
      const put = /^put (an?|\w+) ([+-]\d\/[+-]\d|[a-z]+) counters? on ~$/.exec(p)!
      const count = readNumber(put[1])
      if (count === null) return null
      cost.add = { counter: put[2], count }
    } else if (/^exile (~|it)(?: from your graveyard)?$/.test(p)) cost.exileSelf = true
    else if (/^return (\w+) (.+?) to (?:its|their) owners?'s? hands?$/.test(p)) {
      const back = /^return (\w+) (.+?) to (?:its|their) owners?'s? hands?$/.exec(p)!
      const count = readNumber(back[1])
      const filter = readFilter(back[2])
      if (count === null || !filter) return null
      cost.bounce = { filter: { ...filter, controller: 'you' }, count }
    } else if (/^tap an untapped /.test(p)) {
      const filter = readFilter(p.replace(/^tap an untapped /, ''))
      if (!filter) return null
      cost.tapOther = { ...filter, controller: 'you', tapped: false }
    } else {
      const remove = /^remove (\w+) ([+-]\d\/[+-]\d|[a-z]+) counters? from ~$/.exec(p)
      const count = remove && readNumber(remove[1])
      if (!remove || count === null) return null
      cost.remove = { counter: remove[2], count: count as number }
    }
  }
  return cost
}

/** The mana an "Add …" makes, for a mana ability with a cost beyond {T}. */
function readMana(text: string): ManaType[][] | null {
  const t = text.trim().toLowerCase().replace(/\.$/, '')
  const symbols = /^add ((?:\{[wubrgc]\})+)$/.exec(t)
  if (symbols) return [...symbols[1].matchAll(/\{([wubrgc])\}/g)].map((m) => [m[1].toUpperCase() as ManaType])
  if (/^add one mana of any color$/.test(t)) return [['W', 'U', 'B', 'R', 'G']]
  return null
}

/** One line, as an activated ability; null if it is not one, or cannot be
 *  read whole. `shown` is the line as printed, for the menu. `given` is what
 *  it does when that was read elsewhere — the modes under "Choose one —". */
export function readActivated(
  line: string, shown: string, given?: { effects: Effect[]; complete: boolean },
): ActivatedAbility | null {
  // An ability word before the cost is flavor: "Renew — {2}{U}, …".
  const said = line.replace(/^[A-Z][A-Za-z']*(?: [A-Za-z']+)* — (?=\{)/, '')
  const colon = said.indexOf(': ')
  if (colon < 0) return null
  const cost = readCost(said.slice(0, colon))
  if (!cost) return null

  let body = said.slice(colon + 2)
  let sorcery = cost.loyalty !== null
  let oncePerTurn = false
  let only: ActivatedAbility['only']
  // "Activate only if you control a Time Lord": checked as it is activated.
  body = body.replace(/\s*activate only if ([^.]+)\.?/i, (whole, condition: string) => {
    const test = readTest(condition)
    if (test) only = { test, text: condition.trim() }
    return test ? '' : whole
  })
  // Riders on when it may be activated.
  body = body.replace(/\s*activate only as a sorcery\.?/i, () => { sorcery = true; return '' })
  body = body.replace(/\s*activate only once each turn\.?/i, () => { oncePerTurn = true; return '' })
  // Any other restriction is one this cannot check.
  if (/activate only/i.test(body)) return null

  const mana = given ? null : readMana(body)
  const read = given ?? (mana ? { effects: [] as Effect[], complete: true } : readAbility(body))
  // What exiles itself from the graveyard, or returns itself from there,
  // is used from there.
  const fromGraveyard = /\bfrom your graveyard\b/i.test(said.slice(0, colon)) || /^return ~ from your graveyard\b/i.test(body.trim())
  return {
    text: shown, cost, sorcery, oncePerTurn, fromHand: false, mana,
    effects: read.effects, complete: read.complete,
    ...(fromGraveyard ? { fromGraveyard } : {}),
    ...(only ? { only } : {}),
  }
}

/** Keywords that are activated abilities in shorthand: Equip, and cycling
 *  with its land-searching cousins. */
export function readKeywordAbility(line: string, shown: string): ActivatedAbility | null {
  const equip = /^equip(?: [a-z ]+?)? ((?:\{[^}]+\})+)$/.exec(line)
  if (equip) {
    return {
      text: shown,
      cost: { ...FREE, mana: equip[1].toUpperCase() },
      sorcery: true, oncePerTurn: false, fromHand: false, mana: null,
      effects: [
        { op: 'choose', filter: { types: ['creature'], controller: 'you' }, count: 1, upTo: false, must: true },
        { op: 'attach' },
      ],
      complete: true,
    }
  }
  // Crew: creatures tapped, and the Vehicle is one of them for the turn.
  const crew = /^crew (\d+)$/.exec(line)
  if (crew) {
    return {
      text: shown,
      cost: { ...FREE, crew: Number(crew[1]) },
      sorcery: false, oncePerTurn: false, fromHand: false, mana: null,
      effects: [{ op: 'animate', who: { kind: 'self' }, change: { types: ['Creature'] }, until: 'end' }],
      complete: true,
    }
  }
  const cycling = /^(?:(basic land|plains|island|swamp|mountain|forest))?cycling ((?:\{[^}]+\})+)$/.exec(line)
  if (cycling) {
    const kind = cycling[1]
    const found: Filter | null = !kind ? null
      : kind === 'basic land' ? { basic: true, types: ['land'] }
        : { subtypes: [kind[0].toUpperCase() + kind.slice(1)] }
    return {
      text: shown,
      cost: { ...FREE, mana: cycling[2].toUpperCase(), discardSelf: true },
      sorcery: false, oncePerTurn: false, fromHand: true, mana: null,
      effects: found
        ? [{ op: 'search', filter: found, count: 1, upTo: false, to: 'hand', tapped: false }]
        : [{ op: 'draw', count: 1 }],
      complete: true,
    }
  }
  return null
}
