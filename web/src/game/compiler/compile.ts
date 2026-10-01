/**
 * A card's rules text → what the engine can do with it.
 *
 * Each line of oracle text is one ability, and is one of: keywords, a mana
 * ability, a land's enters-tapped clause (read elsewhere), a triggered
 * ability, a static ability the engine applies, an activated ability, or —
 * on an instant or sorcery — the spell itself. Lines are compiled where a
 * pattern fits and kept in words where none does, and the card is graded by
 * how much of it was understood.
 *
 * Compiled once per card and remembered: the text never changes mid-game.
 */

import type { Card } from '../../lib/api'
import { readActivated, readKeywordAbility } from './activated'
import { readAbility } from './effects'
import type {
  Ability, ActivatedAbility, Compiled, Coverage, Filter, Static, TriggerEvent, TriggeredAbility,
} from './ir'
import { readFilter, readNumber } from './read'
import { isInert, readStatic } from './statics'

/** Keywords with nothing to do at resolution: evasion, protection, combat
 *  abilities the attack step will read, and flash, which casting already
 *  does. A line made only of these is fully understood. */
const STATIC_KEYWORDS = new Set([
  'flying', 'vigilance', 'haste', 'trample', 'reach', 'deathtouch', 'lifelink',
  'first strike', 'double strike', 'defender', 'menace', 'hexproof',
  'indestructible', 'flash', 'shroud', 'intimidate', 'fear', 'prowess',
  'changeling', 'devoid', 'skulk', 'horsemanship', 'shadow',
])

const isKeywordLine = (line: string) => line.split(/,\s*/).every((part) => (
  STATIC_KEYWORDS.has(part)
  || /^(ward|protection from|hexproof from|landwalk)\b/.test(part)
  || /^(forest|island|swamp|mountain|plains)walk$/.test(part)
))

/** "{T}: Add …", "{1}, {T}: Add …" — read by `sources.ts` when tapped. */
const isManaAbility = (line: string) =>
  /^(\{[^}]+\}(, )?)+(, pay \d+ life)?: add\b/.test(line)
  || /^\{t\}: for each color among permanents you control, add\b/.test(line)

/** A fetch land's search, which the table cracks when it is tapped. */
const isFetch = (line: string) =>
  /^(\{[^}]+\}, )*\{t\}, (pay \d+ life, )?sacrifice ~: search your library for /.test(line)

/** A land's own arrival, which `landTiming` reads. */
const isLandEntry = (line: string) =>
  /^(~ enters tapped|as ~ enters, (you may (pay|reveal)|choose a color)|if you don't, ~ enters tapped)/.test(line)

/** Strip reminder text and put "~" for the card itself. */
export function normalize(card: Card, text: string): string[] {
  const names = new Set<string>()
  for (const name of [card.name, ...(card.card_faces ?? []).map((f) => f.name)]) {
    if (!name) continue
    for (const part of name.split(' // ')) {
      names.add(part)
      // Legends are called by their first name: "Felothar" for Felothar the
      // Steadfast, "Baldin" for Baldin, Century Herdmaster.
      names.add(part.split(',')[0])
    }
  }
  let out = text.replace(/\([^)]*\)/g, '')
  for (const name of [...names].sort((a, b) => b.length - a.length)) {
    out = out.split(name).join('~')
  }
  out = out.replace(/\bthis (creature|land|artifact|enchantment|permanent|planeswalker|token|equipment|vehicle|spell|card)\b/gi, '~')
  return out.split('\n').map((line) => line.trim()).filter(Boolean)
}

/** "When ~ enters", "Whenever another creature you control dies", "At the
 *  beginning of your upkeep" → the event. Null for anything else. */
function readTrigger(condition: string): TriggerEvent[] | null {
  const one = readOneTrigger(condition)
  if (one) return [one]
  if (/^~ enters or attacks$/.test(condition.trim())) {
    return [{ on: 'enters', who: 'self' }, { on: 'attacks', who: 'self' }]
  }
  // "When ~ enters or dies", "Whenever another creature you control enters
  // or dies": the same ability, on either event.
  const either = /^(.+?) enters or dies$/.exec(condition.trim())
  if (either) {
    const entering = readOneTrigger(`${either[1]} enters`)
    const dying = readOneTrigger(`${either[1]} dies`)
    if (entering && dying) return [entering, dying]
  }
  return null
}

function readOneTrigger(condition: string): TriggerEvent | null {
  const c = condition.trim()
  if (/^~ (enters|enters the battlefield)$/.test(c)) return { on: 'enters', who: 'self' }
  if (/^~ dies$/.test(c)) return { on: 'dies', who: 'self' }
  if (/^~ attacks$/.test(c)) return { on: 'attacks', who: 'self' }
  if (/^(equipped|enchanted) creature dies$/.test(c)) return { on: 'dies', who: 'attached' }
  if (/^(equipped|enchanted) creature attacks$/.test(c)) return { on: 'attacks', who: 'attached' }
  if (/^you attack$/.test(c)) return { on: 'attack' }
  if (/^~ deals combat damage to (a player|an opponent)$/.test(c)) return { on: 'combatDamage', who: 'self' }
  if (/^the beginning of combat on your turn$/.test(c)) return { on: 'step', step: 'combat' }

  const attacking = /^(?:a|an|another) (.+?) attacks$/.exec(c)
  if (attacking) {
    const filter = readFilter(attacking[1])
    if (filter) return { on: 'attacks', who: { ...filter, ...(/^another /.test(c) ? { other: true } : {}) } }
  }
  const hitting = /^(?:a|an|another) (.+?) deals combat damage to (?:a player|an opponent)$/.exec(c)
  if (hitting) {
    const filter = readFilter(hitting[1])
    if (filter) return { on: 'combatDamage', who: { ...filter, ...(/^another /.test(c) ? { other: true } : {}) } }
  }

  const entering = /^(?:a|an|another|one or more) (.+?) (?:enters|enter)(?: the battlefield)?(?: under your control)?$/.exec(c)
  if (entering) {
    const filter = readFilter(entering[1])
    if (filter) {
      const other = /^another /.test(c)
      return { on: 'enters', who: { ...filter, controller: filter.controller ?? 'you', ...(other ? { other } : {}) } }
    }
  }
  const dying = /^(?:a|an|another) (.+?) dies$/.exec(c)
  if (dying) {
    const filter = readFilter(dying[1])
    if (filter) {
      const other = /^another /.test(c)
      return { on: 'dies', who: { ...filter, ...(other ? { other } : {}) } }
    }
  }
  if (/^you gain life$/.test(c)) return { on: 'lifeGain' }
  if (/^(a player|you) plays? a land$/.test(c)) return { on: 'landPlay' }
  if (/^the beginning of your upkeep$/.test(c)) return { on: 'step', step: 'upkeep' }
  if (/^the beginning of (your|each|the) end step$/.test(c)) return { on: 'step', step: 'end' }
  const cast = /^you cast (?:a|an) (.+?) spell$/.exec(c)
  if (cast) {
    const filter = readFilter(cast[1])
    if (filter) return { on: 'cast', filter }
  }
  return null
}

/** "if you control five or more lands, …", the condition some triggers
 *  check as they trigger. */
function readCondition(text: string) {
  const m = /^if you control (\w+) or more (.+?), (.+)$/.exec(text)
  if (!m) return null
  const atLeast = readNumber(m[1])
  const filter = readFilter(m[2])
  return atLeast !== null && filter ? { condition: { atLeast, filter: { ...filter, controller: 'you' as const } }, rest: m[3] } : null
}

const cache = new Map<string, Compiled>()

export function compile(card: Card): Compiled {
  const text = card.oracle_text ?? (card.card_faces?.[0]?.oracle_text ?? '')
  // The text is in the key: two tokens of one name can be made with
  // different words.
  const key = `${card.oracle_id}|${card.name}|${text.length}`
  const known = cache.get(key)
  if (known) return known

  const lines = normalize(card, text)
  const isSpell = /\b(Instant|Sorcery)\b/.test(card.type_line ?? '')

  const triggers: TriggeredAbility[] = []
  const activated: ActivatedAbility[] = []
  let enchant: Filter | null = null
  const statics: Static[] = []
  const unread: string[] = []
  const spellParts: Ability[] = []
  /** Per line: fully understood, partly, or not at all. */
  const grades: number[] = []

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    // Ability words are flavor: "Landfall — Whenever …" reads as "Whenever …".
    const lower = line.toLowerCase().replace(/^[a-z' ]+ — (?=(when|whenever|at) )/, '')

    if (isKeywordLine(lower) || isManaAbility(lower) || isLandEntry(lower) || isFetch(lower) || isInert(lower)) {
      grades.push(1)
      continue
    }

    // "Choose one —" and the bullets after it.
    if (/^choose one —$/.test(lower) && isSpell) {
      const modes: Ability[] = []
      while (i + 1 < lines.length && lines[i + 1].startsWith('•')) {
        i += 1
        const body = lines[i].replace(/^•\s*/, '')
        modes.push({ text: body, ...readAbility(body) })
      }
      const read = modes.filter((m) => m.effects.length)
      spellParts.push({
        text: [line, ...modes.map((m) => `• ${m.text}`)].join('\n'),
        effects: read.length ? [{ op: 'mode', modes }] : [],
        complete: modes.every((m) => m.complete),
      })
      grades.push(modes.every((m) => m.complete) ? 1 : read.length ? 0.5 : 0)
      continue
    }

    const trig = /^(when|whenever|at) (.+?), (.+)$/.exec(lower)
    if (trig) {
      const events = readTrigger(trig[2])
      // "…, if you control five or more lands, …" is read; any other
      // intervening "if" is not yet.
      const conditional = readCondition(trig[3])
      const body = conditional ? conditional.rest : trig[3]
      if (events && !/^if /.test(body)) {
        const { effects, complete, once } = readAbility(body)
        for (const when of events) {
          triggers.push({
            text: line, when, effects, complete,
            ...(conditional ? { condition: conditional.condition } : {}),
            ...(once ? { oncePerTurn: true } : {}),
          })
        }
        grades.push(complete ? 1 : effects.length ? 0.5 : 0)
        continue
      }
      unread.push(line)
      grades.push(0)
      continue
    }

    const fixed = readStatic(lower)
    if (fixed) {
      statics.push(fixed)
      grades.push(1)
      continue
    }

    // "Enchant creature": what an Aura goes on as it arrives.
    const aura = /^enchant (.+)$/.exec(lower)
    if (aura) {
      enchant = readFilter(aura[1])
      grades.push(enchant ? 1 : 0)
      if (!enchant) unread.push(line)
      continue
    }

    const ability = isSpell ? null : readKeywordAbility(lower, line) ?? readActivated(line.replace(/−/g, '-'), line)
    if (ability) {
      activated.push(ability)
      grades.push(ability.complete ? 1 : ability.effects.length ? 0.5 : 0)
      continue
    }

    if (isSpell && !/^[^"]*: /.test(lower)) {
      const read = readAbility(line)
      spellParts.push({ text: line, ...read })
      grades.push(read.complete ? 1 : read.effects.length ? 0.5 : 0)
      continue
    }

    unread.push(line)
    grades.push(0)
  }

  const spell: Ability | null = isSpell && spellParts.length
    ? {
        text: spellParts.map((p) => p.text).join('\n'),
        effects: spellParts.flatMap((p) => p.effects),
        complete: spellParts.every((p) => p.complete),
      }
    : null

  const total = grades.reduce((a, b) => a + b, 0)
  const coverage: Coverage = !grades.length || total === grades.length
    ? 'auto'
    : total === 0 ? 'manual' : 'partial'

  const compiled: Compiled = { spell, triggers, activated, enchant, statics, unread, coverage }
  cache.set(key, compiled)
  return compiled
}

