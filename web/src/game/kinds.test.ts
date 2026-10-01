import { describe, expect, it } from 'vitest'

import { isKind } from './kinds'
import { matches } from './match'
import { power } from './stats'
import { BEARS, card, FOREST, game } from './testing'

const CHANGELING = card('Woodland Changeling', 'Creature — Shapeshifter', {
  mana_cost: '{1}{G}', power: '2', toughness: '2', keywords: ['Changeling'], colors: 'G',
})
const LORD = card('Elvish Archdruid', 'Creature — Elf Druid', {
  power: '2', toughness: '2', colors: 'G', oracle_text: 'Other Elf creatures you control get +1/+1.',
})

describe('what kind of thing a card is', () => {
  const state = game([[CHANGELING, 'battlefield'], [BEARS, 'battlefield'], [FOREST, 'battlefield'], [LORD, 'battlefield']])
  const [changeling, bears, forest] = state.cards

  it('answers by subtype', () => {
    expect(isKind(bears, { subtypes: ['Bear'] })).toBe(true)
    expect(isKind(bears, { subtypes: ['Elf'] })).toBe(false)
  })

  it('takes a changeling for every creature type, and for no other', () => {
    expect(isKind(changeling, { subtypes: ['Elf'] })).toBe(true)
    expect(isKind(changeling, { subtypes: ['Zombie'] })).toBe(true)
    expect(isKind(changeling, { subtypes: ['Forest'] })).toBe(false)
    expect(isKind(changeling, { notSubtypes: ['Spirit'] })).toBe(false)
    expect(isKind(forest, { subtypes: ['Elf'] })).toBe(false)
  })

  it('answers by color', () => {
    expect(isKind(changeling, { colors: ['G', 'U'] })).toBe(true)
    expect(isKind(changeling, { colors: ['U'] })).toBe(false)
    expect(isKind(forest, { colorless: true })).toBe(true)
    expect(isKind(changeling, { colorless: true })).toBe(false)
  })

  it('counts a changeling among a lord\'s tribe', () => {
    expect(power(changeling, state)).toBe(3)
    expect(power(bears, state)).toBe(2)
  })

  it('knows who is attacking only from the game', () => {
    const attacking = { ...state, attacking: [bears.iid] }
    expect(matches(bears, { attacking: true }, undefined, attacking)).toBe(true)
    expect(matches(changeling, { attacking: true }, undefined, attacking)).toBe(false)
    expect(matches(bears, { attacking: true })).toBe(false)
  })
})
