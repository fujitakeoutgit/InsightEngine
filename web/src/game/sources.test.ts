import { describe, expect, it } from 'vitest'

import { manaAbilities, manaSources } from './sources'
import {
  BEARS, card, COMMANDER, ELVES, FOREST, game, ORZHOV_SIGNET, PLAINS, SOL_RING, TOWER,
} from './testing'
import type { GameState } from './types'

/** What the first card can tap for, on a board of these. */
const makes = (state: GameState) => manaAbilities(state.cards[0], state).map((a) => [a.makes, a.input])

describe('reading mana abilities', () => {
  it("reads a basic's ability from its land type", () => {
    expect(makes(game([[FOREST, 'battlefield']]))).toEqual([[[['G']], 0]])
  })

  it('reads a typed dual once, not again from its reminder text', () => {
    const vista = card('Canopy Vista', 'Land — Forest Plains', {
      oracle_text: '({T}: Add {G} or {W}.)\nThis land enters tapped unless you control two or more basic lands.',
    })
    expect(makes(game([[vista, 'battlefield']]))).toEqual([[[['W', 'G']], 0]])
  })

  it("narrows Command Tower to the commander's colors", () => {
    expect(makes(game([[TOWER, 'battlefield'], [COMMANDER, 'command', { commander: true }]])))
      .toEqual([[[['W', 'B', 'G']], 0]])
  })

  it('reads two mana, a choice of one, and an input', () => {
    const chamber = card('Simic Growth Chamber', 'Land', { oracle_text: '{T}: Add {G}{U}.' })
    const shrine = card('Jungle Shrine', 'Land', { oracle_text: 'This land enters tapped.\n{T}: Add {R}, {G}, or {W}.' })
    expect(makes(game([[SOL_RING, 'battlefield']]))).toEqual([[[['C'], ['C']], 0]])
    expect(makes(game([[chamber, 'battlefield']]))).toEqual([[[['G'], ['U']], 0]])
    expect(makes(game([[shrine, 'battlefield']]))).toEqual([[[['R', 'G', 'W']], 0]])
    expect(makes(game([[ORZHOV_SIGNET, 'battlefield']]))).toEqual([[[['W'], ['B']], 1]])
  })

  it('reads a filter land as two abilities', () => {
    const mire = card('Twilight Mire', 'Land', {
      oracle_text: '{T}: Add {C}.\n{B/G}, {T}: Add {B}{B}, {B}{G}, or {G}{G}.',
    })
    expect(makes(game([[mire, 'battlefield']]))).toEqual([[[['C']], 0], [[['B', 'G'], ['B', 'G']], 1]])
  })

  it('counts defenders for the walls that do', () => {
    const battlement = card('Overgrown Battlement', 'Creature — Wall', {
      keywords: ['Defender'], oracle_text: 'Defender\n{T}: Add {G} for each creature you control with defender.',
    })
    const axebane = card('Axebane Guardian', 'Creature — Human Druid', {
      keywords: ['Defender'],
      oracle_text: 'Defender\n{T}: Add X mana in any combination of colors, where X is the number of creatures you control with defender.',
    })
    const board = game([[battlement, 'battlefield'], [axebane, 'battlefield'], [BEARS, 'battlefield']])
    expect(makes(board)).toEqual([[[['G'], ['G']], 0]])
    expect(manaAbilities(board.cards[1], board)[0].makes).toHaveLength(2)
  })

  it('counts a changeling among the Elves', () => {
    const archdruid = card('Elvish Archdruid', 'Creature — Elf Druid', {
      oracle_text: 'Other Elf creatures you control get +1/+1.\n{T}: Add {G} for each Elf you control.',
    })
    const changeling = card('Woodland Changeling', 'Creature — Shapeshifter', { keywords: ['Changeling'], oracle_text: 'Changeling' })
    // The Archdruid, the Llanowar Elves and the changeling; not the Bears.
    const board = game([[archdruid, 'battlefield'], [ELVES, 'battlefield'], [changeling, 'battlefield'], [BEARS, 'battlefield']])
    expect(makes(board)).toEqual([[[['G'], ['G'], ['G']], 0]])
  })

  it('leaves alone what costs a sacrifice or a counter', () => {
    const treasure = card('Treasure', 'Token Artifact — Treasure', {
      oracle_text: '{T}, Sacrifice this token: Add one mana of any color.',
    })
    const roots = card('Wall of Roots', 'Creature — Plant Wall', {
      oracle_text: 'Defender\nPut a -0/-1 counter on this creature: Add {G}. Activate only once each turn.',
    })
    expect(makes(game([[treasure, 'battlefield']]))).toEqual([])
    expect(makes(game([[roots, 'battlefield']]))).toEqual([])
  })

  it("makes one of each color among Faeburrow Elder's permanents", () => {
    const elder = card('Faeburrow Elder', 'Creature — Treefolk Druid', {
      colors: 'GW', oracle_text: '{T}: For each color among permanents you control, add one mana of that color.',
    })
    const knight = card('Knight', 'Creature — Knight', { colors: 'B' })
    expect(makes(game([[elder, 'battlefield'], [knight, 'battlefield']])))
      .toEqual([[[['W'], ['B'], ['G']], 0]])
  })

  it('reads a thriving land as its own color or yours', () => {
    const grove = card('Thriving Grove', 'Land', {
      oracle_text: 'This land enters tapped. As it enters, choose a color other than green.\n{T}: Add {G} or one mana of the chosen color.',
    })
    expect(makes(game([[grove, 'battlefield'], [COMMANDER, 'command', { commander: true }]])))
      .toEqual([[[['G', 'W', 'B']], 0]])
  })
})

describe('sources for the tapper', () => {
  it('offers what is untapped and able', () => {
    const state = game([
      [FOREST, 'battlefield'], [PLAINS, 'battlefield', { tapped: true }],
      [ELVES, 'battlefield', { sick: true }], [SOL_RING, 'battlefield'],
    ])
    expect(manaSources(state).map((s) => s.id)).toEqual(['c0', 'c3'])
  })

  it('merges a pain land into one mana of any of its kinds', () => {
    const caves = card('Caves of Koilos', 'Land', {
      oracle_text: '{T}: Add {C}.\n{T}: Add {W} or {B}. This land deals 1 damage to you.',
    })
    expect(manaSources(game([[caves, 'battlefield']]))[0].makes).toEqual([['C', 'W', 'B']])
  })

  it('lets a haste creature tap the turn it arrives', () => {
    const hasty = card('Hasty Elf', 'Creature — Elf', { keywords: ['Haste'], oracle_text: 'Haste\n{T}: Add {G}.' })
    expect(manaSources(game([[hasty, 'battlefield', { sick: true }]]))).toHaveLength(1)
  })

  it('makes a mana creature dearer than a land', () => {
    const [land, elf] = manaSources(game([[FOREST, 'battlefield'], [ELVES, 'battlefield']]))
    expect(elf.penalty).toBeGreaterThan(land.penalty)
  })
})
