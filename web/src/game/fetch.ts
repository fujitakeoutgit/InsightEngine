/**
 * Fetch lands: what one can go and get.
 *
 * Read off the oracle text rather than kept as a list of card names, because
 * the list is long, it grows every set, and the text already says exactly what
 * the card can find — "search your library for a Plains or Island card" names
 * its own two types.
 */

import type { Instance } from './types'

const BASIC_TYPES = ['Plains', 'Island', 'Swamp', 'Mountain', 'Forest']

interface Text { type_line?: string | null; oracle_text?: string | null }

/** What a fetch land can find, or null if this is not one. `types` empty means
 *  it is unrestricted by subtype, which is Evolving Wilds and friends: any
 *  basic, or any land at all. */
export function fetchFinds(card: Text) {
  if (!/\bLand\b/.test(card.type_line ?? '')) return null
  const text = card.oracle_text ?? ''
  /* The whole clause, not just up to the first "card". Krosan Verge fetches
   * "a Forest card and a Plains card", and stopping at the first one offered
   * you half of what the land actually finds. Cut at the "put …"/"then …"
   * that follows, so the tail of the sentence cannot contribute type names. */
  const said = /search your library for (.+?)(?:,\s*(?:put|then)\b|\.)/i.exec(text)
  if (!said) return null
  const phrase = said[1]
  if (!/\bland\b/i.test(phrase) && !BASIC_TYPES.some((t) => new RegExp(`\\b${t}\\b`, 'i').test(phrase))) {
    return null
  }
  return {
    types: BASIC_TYPES.filter((t) => new RegExp(`\\b${t}\\b`, 'i').test(phrase)),
    basicOnly: /\bbasic\b/i.test(phrase),
    /** The fetch says so itself — Terramorphic Expanse and nearly all of its
     *  kin put what they find onto the battlefield tapped. */
    tapped: /onto the battlefield tapped/i.test(text),
    /** Cracking it costs it. Nearly always true, but Krosan Verge-style lands
     *  that tap instead exist, so it is read rather than assumed. */
    sacrifices: /\bsacrifice\b/i.test(text),
  }
}

export type Fetch = NonNullable<ReturnType<typeof fetchFinds>>

/** Is this card something the fetch is allowed to find?
 *
 * Subtypes are matched against the type line, which is where a Tundra keeps
 * its Plains and its Island — the reason a fetch finds duals at all, and the
 * reason this is not a filter on the word "basic". */
export function canFetch(fetch: Fetch, card: { type_line?: string | null }) {
  const line = card.type_line ?? ''
  if (!/\bLand\b/.test(line)) return false
  if (fetch.basicOnly && !/\bBasic\b/.test(line)) return false
  if (!fetch.types.length) return true
  return fetch.types.some((t) => new RegExp(`\\b${t}\\b`).test(line))
}

/** The card to take without asking, or null if there is a real choice.
 *
 * A fetch naming exactly one type — "search your library for a Forest card" —
 * has no decision to hand over, so a picker offering one would just be a
 * click. A basic is preferred over a dual carrying the same subtype, which is
 * what "fetch a Forest" means when you say it out loud. */
export function obviousFetch(fetch: Fetch, library: readonly Instance[]): Instance | null {
  if (fetch.types.length !== 1) return null
  const options = library.filter((c) => canFetch(fetch, c.card))
  if (!options.length) return null
  const basic = (c: Instance) => Number(/\bBasic\b/.test(c.card.type_line ?? ''))
  return [...options].sort((a, b) => basic(b) - basic(a))[0]
}
