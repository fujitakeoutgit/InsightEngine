import { describe, expect, it } from 'vitest'

import type { Card } from '../../lib/api'
import { card } from '../testing'
import { compile } from './compile'
import corpus from './corpus.json'
import { readSentence } from './effects'
import { readFilter, readToken } from './read'

const cards = corpus as unknown as Card[]
const named = (name: string) => {
  const found = cards.find((c) => c.name === name)
  if (!found) throw new Error(`Not in the corpus: ${name}`)
  return compile(found)
}

describe('reading phrases', () => {
  it('reads filters, and refuses a word it does not know', () => {
    expect(readFilter('another nontoken creature you control')).toEqual({
      controller: 'you', other: true, nontoken: true, types: ['creature'],
    })
    expect(readFilter('basic Plains, Swamp, or Forest')).toEqual({ basic: true, subtypes: ['Plains', 'Swamp', 'Forest'] })
    expect(readFilter('artifact or enchantment')).toEqual({ types: ['artifact', 'enchantment'] })
    expect(readFilter('nonland permanent')).toEqual({ not: ['land'] })
    expect(readFilter('creature with power 2 or less')).toEqual({
      types: ['creature'], compare: { stat: 'power', op: '<=', value: 2 },
    })
    expect(readFilter('Plant creature you control')).toEqual({ controller: 'you', subtypes: ['Plant'], types: ['creature'] })
    expect(readFilter('creature that blocked this turn')).toBeNull()
  })

  it('reads tokens', () => {
    expect(readToken('1/1 green Insect creature tokens with flying and deathtouch')).toEqual({
      name: 'Insect', pt: '1/1', colors: 'G', typeLine: 'Token Creature — Insect', keywords: ['Flying', 'Deathtouch'],
    })
    expect(readToken('0/1 colorless Eldrazi Spawn creature token')).toMatchObject({ name: 'Eldrazi Spawn', colors: '' })
    expect(readToken('Treasure token')).toMatchObject({ name: 'Treasure', pt: null })
    expect(readToken("token that's a copy of that creature")).toBeNull()
  })
})

describe('reading sentences', () => {
  it('turns a target into a choice and an act on what was chosen', () => {
    expect(readSentence('destroy target artifact or enchantment')).toEqual([
      { op: 'choose', filter: { types: ['artifact', 'enchantment'] }, count: 1, upTo: false },
      { op: 'move', what: { kind: 'chosen' }, to: 'graveyard' },
    ])
  })

  it('asks once for a "you may", and hangs the rest on the answer', () => {
    expect(readSentence('you may sacrifice a land')).toEqual([
      { op: 'choose', filter: { types: ['land'], controller: 'you' }, count: 1, upTo: false, must: true, optional: true },
      { op: 'move', what: { kind: 'chosen' }, to: 'graveyard', ifDone: true },
    ])
  })

  it('does not ask about a permission', () => {
    expect(readSentence('you may play an additional land this turn')).toEqual([{ op: 'extraLand', count: 1 }])
  })

  it('reads two effects joined by "and"', () => {
    expect(readSentence('each opponent loses 2 life and you gain 2 life')).toEqual([
      { op: 'life', who: 'opponent', sign: -1, count: 2 },
      { op: 'life', who: 'you', sign: 1, count: 2 },
    ])
  })

  it('returns null for what it does not know', () => {
    expect(readSentence('each player shuffles their hand into their library')).toBeNull()
  })
})

describe('compiling cards', () => {
  it('reads Cultivate whole', () => {
    expect(named('Cultivate')).toMatchObject({
      coverage: 'auto',
      spell: { complete: true, effects: [{ op: 'search', count: 2, upTo: true, to: 'battlefield', tapped: true, restToHand: true }] },
    })
  })

  it('reads an enters trigger, under the card’s own name', () => {
    const blossoms = named('Wall of Blossoms')
    expect(blossoms.coverage).toBe('auto')
    expect(blossoms.triggers).toEqual([{
      text: 'When ~ enters, draw a card.', when: { on: 'enters', who: 'self' }, effects: [{ op: 'draw', count: 1 }], complete: true,
    }])
  })

  it('reads landfall past its ability word, and a legend by first name', () => {
    expect(named('Aesi, Tyrant of Gyre Strait')).toMatchObject({
      statics: [{ kind: 'extraLand', count: 1 }],
      triggers: [{ when: { on: 'enters', who: { types: ['land'], controller: 'you' } }, effects: [{ op: 'draw', count: 1, optional: true }] }],
    })
  })

  it('grades a card it only partly reads, and one it cannot read at all', () => {
    expect(named('Swords to Plowshares').coverage).toBe('auto')
    expect(named('Far Wanderings').coverage).toBe('partial')
    expect(named('Abundance').coverage).toBe('manual')
  })

  it('treats a vanilla creature as needing nothing', () => {
    expect(compile(card('Runeclaw Bear', 'Creature — Bear')).coverage).toBe('auto')
  })
})
