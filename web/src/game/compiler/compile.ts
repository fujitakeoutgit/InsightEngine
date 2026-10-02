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
import { FREE, readActivated, readKeywordAbility } from './activated'
import { readAbility, sentences } from './effects'
import type {
  Ability, ActivatedAbility, Aim, Compiled, Coverage, Effect, Filter, Static, Test, TriggerEvent,
  TriggeredAbility, Way,
} from './ir'
import { readFilter, readNumber, readTest } from './read'
import { isInert, readCostLess, readStatic } from './statics'

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
  // A storage land's: counters taken off for that much mana.
  || /^\{t\}, remove x [a-z]+ counters from ~: add x mana in any combination of (colors|\{[wubrg]\} and\/or \{[wubrg]\})\b/.test(line)
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
      // …and "Arcanis" for Arcanis the Omnipotent, "Moritte" for Moritte
      // of the Frost.
      const epithet = /^(\w{3,}) (?:of the|the|of) \w/.exec(part)
      if (epithet && /\bLegendary\b/.test(card.type_line ?? '')) names.add(epithet[1])
    }
  }
  let out = text.replace(/\([^)]*\)/g, '')
  for (const name of [...names].sort((a, b) => b.length - a.length)) {
    out = out.split(name).join('~')
  }
  out = out.replace(/\bthis (creature|land|artifact|enchantment|permanent|planeswalker|token|equipment|vehicle|spell|card|class|aura|saga)\b/gi, '~')
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
  // "…enters from a graveyard": the same arrivals, from there only.
  const buried = /^(.+ enters?) from (?:a|your) graveyard$/.exec(condition.trim())
  if (buried) {
    const events = readTrigger(buried[1])
    return events && events.map((when) => (when.on === 'enters' ? { ...when, from: 'graveyard' as const } : when))
  }
  if (/^one or more cards leave your graveyard$/.test(condition.trim())) return [{ on: 'leavesGraveyard' }]
  const commander = /^your commander (enters|attacks|enters or attacks)$/.exec(condition.trim())
  if (commander) {
    const who = { commander: true, controller: 'you' as const }
    return [
      ...(/enters/.test(commander[1]) ? [{ on: 'enters' as const, who }] : []),
      ...(/attacks/.test(commander[1]) ? [{ on: 'attacks' as const, who }] : []),
    ]
  }
  // "When ~ enters and at the beginning of your upkeep".
  const also = /^(.+?) and at (the beginning of .+)$/.exec(condition.trim())
  if (also) {
    const first = readOneTrigger(also[1])
    const second = readOneTrigger(also[2])
    if (first && second) return [first, second]
  }
  // "Whenever ~ or another nontoken Phyrexian you control enters": itself,
  // and the others.
  const orAnother = /^~ or (another .+? (?:enters|dies))$/.exec(condition.trim())
  if (orAnother) {
    const others = readOneTrigger(orAnother[1])
    const own = readOneTrigger(`~ ${orAnother[1].split(' ').pop()}`)
    if (others && own) return [own, others]
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

const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII']

const ORDINALS = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth']

function readOneTrigger(condition: string): TriggerEvent | null {
  const c = condition.trim()
  if (/^~ (enters|enters the battlefield)$/.test(c)) return { on: 'enters', who: 'self' }
  if (/^~ dies$/.test(c)) return { on: 'dies', who: 'self' }
  if (/^~ attacks$/.test(c)) return { on: 'attacks', who: 'self' }
  if (/^(equipped|enchanted) creature dies$/.test(c)) return { on: 'dies', who: 'attached' }
  if (/^(equipped|enchanted) creature attacks$/.test(c)) return { on: 'attacks', who: 'attached' }
  if (/^(equipped|enchanted) creature deals combat damage to (a player|an opponent)$/.test(c)) {
    return { on: 'combatDamage', who: 'attached' }
  }
  if (/^you attack$/.test(c)) return { on: 'attack' }
  if (/^~ deals combat damage to (a player|an opponent)$/.test(c)) return { on: 'combatDamage', who: 'self' }
  if (/^you draw a card$/.test(c)) return { on: 'draw' }
  const nth = /^you draw your (second|third) card each turn$/.exec(c)
  if (nth) return { on: 'draw', nth: nth[1] === 'second' ? 2 : 3 }
  // Cycling a card is discarding it, so "cycle or discard" is one thing.
  if (/^you (?:cycle or )?discard (?:a|another) card$/.test(c)) return { on: 'discard' }
  const discarding = /^you discard one or more (.+?) cards?$/.exec(c)
  if (discarding) {
    const filter = readFilter(discarding[1])
    if (filter) return { on: 'discard', filter }
  }
  const tapping = /^~ becomes? (tapped|untapped)$/.exec(c)
  if (tapping) return { on: tapping[1] as 'tapped' | 'untapped', who: 'self' }
  if (/^you (scry|surveil|scry or surveil)$/.test(c)) return { on: 'scry' }
  if (/^~ connives$/.test(c)) return { on: 'connives', who: 'self' }
  if (/^~ is dealt damage$/.test(c)) return { on: 'damaged', who: 'self' }
  const level = /^~ becomes level (\d+)$/.exec(c)
  if (level) return { on: 'level', level: Number(level[1]) }
  const counter = /^the (\w+) ([+-]\d\/[+-]\d|[a-z]+) counter is put on ~$/.exec(c)
  if (counter && ORDINALS.includes(counter[1])) {
    return { on: 'counters', counter: counter[2], count: ORDINALS.indexOf(counter[1]) + 1 }
  }
  const leaving = /^(?:a|an|another) (.+?) leaves the battlefield$/.exec(c)
  if (leaving) {
    const filter = readFilter(leaving[1])
    if (filter) return { on: 'leaves', who: { ...filter, ...(/^another /.test(c) ? { other: true } : {}) } }
  }
  if (/^~ becomes attached to a creature$/.test(c)) return { on: 'attached' }
  const targeting = /^you cast a spell that targets (?:an?|one or more) (.+)$/.exec(c)
  if (targeting) {
    const filter = readFilter(targeting[1])
    if (filter) return { on: 'targets', filter }
  }
  const milled = /^one or more (.+?) cards are put into your graveyard from your library$/.exec(c)
  if (milled) {
    const filter = readFilter(milled[1])
    if (filter) return { on: 'milled', filter }
  }
  if (/^a card is put into your graveyard from anywhere$/.test(c)) return { on: 'buried' }
  // Dying, said the long way.
  const buried = /^(?:a|an|another) (.+?) is put into (?:your|a) graveyard from the battlefield$/.exec(c)
  if (buried) {
    const filter = readFilter(buried[1])
    if (filter) return { on: 'dies', who: { ...filter, ...(/^another /.test(c) ? { other: true } : {}) } }
  }
  const conniving = /^(?:a|an|another) (.+?) connives$/.exec(c)
  if (conniving) {
    const filter = readFilter(conniving[1])
    if (filter) return { on: 'connives', who: { ...filter, ...(/^another /.test(c) ? { other: true } : {}) } }
  }
  if (/^the beginning of combat on your turn$/.test(c)) return { on: 'step', step: 'combat' }

  const attacking = /^(?:a|an|another) (.+?) attacks$/.exec(c)
  if (attacking) {
    const filter = readFilter(attacking[1])
    if (filter) return { on: 'attacks', who: { ...filter, ...(/^another /.test(c) ? { other: true } : {}) } }
  }
  const hitting = /^(?:a|an|another|one or more) (.+?) deals? combat damage to (?:a player|an opponent)$/.exec(c)
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
  // Yours is the only upkeep there is.
  if (/^the beginning of (your|each) upkeep$/.test(c)) return { on: 'step', step: 'upkeep' }
  if (/^the beginning of your (first|precombat) main phase$/.test(c)) return { on: 'step', step: 'main' }
  if (/^the beginning of (your|each|the) end step$/.test(c)) return { on: 'step', step: 'end' }
  if (/^the beginning of each of your postcombat main phases$/.test(c)) return { on: 'step', step: 'main2' }
  // Nobody else casts anything: "a player" is you.
  if (/^(?:you|a player) casts? a spell$/.test(c)) return { on: 'cast', filter: {} }
  if (/^you cast a spell of the chosen type$/.test(c)) return { on: 'cast', filter: { chosenType: true } }
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
  const m = /^if (.+?), (.+)$/.exec(text)
  const condition = m && readTest(m[1])
  return m && condition ? { condition, rest: m[2] } : null
}

/** Ways to cast a card, or to pay for it, that the table does not offer.
 *  The card is cast as printed and plays the same; these are set aside. */
const NOT_OFFERED = [
  /^(mayhem|encore|evoke|freerunning|kicker|multikicker|overload|unearth|embalm|eternalize|plot|suspend|mutate|flashback|escape|foretell|madness|buyback|bestow|dash|blitz|disturb|emerge|spectacle|surge|prowl|morph|megamorph|disguise|ninjutsu|entwine|replicate|retrace|jump-start|miracle|harmonize|warp|impending|offspring|squad|casualty|cleave|bargain|spree|web-slinging)\b/,
  /^(convoke|delve|improvise)$/,
  /^affinity for /,
  /^you may .+ rather than pay (?:~'s|this spell's) mana cost\.?$/,
  /^as an additional cost to cast (?:~|this spell), you may /,
]

/** A way to cast the card other than for what it costs: evoke, kicker,
 *  mayhem, a cost paid in cards. Null for a line that is not one, or is one
 *  in a form this does not carry out — which `NOT_OFFERED` then sets aside. */
function readWay(line: string, printed: string): Way | null {
  const priced = /^(evoke|kicker|freerunning|mayhem|overload) ((?:\{[^}]+\})+)$/.exec(line)
  if (priced) {
    return { kind: priced[1] as 'evoke' | 'kicker' | 'freerunning' | 'mayhem' | 'overload', cost: priced[2].toUpperCase() }
  }
  const pitch = /^you may exile (\w+) (.+?) cards from your hand rather than pay (?:~'s|this spell's) mana cost\.?$/.exec(line)
  if (pitch) {
    const count = readNumber(pitch[1])
    const filter = readFilter(pitch[2])
    return count !== null && filter ? { kind: 'pitch', filter, count, text: printed.replace(/\.$/, '') } : null
  }
  const behold = /^as an additional cost to cast (?:~|this spell), you may (behold an? (.+?))\.?$/.exec(line)
  if (behold) {
    const filter = readFilter(behold[2])
    return filter && { kind: 'behold', filter, text: behold[1][0].toUpperCase() + behold[1].slice(1) }
  }
  return null
}

/** A Class's "{2}{G}: Level 2". */
const LEVEL = /^(?:\{[^}]+\})+: level \d+$/

interface Choice {
  head: string
  min: number
  max: number
  more?: { test: Test; max: number }
  fresh?: boolean
  random?: { unless: Test }
}

/** "Choose one —", "choose up to one —", "choose one or more —": how few and
 *  how many of the bullets under it, or null if the line does not end so. */
function readChoice(line: string, modes: number): Choice | null {
  // The Will cycle: one, or both with a commander of yours about.
  if (/^choose one\. if you control a commander as you cast (?:~|this spell), you may choose both instead\.$/i.test(line)) {
    return {
      head: '', min: 1, max: 1,
      more: { test: { control: { commander: true, controller: 'you' }, atLeast: 1 }, max: 2 },
    }
  }
  // Typhoid Mary: one at random, unless something lets you choose.
  const random = /^(.*?)\bchoose one at random\. if (.+?), you choose one instead\.$/i.exec(line)
  const unless = random && readTest(random[2])
  if (random) return unless ? { head: random[1], min: 1, max: 1, random: { unless } } : null
  // Monument to Endurance: each mode once a turn.
  const fresh = /^(.*?)\bchoose one that hasn't been chosen this turn —$/i.exec(line)
  if (fresh) return { head: fresh[1], min: 1, max: 1, fresh: true }
  const m = /^(.*?)\bchoose (one|two|up to one|up to two|one or more|one or both) —$/i.exec(line)
  if (!m) return null
  const [min, max] = {
    one: [1, 1], two: [2, 2], 'up to one': [0, 1], 'up to two': [0, 2],
    'one or more': [1, modes], 'one or both': [1, 2],
  }[m[2].toLowerCase()] as [number, number]
  return { head: m[1], min, max }
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
  /** It may be cast whenever an instant could. */
  const fast = /\bInstant\b/.test(card.type_line ?? '') || (card.keywords ?? []).some((k) => k.toLowerCase() === 'flash')
  const ways: Way[] = []

  const triggers: TriggeredAbility[] = []
  const activated: ActivatedAbility[] = []
  let enchant: Filter | null = null
  const statics: Static[] = []
  const unread: string[] = []
  const skipped: string[] = []
  const spellParts: Ability[] = []
  /** Per line: fully understood, partly, or not at all. */
  const grades: number[] = []
  /** A Class: how much had been read when its next level's line was met.
   *  What is under that line is read for the grade and is not yet had. */
  let reached: { triggers: number; activated: number; statics: number; unread: number } | null = null
  /** A Saga's last chapter. */
  let sagaLast = 0
  /** The overload line as printed, in case it has to be set aside. */
  let overloadLine = ''
  /** The lines that belong to one side of a Siege, and which. */
  const sideAt = new Map<number, string>()

  for (let i = 0; i < lines.length; i += 1) {
    // "As ~ enters, choose Khans or Dragons", and a line under it for each:
    // those are read as the card's own, each marked with its side.
    const sides = /^As ~ enters, choose ([A-Z][a-z]+) or ([A-Z][a-z]+)\.?$/.exec(lines[i])
    if (sides && [sides[1], sides[2]].every((name, n) => lines[i + 1 + n]?.startsWith(`• ${name} — `))) {
      for (const [n, name] of [sides[1], sides[2]].entries()) {
        lines[i + 1 + n] = lines[i + 1 + n].slice(`• ${name} — `.length)
        sideAt.set(i + 1 + n, name)
      }
      statics.push({ kind: 'chooseSide', sides: [sides[1], sides[2]] })
      grades.push(1)
      continue
    }
    const side = sideAt.get(i)
    const printed = lines[i]
    // A Saga's chapters: "I, II — Draw a card." Each is told as the lore
    // counter that numbers it is put on.
    const chapter = /\bSaga\b/.test(card.type_line ?? '') ? /^([IVX]+(?:, [IVX]+)*) — (.+)$/.exec(printed) : null
    if (chapter) {
      const told = readAbility(chapter[2])
      for (const numeral of chapter[1].split(', ')) {
        const count = ROMAN.indexOf(numeral) + 1
        sagaLast = Math.max(sagaLast, count)
        triggers.push({
          text: printed, when: { on: 'counters', counter: 'lore', count }, effects: told.effects, complete: told.complete,
        })
      }
      grades.push(told.complete ? 1 : told.effects.length ? 0.5 : 0)
      continue
    }
    // A Background: `Commander creatures you own have "…"`. The ability is
    // read as this card's own, for as long as a commander of yours is there
    // to have it.
    const granted = /^commander creatures you own have "(.+?)\.?"$/i.exec(printed)
    const having: Test | null = granted
      ? { control: { types: ['creature'], commander: true, controller: 'you' }, atLeast: 1 }
      : null
    // "All Slivers have "When ~ enters, …"": every Sliver arriving does it,
    // which is this card watching for Slivers.
    const tribal = /^all (\w+?)s have "when ~ enters, (.+?)\.?"$/i.exec(printed)
    const line = granted ? `${granted[1]}.`
      : tribal ? `Whenever a ${tribal[1]} you control enters, ${tribal[2]}.`
        : printed
    // Ability words are flavor: "Landfall — Whenever …" reads as "Whenever …".
    const lower = line.toLowerCase().replace(/^[a-z' ]+ — (?=(when|whenever|at) )/, '')

    if (isKeywordLine(lower) || isManaAbility(lower) || isLandEntry(lower) || isFetch(lower) || isInert(lower)) {
      grades.push(1)
      continue
    }
    // Another way to cast it, offered as it is cast.
    const way = readWay(lower, printed)
    if (way) {
      ways.push(way)
      if (way.kind === 'overload') overloadLine = printed
      grades.push(1)
      continue
    }
    if (lower === 'convoke') {
      statics.push({ kind: 'convoke' })
      grades.push(1)
      continue
    }
    // "Affinity for Slivers": one less for each you control.
    const affinity = /^affinity for (.+)$/.exec(lower)
    const counted = affinity && readFilter(affinity[1])
    if (counted) {
      statics.push({ kind: 'selfCostLess', amount: 1, per: { ...counted, controller: 'you' } })
      grades.push(1)
      continue
    }
    // Keywords that are abilities in shorthand — of a card in hand or in the
    // graveyard as much as of a permanent: unearth, plot, suspend, cycling.
    const keyworded = readKeywordAbility(lower, line, !fast)
    if (keyworded) {
      activated.push(keyworded)
      grades.push(1)
      continue
    }
    if (NOT_OFFERED.some((pattern) => pattern.test(lower))) {
      skipped.push(printed)
      grades.push(1)
      continue
    }
    // Persist and undying: back once, with a counter that says it has been.
    if (lower === 'persist' || lower === 'undying') {
      const counter = lower === 'persist' ? '-1/-1' : '+1/+1'
      triggers.push({
        text: printed, when: { on: 'dies', who: 'self' }, complete: true,
        condition: { not: { counters: counter, of: 'self', atLeast: 1 } },
        effects: [{ op: 'revive', counter }],
      })
      grades.push(1)
      continue
    }
    // For Mirrodin! and living weapon: a token to carry it, as it arrives.
    if (lower === 'for mirrodin!' || lower === 'living weapon') {
      const rebel = lower === 'for mirrodin!'
      triggers.push({
        text: printed, when: { on: 'enters', who: 'self' }, complete: true,
        effects: [{
          op: 'token', count: 1, tapped: false, equip: true,
          token: rebel
            ? { name: 'Rebel', pt: '2/2', colors: 'R', typeLine: 'Token Creature — Rebel', keywords: [] }
            : { name: 'Phyrexian Germ', pt: '0/0', colors: 'B', typeLine: 'Token Creature — Phyrexian Germ', keywords: [] },
        }],
      })
      grades.push(1)
      continue
    }
    // Melee: +1/+1 for each opponent attacked — and there is one.
    if (lower === 'melee') {
      triggers.push({
        text: printed, when: { on: 'attacks', who: 'self' }, complete: true,
        effects: [{ op: 'boost', to: { kind: 'self' }, power: 1, toughness: 1, keywords: [] }],
      })
      grades.push(1)
      continue
    }
    if (LEVEL.test(lower)) {
      // The next level is an ability, gained as a sorcery; the ones after it
      // wait their turn.
      const up = reached ? null : readActivated(line, printed, { effects: [{ op: 'levelUp' }], complete: true })
      if (up) {
        activated.push({ ...up, sorcery: true })
        reached = { triggers: triggers.length, activated: activated.length, statics: statics.length, unread: unread.length }
      }
      grades.push(1)
      continue
    }

    // "Choose up to five {P} worth of modes", and under it each mode with
    // what it costs: taken as often as they can be paid for.
    const paws = /^choose up to (\w+) \{p\} worth of modes\. you may choose the same mode more than once\.$/.exec(lower)
    const most = paws && readNumber(paws[1])
    if (paws && most !== null) {
      const priced: { cost: number; mode: Ability }[] = []
      for (let under = /^((?:\{P\})+) — (.+)$/.exec(lines[i + 1 + priced.length] ?? ''); under; under = /^((?:\{P\})+) — (.+)$/.exec(lines[i + 1 + priced.length] ?? '')) {
        priced.push({ cost: under[1].length / 3, mode: { text: under[0], ...readAbility(under[2]) } })
      }
      i += priced.length
      const whole = [printed, ...priced.map((p) => p.mode.text)].join('\n')
      const read = priced.some((p) => p.mode.effects.length)
      const complete = priced.length > 0 && priced.every((p) => p.mode.complete)
      if (isSpell && read) {
        spellParts.push({
          text: whole, complete,
          effects: [{
            op: 'mode', modes: priced.map((p) => p.mode), min: 0, max: 99,
            budget: { max: most as number, costs: priced.map((p) => p.cost) },
          }],
        })
      } else unread.push(whole)
      grades.push(!isSpell || !read ? 0 : complete ? 1 : 0.5)
      continue
    }

    // "Choose one —" and the bullets after it: on a spell, at the end of a
    // trigger, or after an activated ability's cost.
    let bullets = 0
    while (lines[i + 1 + bullets]?.startsWith('•')) bullets += 1
    const choice = bullets ? readChoice(line, bullets) : null
    let modal: { effects: Effect[]; complete: boolean; text: string } | null = null
    if (choice) {
      const modes: Ability[] = lines.slice(i + 1, i + 1 + bullets).map((bullet) => {
        const shown = bullet.replace(/^•\s*/, '')
        // A mode may have a name: "Sell Contraband — Create a Treasure".
        const { effects, complete } = readAbility(shown.replace(/^[A-Z~][\w' ]* — /, ''))
        return { text: shown, effects, complete }
      })
      i += bullets
      const read = modes.some((m) => m.effects.length)
      modal = {
        text: [line, ...modes.map((m) => `• ${m.text}`)].join('\n'),
        effects: read
          ? [{
              op: 'mode', modes, min: choice.min, max: choice.max,
              ...(choice.more ? { more: choice.more } : {}),
              ...(choice.fresh ? { fresh: true } : {}),
              ...(choice.random ? { random: choice.random } : {}),
            }]
          : [],
        complete: modes.every((m) => m.complete),
      }
      if (!choice.head.trim()) {
        // On its own line: the spell itself. A permanent's is not read yet.
        if (isSpell) spellParts.push(modal)
        else unread.push(modal.text)
        grades.push(!isSpell ? 0 : modal.complete ? 1 : read ? 0.5 : 0)
        continue
      }
    }
    /** What this line does, read — or, for a modal one, the choice. */
    const reading = (body: string, about: Aim | null) => (modal ? { ...modal, once: false } : readAbility(body, about))
    const shown = modal ? modal.text : printed
    const headed = choice ? choice.head.trim().toLowerCase() : null

    // A spell's own discount, which may run to two sentences.
    if (/^~ costs \{\d+\} less to cast\b/.test(lower)) {
      // "This effect can't reduce the amount of mana ~ costs by more than
      // {5}" is a cap on the discount before it, not one of its own.
      const cap = /this effect can't reduce the amount of mana ~ costs by more than \{(\d+)\}/.exec(lower)
      const read = sentences(lower)
        .filter((sentence) => !/^this effect can't reduce\b/.test(sentence))
        .map((sentence) => readCostLess(sentence))
        .map((fixed) => (fixed?.kind === 'selfCostLess' && cap ? { ...fixed, max: Number(cap[1]) } : fixed))
      if (read.every((fixed): fixed is Static => fixed !== null)) statics.push(...read)
      else unread.push(printed)
      grades.push(read.every(Boolean) ? 1 : 0)
      continue
    }

    // A static that is worded like a trigger.
    const early = !side && /^(at the beginning of each player's draw step|whenever you tap an? .+ for (mana|\{c\}), add|whenever enchanted land is tapped for mana)\b/.test(lower)
      ? readStatic(lower)
      : null
    if (early) {
      statics.push(early)
      grades.push(1)
      continue
    }

    // "Your first instant, sorcery, or Villain spell each turn" has commas
    // of its own, before the one that ends the condition.
    const trig = (headed === null ? /^(whenever) (you cast your first .+? spell each turn), (.+)$/.exec(lower) : null)
      ?? /^(when|whenever|at) (.+?), (.+)$/.exec(headed !== null ? `${headed} …` : lower)
    if (trig) {
      // "Your first instant spell each turn" is an instant spell, once.
      const first = /^you cast your first (.+?) spell each turn$/.exec(trig[2])
      const events = readTrigger(first ? `you cast a ${first[1]} spell` : trig[2])
      // "…, if you control five or more lands, …": checked as it triggers.
      // An "if" this cannot check leaves the line in words.
      const conditional = readCondition(trig[3])
      const body = conditional ? conditional.rest : trig[3]
      if (events && !/^if /.test(body)) {
        // In an ability about another card — "whenever a creature you
        // control enters" — "it" is that card.
        // …and so it is in one about a card going somewhere: discarded,
        // milled, put into the graveyard.
        // A spell being cast is "it" only where the words are plainly
        // about the spell: most cast triggers say "it" of themselves.
        const about: Aim | null = events.some((when) => (
          ('who' in when && when.who !== 'self') || when.on === 'discard' || when.on === 'milled' || when.on === 'buried'
          || when.on === 'attached'
          || (when.on === 'cast' && /^exile it\b|\bthat spell\b/.test(body))
        )) ? { kind: 'event' } : null
        const { effects, complete, once } = reading(body, about)
        const conditions = [having, conditional?.condition].filter((test): test is Test => Boolean(test))
        for (const when of events) {
          triggers.push({
            text: shown, when, effects, complete,
            ...(conditions.length ? { condition: conditions.length > 1 ? { all: conditions } : conditions[0] } : {}),
            ...(once || first ? { oncePerTurn: true } : {}),
            // Milled cards each answer for themselves: "put them onto the
            // battlefield" is each of them.
            // …and a spell with two targets is still one spell.
            ...((/\bone or more\b/.test(trig[2]) && when.on !== 'milled') || when.on === 'targets' ? { batch: true } : {}),
            ...(side ? { side } : {}),
            // What returns itself from the graveyard works from there.
            ...(/\breturn ~ from your graveyard\b/.test(body) ? { from: 'graveyard' as const } : {}),
          })
        }
        grades.push(complete ? 1 : effects.length ? 0.5 : 0)
        continue
      }
      unread.push(shown)
      grades.push(0)
      continue
    }
    // Anything else given to a commander is not something this reads — nor
    // is a side's line that is not a trigger.
    if (having || side) {
      unread.push(printed)
      grades.push(0)
      continue
    }

    const fixed = modal ? null : readStatic(lower)
    if (fixed) {
      // Abundance's standing choice can be made again whenever you like.
      if (fixed.kind === 'drawsFind') {
        activated.push({
          text: 'Choose again what your draws look for.', cost: { ...FREE },
          sorcery: false, oncePerTurn: false, fromHand: false, mana: null,
          effects: [{ op: 'rechoose' }], complete: true,
        })
      }
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

    const ability = isSpell ? null
      : modal ? readActivated(`${choice!.head.trim()} …`, shown, modal)
        : readKeywordAbility(lower, line) ?? readActivated(line.replace(/−/g, '-'), line)
    if (ability) {
      activated.push(ability)
      grades.push(ability.complete ? 1 : ability.effects.length ? 0.5 : 0)
      continue
    }
    // An ability whose cost this cannot pay, but which could only ever do
    // nothing at this table: understood, and not offered.
    const colon = isSpell || modal ? -1 : line.indexOf(': ')
    if (colon > 0 && !/"/.test(line.slice(0, colon))) {
      const does = readAbility(line.slice(colon + 2))
      if (does.complete && does.effects.length && does.effects.every((effect) => effect.op === 'nothing')) {
        grades.push(1)
        continue
      }
    }

    if (isSpell && !/^[^"]*: /.test(lower)) {
      // An ability word is flavor here too: "Threshold — If there are…".
      const said = line.replace(/^[A-Z][a-z' ]* — (?=\S)/, '')
      // "…, instead search for up to three" replaces the line before it, so
      // the two are read as one.
      const before = /\binstead\b/i.test(said) || /^if /i.test(said) ? spellParts.pop() : undefined
      if (before) grades.pop()
      const whole = before ? `${before.text} ${said}` : said
      const read = readAbility(whole)
      spellParts.push({ text: before ? `${before.text}\n${line}` : line, ...read })
      grades.push(read.complete ? 1 : read.effects.length ? 0.5 : 0)
      continue
    }

    unread.push(shown)
    grades.push(0)
  }

  if (sagaLast) statics.push({ kind: 'saga', last: sagaLast })
  // A clone that is embalmed: the token is a copy of what the card would
  // have entered as a copy of, a Zombie as well.
  const clone = statics.find((fixed) => fixed.kind === 'enterAsCopy')
  if (clone?.kind === 'enterAsCopy') {
    for (const ability of activated) {
      const [made] = ability.effects
      if (!/^embalm\b/i.test(ability.text) || made?.op !== 'copy') continue
      ability.effects = [
        { op: 'choose', filter: clone.filter, count: 1, upTo: true },
        { ...made, of: { kind: 'chosen' }, change: { ...clone.change, ...made.change, types: [...(clone.change.types ?? []), 'Zombie'] } },
      ]
    }
  }
  if (reached) {
    triggers.length = reached.triggers
    activated.length = reached.activated
    statics.length = reached.statics
    unread.length = reached.unread
  }

  const spell: Ability | null = isSpell && spellParts.length
    ? {
        text: spellParts.map((p) => p.text).join('\n'),
        effects: spellParts.flatMap((p) => p.effects),
        complete: spellParts.every((p) => p.complete),
      }
    : null

  // Overload: the same words with "each" for "target", if they read that
  // way too. If they do not, it is one more way that is not offered.
  let overloaded: Ability | undefined
  const overload = ways.findIndex((way) => way.kind === 'overload')
  if (overload >= 0) {
    const each = isSpell ? spellParts.map((part) => readAbility(part.text.replace(/\btarget\b/gi, 'each'))) : []
    if (spell && each.length && each.every((part) => part.complete)) {
      overloaded = { text: spell.text.replace(/\btarget\b/gi, 'each'), effects: each.flatMap((part) => part.effects), complete: true }
    } else {
      ways.splice(overload, 1)
      skipped.push(overloadLine)
    }
  }

  const total = grades.reduce((a, b) => a + b, 0)
  const coverage: Coverage = !grades.length || total === grades.length
    ? 'auto'
    : total === 0 ? 'manual' : 'partial'

  const compiled: Compiled = {
    spell, triggers, activated, enchant, statics, unread, ways, skipped, coverage,
    ...(overloaded ? { overloaded } : {}),
  }
  cache.set(key, compiled)
  return compiled
}

