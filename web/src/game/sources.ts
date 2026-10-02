/**
 * What a permanent can tap for.
 *
 * Read off the oracle text, like the rest of the engine, so it covers cards
 * nobody listed. The forms are few: a cost that includes {T}, a colon, and
 * "Add" followed by symbols or one of a handful of phrases. Abilities that
 * cost something the tapper cannot decide to spend on its own — sacrificing
 * a Treasure, a counter on Wall of Roots — are left for you to use by hand.
 */

import { compile } from './compiler/compile'
import type { Filter } from './compiler/ir'
import { readFilter } from './compiler/read'
import { hasSubtype, isKind, sweeping } from './kinds'
import { matches } from './match'
import {
  COLORS, demand, parseCost, sourcePenalty, type Color, type ManaPool, type ManaSource, type ManaType,
} from './mana'
import { hasKeyword } from './stats'
import type { GameState, Instance } from './types'

export { hasKeyword }

export interface ManaAbility {
  /** One entry per mana it makes, each listing the kinds that mana may be. */
  makes: ManaType[][]
  /** Mana its cost asks for on top of tapping — a Signet's `{1}`. */
  input: number
  /** The ability's own words. */
  text: string
  /** A counter it puts on the permanent as it is tapped: "Add {U}. Put a
   *  time counter on ~." */
  rider?: string
  /** "Spend this mana only to cast …": what it may pay for. */
  only?: Restriction
  /** "Remove X storage counters: Add X mana": the counters it spends, one
   *  for each mana. `makes` is then everything it could give. */
  storage?: string
}

/** What restricted mana may be spent on: spells like this, abilities of
 *  permanents like that. Null where it may not be spent that way at all. */
export interface Restriction { spell: Filter | null; ability: Filter | null }

/** What mana is wanted for: a spell being cast, or an ability of a card. */
export interface Purpose { spell?: Instance; ability?: Instance }

/** "to cast a creature spell of the chosen type or activate an ability of a
 *  creature source of the chosen type" → what that allows. Words this does
 *  not know allow nothing, so the tapper never spends such mana wrongly. */
function readRestriction(text: string): Restriction {
  const m = /^to cast (?:an? )?(.+?) spells?( of the chosen type)?(?: or (?:to )?activate (?:an ability|abilities) of (?:an? )?(.+?)(?: sources?)?( of the chosen type)?)?$/i.exec(text.trim())
  if (!m) return { spell: null, ability: null }
  const kind = (phrase: string, chosen: string | undefined) => {
    const filter = readFilter(phrase)
    return filter && (chosen ? { ...filter, chosenType: true } : filter)
  }
  return { spell: kind(m[1], m[2]), ability: m[3] ? kind(m[3], m[4]) : null }
}

/** May this ability's mana be spent on that? */
function allowed(ability: ManaAbility, source: Instance, purpose: Purpose, state: GameState): boolean {
  if (!ability.only) return true
  const { spell, ability: of } = ability.only
  if (purpose.spell) return spell !== null && matches(purpose.spell, spell, source.iid, state)
  if (purpose.ability) return of !== null && matches(purpose.ability, of, source.iid, state)
  return false
}

const LAND_TYPES: [string, Color][] = [
  ['Plains', 'W'], ['Island', 'U'], ['Swamp', 'B'], ['Mountain', 'R'], ['Forest', 'G'],
]

const NUMBERS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5 }

const SYMBOL = /\{([WUBRGC])\}/g

/** Reminder text restates rules, and a basic land's mana ability lives only
 *  there — the land type grants it — so it is read from the type instead. */
const stripReminder = (text: string) => text.replace(/\([^)]*\)/g, '')

const lines = (card: Instance['card']) =>
  stripReminder(card.oracle_text ?? card.card_faces?.[0]?.oracle_text ?? '')
    .split('\n').map((line) => line.trim()).filter(Boolean)

export const isCreature = (inst: Instance) => /\bCreature\b/.test(inst.card.type_line ?? '')

/** "Your commander's color identity". Every color when there is no
 *  commander to ask, since then nothing narrows it. */
export function identity(state: GameState): Color[] {
  const commanders = state.cards.filter((c) => c.commander)
  if (!commanders.length) return [...COLORS]
  const letters = new Set(commanders.flatMap((c) => [...(c.card.color_identity ?? '')]))
  return COLORS.filter((color) => letters.has(color))
}

/** How many permanents you control match "creatures you control with
 *  defender" and the like, or null for a phrase this does not read. */
function countControlled(state: GameState, phrase: string): number | null {
  const said = /^(?:other )?(\w+?)s? you control(?: with (\w+))?$/i.exec(phrase.trim())
  if (!said) return null
  const [, noun, keyword] = said
  const kind = noun.toLowerCase() === 'permanent' ? '' : noun
  return state.cards.filter((c) => (
    c.zone === 'battlefield'
    // "For each Elf": a changeling is one, which the type line does not say.
    && (!kind || hasSubtype(c, kind[0].toUpperCase() + kind.slice(1), sweeping(state)))
    && (!keyword || hasKeyword(c, keyword, state))
  )).length
}

/** The mana an "Add …" phrase makes, one entry per mana, or null if this is
 *  not a phrase the tapper can count on. */
function readOutput(phrase: string, state: GameState, self: Instance): ManaType[][] | null {
  const text = phrase.trim()
  const any = identity(state)
  const symbols = [...text.matchAll(SYMBOL)].map((m) => m[1] as ManaType)

  // {C}{C}, {B}{G}: exactly these.
  if (/^(\{[WUBRGC]\})+$/.test(text)) return symbols.map((kind) => [kind])

  // {G} or {W} / {R}, {G}, or {W}: one, of any of these.
  if (/^\{[WUBRGC]\}(,? (or )?\{[WUBRGC]\})+$/.test(text)) return [symbols]

  // {B}{B}, {B}{G}, or {G}{G}: two, each of either — the filter lands.
  if (/^(\{[WUBRG]\}){2}(,? (or )?(\{[WUBRG]\}){2})+$/.test(text)) {
    const kinds = [...new Set(symbols)]
    return [kinds, kinds]
  }

  // {R} or one mana of the chosen color: the color was chosen as it entered.
  // Read as any of yours, since the choice is not recorded.
  const chosen = /^\{([WUBRG])\} or one mana of the chosen color$/.exec(text)
  if (chosen) return [[...new Set([chosen[1] as ManaType, ...any])]]

  // {G} for each creature you control with defender.
  const each = /^\{([WUBRGC])\} for each (.+)$/.exec(text)
  if (each) {
    const n = countControlled(state, each[2])
    return n === null ? null : Array.from({ length: n }, () => [each[1] as ManaType])
  }

  // X mana in any combination of colors, where X is the number of …
  const x = /^X mana (?:of any one color|in any combination of colors), where X is the number of (.+)$/i.exec(text)
  if (x) {
    const n = countControlled(state, x[1])
    return n === null ? null : Array.from({ length: n }, () => [...any])
  }

  // one / two / three mana of any color, any one color, any combination.
  const several = /^(one|two|three|four|five) mana (?:of any (?:one )?color|in any combination of colors)(.*)$/i.exec(text)
  if (several) {
    const tail = several[2].trim()
    // "in your commander's color identity", and an opponent's land: read as
    // your own colors — there is no opponent's land to ask.
    if (tail && !/^(in your commander's color identity|that a land an opponent controls could produce)$/i.test(tail)) {
      return null
    }
    return Array.from({ length: NUMBERS[several[1].toLowerCase()] }, () => [...any])
  }

  // one mana of any type that a land you control could produce.
  if (/^one mana of any type that a land you control could produce$/i.test(text)) {
    const kinds = new Set<ManaType>()
    for (const c of state.cards) {
      if (c.zone !== 'battlefield' || c.iid === self.iid || !/\bLand\b/.test(c.card.type_line ?? '')) continue
      for (const kind of c.card.produced_mana ?? []) if (kind !== 'T') kinds.add(kind as ManaType)
    }
    return kinds.size ? [[...kinds]] : null
  }
  return null
}

/** The {T} mana abilities a permanent has, as the board stands. */
export function manaAbilities(inst: Instance, state: GameState): ManaAbility[] {
  const out: ManaAbility[] = []

  // A land's basic types each grant "{T}: Add" their color (CR 305.6) — all
  // five of them, under Dryad of the Ilysian Grove.
  const line = inst.card.type_line ?? ''
  if (/\bLand\b/.test(line)) {
    const sweep = sweeping(state)
    const kinds = LAND_TYPES.filter(([type]) => sweep.lands || new RegExp(`\\b${type}\\b`).test(line)).map(([, c]) => c)
    if (kinds.length) {
      out.push({ makes: [kinds], input: 0, text: `{T}: Add ${kinds.map((k) => `{${k}}`).join(' or ')}.` })
    }
  }

  for (const text of lines(inst.card)) {
    // Faeburrow Elder: one of each color among your permanents.
    if (/^\{T\}: For each color among permanents you control, add one mana of that color\.?$/i.test(text)) {
      const colors = new Set(state.cards
        .filter((c) => c.zone === 'battlefield')
        .flatMap((c) => [...(c.card.colors ?? '')]))
      const makes = COLORS.filter((color) => colors.has(color)).map((color) => [color as ManaType])
      if (makes.length) out.push({ makes, input: 0, text })
      continue
    }

    const colon = text.indexOf(': ')
    if (colon < 0) continue
    const added = /^Add ([^.]+)\./i.exec(text.slice(colon + 2))
    if (!added) continue

    let taps = false
    let input = 0
    let usable = true
    let storage: string | undefined
    for (const part of text.slice(0, colon).split(/,\s*/)) {
      const stored = /^Remove X ([a-z]+) counters from /i.exec(part)
      if (stored) storage = stored[1].toLowerCase()
      else if (part === '{T}') taps = true
      else if (/^\{\d+\}$/.test(part)) input += Number(part.slice(1, -1))
      // A filter land's colored input. Counted as one mana of any kind,
      // which over-promises a little; it is only ever used when asked.
      else if (/^\{[WUBRG](\/[WUBRG])?\}$/.test(part)) input += 1
      else usable = false
    }
    if (!taps || !usable) continue

    const restricted = /\. Spend this mana only ([^.]+)\.?$/i.exec(text.slice(colon + 2))
    const only = restricted ? { only: readRestriction(restricted[1]) } : {}
    if (storage) {
      // As much as there are counters to take off, each mana any of the
      // colors it names.
      const kinds = /^X mana in any combination of colors$/i.test(added[1])
        ? identity(state)
        : [...added[1].matchAll(SYMBOL)].map((m) => m[1] as ManaType)
      const stored = inst.counters?.[storage] ?? 0
      if (kinds.length && stored > 0) {
        out.push({ makes: Array.from({ length: stored }, () => [...kinds]), input, text, storage, ...only })
      }
      continue
    }
    const makes = readOutput(added[1], state, inst)
    const rider = /^Add [^.]+\. Put an? ([a-z]+) counter on [^.]+\.?$/i.exec(text.slice(colon + 2))
    if (makes?.length) out.push({ makes, input, text, ...(rider ? { rider: rider[1].toLowerCase() } : {}), ...only })
  }
  return out.map((ability) => ({ ...ability, makes: [...ability.makes, ...additional(inst, state, ability.makes)] }))
}

/** "Whenever you tap a Forest for mana, add an additional {G}": what a tap
 *  for this much makes on top, from everything on the battlefield that says
 *  so. One that asks for {C} answers only to a tap that makes nothing else. */
function additional(inst: Instance, state: GameState, makes: readonly ManaType[][]): ManaType[][] {
  const more: ManaType[][] = []
  const sweep = sweeping(state)
  for (const source of state.cards) {
    if (source.zone !== 'battlefield') continue
    for (const fixed of compile(source.card).statics) {
      if (fixed.kind !== 'extraMana') continue
      // The land an Aura is on, or whatever answers to the filter.
      const mine = fixed.tapped === 'attached' ? source.attachedTo === inst.iid : isKind(inst, fixed.tapped, source.iid, sweep)
      if (!mine) continue
      if (fixed.of && !makes.every((unit) => unit.length === 1 && unit[0] === fixed.of)) continue
      const { per } = fixed
      const times = per
        ? state.cards.filter((c) => c.zone === 'battlefield' && isKind(c, per, source.iid, sweep)).length
        : 1
      for (let i = 0; i < times; i += 1) more.push([fixed.adds])
    }
  }
  return more
}

/** The permanent a payment's tap is of: stored counters are offered one at
 *  a time, as `iid@1`, `iid@2`. */
export const realId = (id: string) => id.split('@')[0]

/** These permanents, tapped for mana: turned sideways, and with whatever
 *  else their mana ability does — a time counter on Trenzalore Clocktower,
 *  a storage counter off for each mana a storage land gave. */
export function tapForPayment(state: GameState, ids: ReadonlySet<string>): Instance[] {
  const spent = new Map<string, number>()
  for (const id of ids) if (id.includes('@')) spent.set(realId(id), (spent.get(realId(id)) ?? 0) + 1)
  return state.cards.map((c) => {
    const stored = spent.get(c.iid)
    if (stored) {
      const kind = manaAbilities(c, state).find((ability) => ability.storage)?.storage
      return kind
        ? { ...c, tapped: true, counters: { ...c.counters, [kind]: Math.max(0, (c.counters?.[kind] ?? 0) - stored) } }
        : { ...c, tapped: true }
    }
    if (!ids.has(c.iid)) return c
    const [rider] = manaAbilities(c, state).map((ability) => ability.rider).filter(Boolean)
    return {
      ...c,
      tapped: true,
      ...(rider ? { counters: { ...c.counters, [rider]: (c.counters?.[rider] ?? 0) + 1 } } : {}),
    }
  })
}

/** The same sources, with counters stored on a land offered as well — one
 *  source for each, so that only as many are spent as are needed — in place
 *  of whatever else that land could have been tapped for. */
export function withStorage(state: GameState, sources: readonly ManaSource[], purpose: Purpose): ManaSource[] {
  let out = [...sources]
  for (const inst of state.cards) {
    if (!canTapForMana(inst, state)) continue
    const stored = manaAbilities(inst, state).find((ability) => ability.storage && allowed(ability, inst, purpose, state))
    if (!stored) continue
    out = [
      ...out.filter((source) => source.id !== inst.iid),
      ...stored.makes.map((unit, i) => ({ id: `${inst.iid}@${i + 1}`, makes: [unit], penalty: 4 + i * 0.01 })),
    ]
  }
  return out
}

/** Which of several kinds of mana to make, when nothing says: the one the
 *  hand most wants, among the commander's colors. */
export function chooseKind(state: GameState, kinds: readonly ManaType[]): ManaType {
  if (kinds.length === 1) return kinds[0]
  const allowed = kinds.filter((k) => (identity(state) as ManaType[]).includes(k))
  const wanted = demand(state.cards.filter((c) => c.zone === 'hand').map((c) => parseCost(c.card.mana_cost)))
  const from = allowed.length ? allowed : kinds
  return from.reduce((best, k) => (wanted[k] > wanted[best] ? k : best), from[0])
}

/** Does it do anything besides make mana? Then tapping it for mana spends
 *  that too, and the tapper should prefer something else. */
function hasOtherAbilities(inst: Instance) {
  return lines(inst.card).some((text) => {
    const colon = text.indexOf(': ')
    return colon >= 0 && !/^Add /i.test(text.slice(colon + 2))
  })
}

/** May it be tapped for mana now? */
export function canTapForMana(inst: Instance, state?: GameState) {
  if (inst.zone !== 'battlefield' || inst.tapped) return false
  // Summoning sickness stops {T} on creatures, haste excepted (CR 302.6).
  return !(isCreature(inst) && inst.sick && !hasKeyword(inst, 'Haste', state))
}

/**
 * Everything untapped that can pay, described for `autotap`.
 *
 * A permanent offers its abilities that need nothing but a tap, merged — a
 * pain land's {C} and its {W}-or-{B} are one mana of any of the three — or,
 * if it has none, its first ability with an input: a Signet.
 */
export function manaSources(
  state: GameState,
  wanted: Partial<ManaPool> = {},
  except: ReadonlySet<string> = new Set(),
  purpose: Purpose = {},
): ManaSource[] {
  const out: ManaSource[] = []
  for (const inst of state.cards) {
    if (except.has(inst.iid) || !canTapForMana(inst, state)) continue
    // Only what may be spent on this; stored counters are offered apart.
    const abilities = manaAbilities(inst, state)
      .filter((ability) => !ability.storage && allowed(ability, inst, purpose, state))
    if (!abilities.length) continue

    const free = abilities.filter((a) => a.input === 0)
    let makes: ManaType[][]
    let input = 0
    if (free.length && free.every((a) => a.makes.length === 1)) {
      makes = [[...new Set(free.flatMap((a) => a.makes[0]))]]
    } else if (free.length) {
      makes = free.reduce((most, a) => (a.makes.length > most.makes.length ? a : most)).makes
    } else {
      makes = abilities[0].makes
      input = abilities[0].input
    }

    const penalty = sourcePenalty(makes, {
      creature: isCreature(inst),
      abilities: hasOtherAbilities(inst),
    }, wanted)
    out.push({ id: inst.iid, makes, input, penalty })
  }
  return out
}
