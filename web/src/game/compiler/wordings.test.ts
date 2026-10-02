import { describe, expect, it } from 'vitest'

import type { Card } from '../../lib/api'
import { card } from '../testing'
import { compile } from './compile'
import { readAbility, readSentence } from './effects'
import { readFilter, readTest } from './read'

const text = (oracle: string, type = 'Enchantment', extra: Partial<Card> = {}) =>
  compile(card(`Wording ${oracle.length} ${oracle.slice(0, 30)}`, type, { oracle_text: oracle, ...extra }))

describe('ways to cast a card', () => {
  it('reads the ones it offers, and grades the card by the rest', () => {
    const mulldrifter = text('Flying\nWhen ~ enters, draw two cards.\nEvoke {2}{U}', 'Creature — Elemental')
    expect(mulldrifter).toMatchObject({ coverage: 'auto', unread: [], skipped: [], ways: [{ kind: 'evoke', cost: '{2}{U}' }] })
    const vision = text('Freerunning {1}{U}\nDraw three cards.', 'Sorcery')
    expect(vision).toMatchObject({ coverage: 'auto', ways: [{ kind: 'freerunning', cost: '{1}{U}' }], spell: { complete: true } })
    expect(text("You may exile two green cards from your hand rather than pay ~'s mana cost.\nTrample", 'Creature — Elf'))
      .toMatchObject({ coverage: 'auto', ways: [{ kind: 'pitch', count: 2, filter: { colors: ['G'] } }] })
    const search = text('Search your library for a basic land card, put it onto the battlefield, then shuffle.\nSuspend 2—{G}', 'Sorcery')
    expect(search).toMatchObject({ skipped: [], activated: [{ fromHand: true, cost: { mana: '{G}', exileSelf: true } }] })
  })

  it('sets aside the ones it does not, and still grades the card by the rest', () => {
    const beast = text('Mutate {G}{U}\n{1}, {T}: Draw a card.', 'Creature — Beast')
    expect(beast).toMatchObject({ coverage: 'auto', skipped: ['Mutate {G}{U}'], ways: [] })
    // Overload is offered where the spell reads with "each" for "target".
    expect(text('Destroy target artifact you don\'t control.\nOverload {4}{R}', 'Sorcery'))
      .toMatchObject({ skipped: [], ways: [{ kind: 'overload', cost: '{4}{R}' }] })
    // A kicker paid in something other than mana is not one this offers.
    expect(text('Kicker—Sacrifice a creature.\nDraw a card.', 'Sorcery').skipped).toEqual(['Kicker—Sacrifice a creature.'])
  })

  it('does not set aside a keyword that does something on its own', () => {
    expect(text('Echo {1}{R}\nWhen ~ enters, draw a card.', 'Creature — Goblin').skipped).toEqual([])
    expect(text('Cumulative upkeep {1}').statics).toEqual([{ kind: 'cumulativeUpkeep', cost: '{1}' }])
    // …and one paid in something other than mana is still yours to pay.
    expect(text('Cumulative upkeep—Pay 2 life.').coverage).toBe('manual')
  })

  it('sets aside a cost that may be added and is not', () => {
    const exhale = text('As an additional cost to cast this spell, you may behold a Dragon.\nCounter target spell unless its controller pays {2}. If a Dragon was beheld, counter that spell unless its controller pays {4} instead.', 'Instant')
    expect(exhale.coverage).toBe('auto')
  })
})

describe('filters', () => {
  it('reads two types with no "or" between them as both', () => {
    expect(readFilter('artifact creature')).toEqual({ types: ['creature'], also: ['artifact'] })
    expect(readFilter('artifact or creature')).toEqual({ types: ['artifact', 'creature'] })
    expect(readFilter('noncreature artifact')).toEqual({ not: ['creature'], types: ['artifact'] })
  })

  it('reads a type "or" a subtype as either', () => {
    expect(readFilter('creature or Vehicle')).toEqual({ either: [{ types: ['creature'] }, { subtypes: ['Vehicle'] }] })
  })

  it('reads who is left out', () => {
    expect(readSentence('destroy all creatures and planeswalkers except for commanders')).toEqual([
      { op: 'move', what: { kind: 'each', filter: { types: ['creature', 'planeswalker'], commander: false } }, to: 'graveyard' },
    ])
    expect(readSentence("return all creatures to their owners' hands except for krakens, leviathans, octopuses, and serpents")).toEqual([
      { op: 'move', what: { kind: 'each', filter: { types: ['creature'], notSubtypes: ['Kraken', 'Leviathan', 'Octopus', 'Serpent'] } }, to: 'hand' },
    ])
  })

  it('reads "named" as the card\'s own name', () => {
    const ritualist = text('Whenever another creature you control named ~ enters, draw a card.', 'Creature — Shapeshifter')
    expect(ritualist.triggers[0].when).toEqual({ on: 'enters', who: { controller: 'you', other: true, sameName: true, types: ['creature'] } })
  })

  it('reads an amount to compare against', () => {
    expect(readSentence("return to their owners' hands all creatures with toughness less than or equal to the number of islands you control")).toMatchObject([
      { op: 'move', to: 'hand', what: { kind: 'each', filter: { compare: { stat: 'toughness', op: '<=', value: { per: { subtypes: ['Island'] } } } } } },
    ])
  })
})

describe('sentences', () => {
  it('reads a plain "if" as doing it or not', () => {
    expect(readAbility("Return a land you control to its owner's hand. If another Desert was returned this way, surveil 1.")).toMatchObject({
      complete: true,
      effects: [
        { op: 'choose', must: true }, { op: 'move', to: 'hand' },
        { op: 'if', test: { is: { subtypes: ['Desert'], other: true }, of: 'chosen' }, then: [{ op: 'surveil', count: 1 }], otherwise: [] },
      ],
    })
  })

  it('reads what a spell goes on to say about lands it dug up', () => {
    const awakening = text('Reveal the top X cards of your library. Put all land cards from among them onto the battlefield tapped and the rest on the bottom of your library in a random order.\nSpell mastery — If there are two or more instant and/or sorcery cards in your graveyard, untap those lands.', 'Sorcery')
    expect(awakening).toMatchObject({ coverage: 'auto' })
    expect(awakening.spell?.effects[1]).toMatchObject({
      op: 'if', test: { graveyard: 2, filter: { types: ['instant', 'sorcery'] } }, then: [{ op: 'untap', what: { kind: 'chosen' } }],
    })
  })

  it('drops what is said about a target there never was', () => {
    const master = text("Whenever you attack, goad target creature an opponent controls. It can't block this turn.", 'Creature — Human')
    expect(master).toMatchObject({ coverage: 'auto', triggers: [{ effects: [{ op: 'nothing' }], complete: true }] })
    const right = text('At the beginning of combat on your turn, if you control each creature on the battlefield with the greatest power, gain control of target creature an opponent controls until end of turn. Untap that creature. It gains haste until end of turn.')
    expect(right).toMatchObject({ coverage: 'auto', triggers: [{ effects: [{ op: 'nothing' }] }] })
  })

  it('reads the player a card speaks of as you', () => {
    expect(readSentence("that player returns a land they control to its owner's hand")).toMatchObject([
      { op: 'choose', filter: { types: ['land'], controller: 'you' }, must: true }, { op: 'move', to: 'hand' },
    ])
    expect(readSentence('creatures target player controls gain lifelink until end of turn')).toMatchObject([
      { op: 'boost', to: { kind: 'each', filter: { types: ['creature'], controller: 'you' } }, keywords: ['Lifelink'] },
    ])
    expect(readSentence("target player creates a token that's a copy of target creature you control")).toMatchObject([
      { op: 'choose' }, { op: 'copy', of: { kind: 'chosen' } },
    ])
  })

  it('reads counts that come to nothing against no opponent', () => {
    expect(readSentence("~ deals damage to target player equal to the number of cards in that player's hand")).toEqual([
      { op: 'nothing', why: 'No hand on the other side to count' },
    ])
    expect(readAbility('Each other player discards a card. You draw a card for each card discarded this way.')).toMatchObject({
      complete: true, effects: [{ op: 'nothing' }, { op: 'draw', count: 'thatMany' }],
    })
    expect(readSentence('he gets +1/+0 until end of turn for each artifact defending player controls')).toMatchObject([{ op: 'nothing' }])
  })

  it('reads a search that splits what it finds three ways', () => {
    expect(readAbility('Search your library for up to three basic land cards and reveal them. Put two of them onto the battlefield tapped and the other into your hand, then shuffle.')).toMatchObject({
      complete: true,
      effects: [{ op: 'search', count: 3, upTo: true, to: 'battlefield', tapped: true, first: 2 }],
    })
    // Cultivate: one of two.
    expect(readSentence('search your library for up to two basic land cards, reveal those cards, put one onto the battlefield tapped and the other into your hand, then shuffle')).toMatchObject([
      { op: 'search', count: 2, first: 1 },
    ])
  })
})

describe('abilities', () => {
  it('reads an ability given to a whole tribe as one that watches the tribe', () => {
    const sliver = text('All Slivers have "When this permanent enters, destroy target artifact or enchantment."', 'Creature — Sliver')
    expect(sliver).toMatchObject({
      coverage: 'auto',
      triggers: [{ when: { on: 'enters', who: { subtypes: ['Sliver'], controller: 'you' } }, effects: [{ op: 'choose' }, { op: 'move' }] }],
    })
  })

  it('reads an anthem for creatures that are one thing or another', () => {
    const brenard = text("Each creature you control that's a Food or a Golem gets +2/+2 and has trample.", 'Creature — Human')
    expect(brenard.statics).toEqual([{
      kind: 'boost', to: { types: ['creature'], subtypes: ['Food', 'Golem'], controller: 'you' },
      boost: { power: 2, toughness: 2, keywords: ['Trample'] },
    }])
  })

  it('understands an ability that could only ever do nothing, whatever it costs', () => {
    const lockdown = text('{2}, Tap two untapped Humans you control: Tap target creature an opponent controls.')
    expect(lockdown).toMatchObject({ coverage: 'auto', activated: [] })
  })

  it('reads "choose one, or both with a commander"', () => {
    const will = text('Choose one. If you control a commander as you cast this spell, you may choose both instead.\n• Any number of target opponents each sacrifice a creature with the greatest power among creatures that player controls and lose 3 life.\n• Return target creature card from your graveyard to the battlefield.', 'Sorcery')
    expect(will).toMatchObject({ coverage: 'auto' })
    expect(will.spell?.effects[0]).toMatchObject({
      op: 'mode', min: 1, max: 1, more: { test: { control: { commander: true } }, max: 2 },
      modes: [{ effects: [{ op: 'life', who: 'opponent', sign: -1, count: 3 }] }, { effects: [{ op: 'reanimate' }] }],
    })
  })

  it('checks a condition that is always so here', () => {
    expect(readTest('you control each creature on the battlefield with the greatest power')).toEqual({
      control: { types: ['creature'], controller: 'you' }, atLeast: 1,
    })
  })
})
