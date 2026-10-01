/**
 * What a copy is, where it is not quite what it copies: "except it's a
 * Spirit in addition to its other types", "except it isn't legendary".
 */

import type { CopyChange } from './ir'
import { readKeywords } from './read'

const title = (word: string) => word[0].toUpperCase() + word.slice(1)

/** The exceptions after "except", or null if any of them is one this cannot
 *  carry out — a copy that is nearly right is not one to hand over. */
export function readExcept(text: string): CopyChange | null {
  const change: CopyChange = {}
  // Embalm is not offered, so what holds "if ~ was embalmed" never does.
  if (/^if ~ was embalmed,/.test(text)) return change

  // What it says in quotes comes last, and may have commas of its own.
  const rest = text.replace(/(?:,? and |, )?(?:it|the token) has "(.+?)\.?"$/, (_, said: string) => {
    change.text = said
    return ''
  })
    // "…and, if it's a creature, it enters with…": a clause of its own.
    .replace(/ and, if it's a creature, /, ', ')
  const clauses = rest.split(/,? and (?=it\b|it's|the token|its|his|her|he's|she's)|, (?=it\b|it's|the token|its|his|her|he's|she's)/)
  for (const clause of clauses.map((c) => c.trim()).filter(Boolean)) {
    // "It's a 1/1 Food Golem artifact creature in addition to its other
    // types": a size as well, and "creature" is no news to a copy of one.
    const types = /^(?:it's|it is|the token is) (?:an? )?(?:(\d+\/\d+) )?(.+?) in addition to its other types$/.exec(clause)
    const arrives = /^it enters with (\w+) additional \+1\/\+1 counters? on it(?: if it's a creature)?(?: and has ([a-z, ]+))?$/.exec(clause)
    const has = /^(?:it|the token) has ([a-z, ]+)$/.exec(clause)
    const size = /^(?:the token|it) is (\d+\/\d+)$/.exec(clause)
    if (types) {
      if (types[1]) [, change.pt] = types
      change.types = [
        ...(change.types ?? []),
        ...types[2].split(/\s+and\s+|\s+/).filter((t) => t && t !== 'creature').map(title),
      ]
    } else if (arrives) {
      const count = { a: 1, an: 1, one: 1, two: 2, three: 3 }[arrives[1]]
      if (!count) return null
      change.counters = count
      if (arrives[2]) change.keywords = [...(change.keywords ?? []), ...readKeywords(arrives[2])]
    } else if (/^it has this ability$/.test(clause)) change.keepAbility = true
    // Every creature a copy could be of is yours, so "if you control it" is
    // always so.
    else if (/^it enters with a shield counter on it(?: if you control that creature)?$/.test(clause)) {
      change.enterWith = { ...change.enterWith, shield: 1 }
    }
    else if (/^(?:it|the token) isn't legendary$/.test(clause)) change.notLegendary = true
    else if (has) change.keywords = [...(change.keywords ?? []), ...readKeywords(has[1])]
    else if (size) [, change.pt] = size
    // A token's name is not something the table plays by; a permanent that
    // becomes a copy keeps the one it had.
    else if (/^(?:its|his|her) name is ~$/.test(clause)) change.keepName = true
    // "He's a legendary Human Mercenary Villain creature": its types, whatever
    // the copied card's were.
    else if (/^(?:he|she|it)'s an? (legendary )?([a-z ]+?) creature$/.test(clause)) {
      const [, legendary, subtypes] = /^(?:he|she|it)'s an? (legendary )?([a-z ]+?) creature$/.exec(clause)!
      change.typeLine = `${legendary ? 'Legendary ' : ''}Creature — ${subtypes.split(/\s+/).map(title).join(' ')}`
    }
    else if (/^it enters with an additional \+1\/\+1 counter on it if it's a creature$/.test(clause)) change.counters = 1
    else if (/^it enters with an additional loyalty counter on it if it's a planeswalker$/.test(clause)) change.loyalty = 1
    else return null
  }
  return change
}
