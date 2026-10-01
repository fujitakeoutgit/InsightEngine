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
    expect(named('Search for Tomorrow').coverage).toBe('partial')
    expect(named('Abundance').coverage).toBe('manual')
  })

  it('treats a vanilla creature as needing nothing', () => {
    expect(compile(card('Runeclaw Bear', 'Creature — Bear')).coverage).toBe('auto')
  })
})

const text = (oracle: string, type = 'Enchantment', extra: Partial<Card> = {}) =>
  compile(card(`Test ${oracle.length} ${oracle.slice(0, 24)}`, type, { oracle_text: oracle, ...extra }))

describe('creature types', () => {
  it('reads a type it knows on its own, plural or not', () => {
    expect(readFilter('Ally you control')).toEqual({ controller: 'you', subtypes: ['Ally'] })
    expect(readFilter('Elves you control')).toEqual({ controller: 'you', subtypes: ['Elf'] })
    expect(readFilter('Zombies')).toEqual({ subtypes: ['Zombie'] })
    expect(readFilter('Eldrazi card')).toEqual({ subtypes: ['Eldrazi'] })
  })

  it('refuses a word that is not a type rather than invent one', () => {
    expect(readFilter('tapped creature')).toBeNull()
    expect(readFilter('goaded creatures')).toBeNull()
  })

  it('reads colors, and what is attacking', () => {
    expect(readFilter('blue or black creature')).toEqual({ colors: ['U', 'B'], types: ['creature'] })
    expect(readFilter('colorless creatures you control')).toEqual({ controller: 'you', colorless: true, types: ['creature'] })
    expect(readFilter('attacking creature')).toEqual({ attacking: true, types: ['creature'] })
  })

  it('refuses a type "or" a subtype, which one filter cannot say', () => {
    expect(readFilter('creature or Vehicle')).toBeNull()
  })
})

describe('what cannot happen at this table', () => {
  it('reads a trigger only the opponent could set off, and does nothing with it', () => {
    const mastermind = text('Whenever an opponent draws their second card each turn, you draw a card.')
    expect(mastermind).toMatchObject({ coverage: 'auto', triggers: [], unread: [] })
    expect(text('Whenever a land an opponent controls enters, they sacrifice it.').coverage).toBe('auto')
  })

  it('reads statics about turns and attacks the opponent never takes', () => {
    expect(text("Creatures can't attack you unless their controller pays {2} for each creature they control that's attacking you.").coverage).toBe('auto')
    expect(text("Untap all permanents you control during each other player's untap step.", 'Creature — Spirit').coverage).toBe('auto')
    expect(text("{0}: Return ~ to its owner's hand. Activate only if it's not your turn.", 'Land').coverage).toBe('auto')
  })

  it('reads any counterspell as having nothing to counter', () => {
    const denial = text('Counter target spell unless its controller pays {2}. If you control a Bird, counter that spell unless its controller pays {4} instead.', 'Instant')
    expect(denial).toMatchObject({ coverage: 'auto', spell: { complete: true, effects: [{ op: 'nothing' }] } })
    const song = text('Counter target enchantment, instant, or sorcery spell. Its controller creates a 2/2 blue Bird creature token with flying.', 'Instant')
    expect(song.spell?.effects).toEqual([{ op: 'nothing', why: 'No spell on the other side to counter' }])
  })

  it('reads taking control for good as nothing to take', () => {
    const sower = text('When ~ enters, gain control of target creature for as long as ~ remains on the battlefield.', 'Creature — Faerie')
    expect(sower).toMatchObject({ coverage: 'auto', triggers: [{ effects: [{ op: 'nothing' }] }] })
  })

  it('reads a threaten on your own creature: untapped, and hasty', () => {
    expect(readSentence('gain control of target creature until end of turn')).toEqual([
      { op: 'choose', filter: { types: ['creature'] }, count: 1, upTo: false },
    ])
    const greed = text('Gain control of target creature until end of turn. Untap that creature. It gains haste until end of turn.', 'Sorcery')
    expect(greed.spell).toMatchObject({
      complete: true,
      effects: [
        { op: 'choose' },
        { op: 'untap', what: { kind: 'chosen' } },
        { op: 'boost', to: { kind: 'chosen' }, keywords: ['Haste'] },
      ],
    })
  })

  it('counts one opponent', () => {
    expect(readSentence('for each opponent, you create a 2/1 black Villain creature token with menace')).toMatchObject([
      { op: 'token', count: 1, token: { name: 'Villain', keywords: ['Menace'] } },
    ])
  })
})

describe('small wordings', () => {
  it('means the target by "it" once something has been targeted', () => {
    const pongify = text("Destroy target creature. It can't be regenerated. Its controller creates a 3/3 green Ape creature token.", 'Instant')
    expect(pongify.spell).toMatchObject({
      complete: true,
      effects: [{ op: 'choose' }, { op: 'move', what: { kind: 'chosen' } }, { op: 'token', token: { name: 'Ape' } }],
    })
    // …and still the card itself where nothing was.
    expect(readSentence('put a +1/+1 counter on it')).toEqual([
      { op: 'counters', to: { kind: 'self' }, count: 1, counter: '+1/+1' },
    ])
  })

  it('reads "and lose 2 life" as yours', () => {
    expect(readSentence('you draw two cards and lose 2 life')).toEqual([
      { op: 'draw', count: 2 }, { op: 'life', who: 'you', sign: -1, count: 2 },
    ])
  })

  it("returns all creatures to their owners' hands", () => {
    expect(readSentence("return all creatures to their owners' hands")).toEqual([
      { op: 'move', what: { kind: 'each', filter: { types: ['creature'] } }, to: 'hand' },
    ])
  })

  it('damages each creature', () => {
    expect(readSentence('~ deals 13 damage to each creature')).toEqual([
      { op: 'damage', to: { kind: 'each', filter: { types: ['creature'] } }, count: 13 },
    ])
  })

  it('knows a legend by the name in front of "the"', () => {
    const arcanis = compile(card('Arcanis the Omnipotent', 'Legendary Creature — Wizard', {
      oracle_text: "{T}: Draw three cards.\n{2}{U}{U}: Return Arcanis to its owner's hand.",
    }))
    expect(arcanis.coverage).toBe('auto')
    expect(arcanis.activated[1].effects).toEqual([{ op: 'move', what: { kind: 'self' }, to: 'hand' }])
  })

  it('lets each player search, when you are the only one who will', () => {
    const explorer = text('When ~ dies, each player may search their library for up to two basic land cards, put them onto the battlefield, then shuffle.', 'Creature — Human')
    expect(explorer).toMatchObject({
      coverage: 'auto',
      triggers: [{ effects: [{ op: 'search', count: 2, upTo: true, to: 'battlefield', optional: true }] }],
    })
  })

  it('reads a token made by name', () => {
    expect(readSentence('create boo, a legendary 1/1 red hamster creature token with trample and haste')).toMatchObject([
      { op: 'token', count: 1, token: { name: 'Boo', pt: '1/1', typeLine: 'Token Legendary Creature — Hamster', keywords: ['Trample', 'Haste'] } },
    ])
  })

  it('sees more ways an ability is set off', () => {
    expect(text('Whenever ~ or another nontoken Phyrexian you control enters, draw a card.', 'Creature — Phyrexian').triggers.map((t) => t.when)).toEqual([
      { on: 'enters', who: 'self' },
      { on: 'enters', who: { controller: 'you', other: true, nontoken: true, subtypes: ['Phyrexian'] } },
    ])
    expect(text('Whenever a player casts a spell, you gain 1 life.').triggers[0].when).toEqual({ on: 'cast', filter: {} })
    expect(text('Whenever you cast a Villain spell, draw a card.').triggers[0].when).toEqual({ on: 'cast', filter: { subtypes: ['Villain'] } })
  })
})
