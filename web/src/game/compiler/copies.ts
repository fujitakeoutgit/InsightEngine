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
  const clauses = rest.split(/,? and (?=it\b|it's|the token|its|his|her)|, (?=it\b|it's|the token|its|his|her)/)
  for (const clause of clauses.map((c) => c.trim()).filter(Boolean)) {
    // "It's a 1/1 Food Golem artifact creature in addition to its other
    // types": a size as well, and "creature" is no news to a copy of one.
    const types = /^(?:it's|it is|the token is) an? (?:(\d+\/\d+) )?(.+?) in addition to its other types$/.exec(clause)
    const has = /^(?:it|the token) has ([a-z, ]+)$/.exec(clause)
    const size = /^(?:the token|it) is (\d+\/\d+)$/.exec(clause)
    if (types) {
      if (types[1]) [, change.pt] = types
      change.types = [...(change.types ?? []), ...types[2].split(/\s+/).filter((t) => t !== 'creature').map(title)]
    }
    else if (/^(?:it|the token) isn't legendary$/.test(clause)) change.notLegendary = true
    else if (has) change.keywords = [...(change.keywords ?? []), ...readKeywords(has[1])]
    else if (size) [, change.pt] = size
    // A name is not something the table plays by.
    else if (/^(?:its|his|her) name is ~$/.test(clause)) continue
    else if (/^it enters with an additional \+1\/\+1 counter on it if it's a creature$/.test(clause)) change.counters = 1
    else if (/^it enters with an additional loyalty counter on it if it's a planeswalker$/.test(clause)) change.loyalty = 1
    else return null
  }
  return change
}
