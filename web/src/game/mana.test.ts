import { describe, expect, it } from 'vitest'

import {
  autotap, demand, emptyPool, formatCost, parseCost, sourcePenalty,
  type ManaPool, type ManaSource, type ManaType, type SourceTraits,
} from './mana'

/** A source making one mana of any of `kinds` per tap. */
const land = (id: string, kinds: ManaType[], traits: SourceTraits = {},
  wanted: Partial<ManaPool> = {}): ManaSource =>
  ({ id, makes: [kinds], penalty: sourcePenalty([kinds], traits, wanted) })

const forest = (id = 'forest') => land(id, ['G'])
const plains = (id = 'plains') => land(id, ['W'])
const swamp = (id = 'swamp') => land(id, ['B'])
const tower = (id = 'tower') => land(id, ['W', 'U', 'B', 'R', 'G'])
const solRing = (id = 'sol'): ManaSource =>
  ({ id, makes: [['C'], ['C']], penalty: sourcePenalty([['C'], ['C']]) })
const signet = (id: string, a: ManaType, b: ManaType): ManaSource =>
  ({ id, makes: [[a], [b]], input: 1, penalty: sourcePenalty([[a], [b]]) })

const tapped = (sources: ManaSource[], cost: string, opts = {}) =>
  autotap(parseCost(cost), sources, opts)?.taps.map((t) => t.id).sort() ?? null

describe('parseCost', () => {
  it('reads generic and colored symbols', () => {
    expect(parseCost('{2}{G}{G}')).toEqual({
      generic: 2, pips: [['G'], ['G']], twobrid: [], phyrexian: [], x: 0,
    })
  })

  it('reads two-digit generic', () => {
    expect(parseCost('{10}').generic).toBe(10)
  })

  it('counts X separately from generic', () => {
    const cost = parseCost('{X}{X}{G}')
    expect(cost.x).toBe(2)
    expect(cost.generic).toBe(0)
  })

  it('keeps colorless apart from generic', () => {
    expect(parseCost('{C}{1}')).toMatchObject({ generic: 1, pips: [['C']] })
  })

  it('reads hybrid, twobrid and Phyrexian symbols', () => {
    expect(parseCost('{G/W}{2/W}{G/P}{G/W/P}')).toEqual({
      generic: 0, pips: [['G', 'W']], twobrid: ['W'], phyrexian: [['G'], ['G', 'W']], x: 0,
    })
  })

  it('reads only the first half of a split card', () => {
    expect(parseCost('{1}{R} // {2}{G}')).toMatchObject({ generic: 1, pips: [['R']] })
  })

  it('treats a missing cost as free', () => {
    expect(parseCost(null)).toEqual({ generic: 0, pips: [], twobrid: [], phyrexian: [], x: 0 })
  })
})

describe('formatCost', () => {
  it('writes a cost back the way it is printed', () => {
    for (const printed of ['{2}{G}{G}', '{X}{R}', '{0}', '{2/W}{G/W}', '{1}{G/P}']) {
      expect(formatCost(parseCost(printed))).toBe(printed)
    }
  })
})

describe('demand', () => {
  it('splits a hybrid pip between its colors', () => {
    const wanted = demand([parseCost('{G}{G}'), parseCost('{G/W}')])
    expect(wanted.G).toBe(2.5)
    expect(wanted.W).toBe(0.5)
  })
})

describe('autotap', () => {
  it('pays {G} with the Forest and saves Command Tower', () => {
    expect(tapped([tower(), forest()], '{G}')).toEqual(['forest'])
  })

  it('spends the land whose color the rest of the hand does not want', () => {
    const wanted = demand([parseCost('{G}{G}')])
    const sources = [land('forest', ['G'], {}, wanted), land('plains', ['W'], {}, wanted)]
    expect(tapped(sources, '{1}')).toEqual(['plains'])
  })

  it('pays {2} with Sol Ring rather than two lands', () => {
    expect(tapped([forest('f1'), forest('f2'), solRing()], '{2}')).toEqual(['sol'])
  })

  it('pays two colors with the two basics, not the Tower', () => {
    expect(tapped([tower(), forest(), plains()], '{G}{W}')).toEqual(['forest', 'plains'])
  })

  it('spends floating mana before tapping anything', () => {
    const pool = { ...emptyPool(), G: 1 }
    const paid = autotap(parseCost('{G}'), [forest()], { pool })
    expect(paid?.taps).toEqual([])
    expect(paid?.pool).toEqual(emptyPool())
  })

  it('returns null when nothing can pay', () => {
    expect(tapped([forest()], '{U}')).toBeNull()
    expect(tapped([forest()], '{2}')).toBeNull()
  })

  it('pays hybrid with either color', () => {
    expect(tapped([plains()], '{G/W}')).toEqual(['plains'])
  })

  it('pays Phyrexian with mana when it can, and life when it cannot', () => {
    expect(tapped([forest(), swamp()], '{G/P}')).toEqual(['forest'])
    const paid = autotap(parseCost('{G/P}'), [swamp()])
    expect(paid?.taps).toEqual([])
    expect(paid?.life).toBe(2)
  })

  it('never pays more life than you have', () => {
    expect(autotap(parseCost('{G/P}'), [swamp()], { life: 1 })).toBeNull()
  })

  it('pays twobrid with the color if it can, two generic if not', () => {
    expect(tapped([plains(), swamp('s1'), swamp('s2')], '{2/W}')).toEqual(['plains'])
    expect(tapped([swamp('s1'), swamp('s2')], '{2/W}')).toEqual(['s1', 's2'])
  })

  it('needs colorless mana for {C}, and floats what Sol Ring makes spare', () => {
    expect(tapped([forest()], '{C}')).toBeNull()
    const paid = autotap(parseCost('{C}'), [forest(), solRing()])
    expect(paid?.taps).toEqual([{ id: 'sol', mana: ['C', 'C'] }])
    expect(paid?.pool).toEqual({ ...emptyPool(), C: 1 })
  })

  it('adds X to generic', () => {
    expect(tapped([forest('f1'), forest('f2'), forest('f3')], '{X}{G}', { x: 2 }))
      .toEqual(['f1', 'f2', 'f3'])
    expect(tapped([forest('f1'), forest('f2')], '{X}{G}', { x: 2 })).toBeNull()
  })

  it('keeps a mana creature back when a land will do', () => {
    const elves = land('elves', ['G'], { creature: true })
    expect(tapped([elves, forest()], '{G}')).toEqual(['forest'])
    expect(tapped([elves, forest()], '{G}{G}')).toEqual(['elves', 'forest'])
  })

  it('cannot pay a Signet with its own mana', () => {
    expect(tapped([signet('orzhov', 'W', 'B')], '{W}')).toBeNull()
  })

  it('pays a Signet with a land, and spends both of its mana', () => {
    const paid = autotap(parseCost('{W}{B}'), [forest(), signet('orzhov', 'W', 'B')])
    expect(paid?.taps).toEqual([
      { id: 'forest', mana: ['G'] },
      { id: 'orzhov', mana: ['W', 'B'] },
    ])
    expect(paid?.pool).toEqual(emptyPool())
  })

  it('chains one Signet into another', () => {
    const sources = [forest(), signet('orzhov', 'W', 'B'), signet('selesnya', 'G', 'W')]
    expect(tapped(sources, '{W}{B}{G}')).toEqual(['forest', 'orzhov', 'selesnya'])
  })

  it('prefers the basics over a Signet for the same colors', () => {
    const sources = [plains(), swamp(), forest(), signet('orzhov', 'W', 'B')]
    expect(tapped(sources, '{W}{B}')).toEqual(['plains', 'swamp'])
  })

  it('answers quickly when a large X taps everything', () => {
    const sources = [
      ...Array.from({ length: 6 }, (_, i) => forest(`f${i}`)),
      ...Array.from({ length: 5 }, (_, i) => plains(`p${i}`)),
      ...Array.from({ length: 4 }, (_, i) => swamp(`s${i}`)),
      tower(), solRing(),
      land('dual1', ['W', 'G']), land('dual2', ['W', 'B']), land('dual3', ['B', 'G']),
      signet('orzhov', 'W', 'B'), signet('selesnya', 'G', 'W'),
    ]
    const started = performance.now()
    const paid = autotap(parseCost('{X}{G}{W}'), sources, { x: 16 })
    expect(performance.now() - started).toBeLessThan(1500)
    expect(paid).not.toBeNull()
    const made = paid!.taps.reduce((n, t) => n + t.mana.length, 0)
    const floating = Object.values(paid!.pool).reduce((n, v) => n + v, 0)
    const signets = paid!.taps.filter((t) => t.id === 'orzhov' || t.id === 'selesnya').length
    // Everything made goes to the spell, into a Signet, or is left floating.
    expect(made - floating - signets).toBe(18)
  })
})
