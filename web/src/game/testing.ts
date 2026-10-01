/**
 * Cards for tests. Imported only by `*.test.ts`, so none of this reaches the
 * app bundle.
 */

import type { Card } from '../lib/api'
import type { DeckCard, Section } from '../lib/deckModel'
import { emptyPool } from './mana'
import type { GameState, Instance, Zone } from './types'

export function card(name: string, typeLine: string, extra: Partial<Card> = {}): Card {
  return {
    oracle_id: `oracle-${name}`,
    scryfall_id: null,
    name,
    mana_cost: null,
    cmc: 0,
    type_line: typeLine,
    oracle_text: null,
    power: null,
    toughness: null,
    loyalty: null,
    colors: '',
    color_identity: '',
    keywords: null,
    set_code: null,
    set_name: null,
    collector_number: null,
    rarity: null,
    artist: null,
    flavor_text: null,
    released_at: null,
    edhrec_rank: null,
    reserved: false,
    game_changer: false,
    legalities: null,
    prices: null,
    usd: null,
    image_small: null,
    image_normal: null,
    image_art_crop: null,
    scryfall_uri: null,
    card_faces: null,
    layout: null,
    ...extra,
  }
}

export function entry(of: Card, quantity = 1, section: Section = 'main'): DeckCard {
  return { uid: of.name.toLowerCase().replace(/\W+/g, '-'), quantity, card: of, section }
}

/** A game holding exactly these cards, with iids c0, c1, … in order. The
 *  sandbox unless `rules` says otherwise; with the rules on it is your first
 *  main phase. */
export function game(
  placed: [Card, Zone, Partial<Instance>?][],
  extra: Partial<GameState> = {},
): GameState {
  return {
    cards: placed.map(([of, zone, more], i) => ({
      iid: `c${i}`, card: of, zone, tapped: false, x: 0.5, y: 0.5, ...more,
    })),
    turn: 1,
    life: 40,
    log: [],
    drawn: [],
    seed: 1,
    serial: 0,
    rules: false,
    step: 'main1',
    pool: emptyPool(),
    stack: [],
    landsPlayed: 0,
    pending: null,
    reminders: [],
    casts: {},
    lost: null,
    opponent: { life: 40, poison: 0, commander: {} },
    attacking: [],
    dealt: [],
    won: null,
    extraLands: 0,
    resolving: null,
    triggered: [],
    boosts: [],
    paying: null,
    tokenArt: {},
    ...extra,
  }
}

export const FOREST = card('Forest', 'Basic Land — Forest')
export const PLAINS = card('Plains', 'Basic Land — Plains')
export const BEARS = card('Grizzly Bears', 'Creature — Bear', {
  mana_cost: '{1}{G}', power: '2', toughness: '2',
})
export const GROWTH = card('Giant Growth', 'Instant', {
  mana_cost: '{G}', oracle_text: 'Target creature gets +3/+3 until end of turn.',
})
/** An instant nothing reads, for the cases where a spell is left to you. */
export const RIDDLE = card('Riddle', 'Instant', {
  mana_cost: '{G}', oracle_text: 'Each player shuffles their hand into their library.',
})
export const TAPLAND = card('Guildless Commons', 'Land', {
  oracle_text: 'Guildless Commons enters tapped.\n{T}: Add {C}.',
})
export const CHECKLAND = card('Sunpetal Grove', 'Land', {
  oracle_text: 'Sunpetal Grove enters tapped unless you control a Forest or a Plains.\n{T}: Add {G} or {W}.',
})
export const WILDS = card('Evolving Wilds', 'Land', {
  oracle_text: '{T}, Sacrifice Evolving Wilds: Search your library for a basic land card, '
    + 'put it onto the battlefield tapped, then shuffle.',
})
export const WALKER = card('Ajani Goldmane', 'Legendary Planeswalker — Ajani', {
  loyalty: '4', mana_cost: '{2}{W}{W}',
})
export const COMMANDER = card('Felothar the Steadfast', 'Legendary Creature — Human Warrior', {
  mana_cost: '{W}{B}{G}', color_identity: 'BGW', colors: 'BGW',
})
export const SWAMP = card('Swamp', 'Basic Land — Swamp')
export const TOWER = card('Command Tower', 'Land', {
  oracle_text: "{T}: Add one mana of any color in your commander's color identity.",
})
export const SOL_RING = card('Sol Ring', 'Artifact', { mana_cost: '{1}', oracle_text: '{T}: Add {C}{C}.' })
export const ORZHOV_SIGNET = card('Orzhov Signet', 'Artifact', {
  mana_cost: '{2}', oracle_text: '{1}, {T}: Add {W}{B}.',
})
export const ELVES = card('Llanowar Elves', 'Creature — Elf Druid', {
  mana_cost: '{G}', oracle_text: '{T}: Add {G}.', colors: 'G',
})
export const OMENS = card('Wall of Omens', 'Creature — Wall', {
  mana_cost: '{1}{W}', keywords: ['Defender'],
  oracle_text: 'Defender\nWhen this creature enters, draw a card.',
})
export const TOWER_OF_RELICS = card('Reliquary Tower', 'Land', {
  oracle_text: 'You have no maximum hand size.\n{T}: Add {C}.',
})
export const SURGE = card('Gitaxian Probe', 'Sorcery', {
  mana_cost: '{U/P}', oracle_text: 'Look at target player\'s hand.\nDraw a card.',
})
