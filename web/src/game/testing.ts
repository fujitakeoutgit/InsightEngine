/**
 * Cards for tests. Imported only by `*.test.ts`, so none of this reaches the
 * app bundle.
 */

import type { Card } from '../lib/api'
import type { DeckCard, Section } from '../lib/deckModel'

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

export const FOREST = card('Forest', 'Basic Land — Forest')
export const PLAINS = card('Plains', 'Basic Land — Plains')
export const BEARS = card('Grizzly Bears', 'Creature — Bear', { mana_cost: '{1}{G}' })
export const GROWTH = card('Giant Growth', 'Instant', { mana_cost: '{G}' })
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
export const WALKER = card('Ajani Goldmane', 'Legendary Planeswalker — Ajani', { loyalty: '4' })
export const COMMANDER = card('Felothar the Steadfast', 'Legendary Creature — Human Warrior')
