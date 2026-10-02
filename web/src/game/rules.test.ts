import { describe, expect, it } from 'vitest'

import type { Card } from '../lib/api'
import { checkCast, landProblem, manaOptions, playable } from './cast'
import { deal, reduce } from './reducer'
import {
  BEARS, card, COMMANDER, ELVES, entry, FOREST, game, GROWTH, ORZHOV_SIGNET, PLAINS, RIDDLE,
  SOL_RING, SURGE, SWAMP, TAPLAND, TOWER, TOWER_OF_RELICS, WALKER,
} from './testing'
import type { Action, GameState, Instance, Zone } from './types'

/** A game with the rules on, in the first main phase. */
const ruled = (placed: [Card, Zone, Partial<Instance>?][], extra: Partial<GameState> = {}) =>
  game(placed, { rules: true, ...extra })

const run = (state: GameState, ...actions: Action[]) => actions.reduce(reduce, state)
const at = (state: GameState, iid: string) => state.cards.find((c) => c.iid === iid)!
const zone = (state: GameState, z: Zone) => state.cards.filter((c) => c.zone === z)

describe('the opening hand', () => {
  const deck = [entry(COMMANDER, 1, 'commander'), entry(FOREST, 40), entry(BEARS, 40)]

  it('is seven cards, and a turn waiting to be started', () => {
    const dealt = deal(deck, 3)
    expect(dealt).toMatchObject({ pending: { kind: 'start' }, turn: 1 })
    expect(zone(dealt, 'hand')).toHaveLength(7)
    // Nothing is played before the turn has begun.
    const land = zone(dealt, 'hand').find((c) => c.card.name === 'Forest')!
    expect(reduce(dealt, { type: 'play', iid: land.iid })).toBe(dealt)
    expect(playable(dealt).size).toBe(0)
  })

  it('starts when you pass: a card drawn, and the first main phase', () => {
    const begun = reduce(deal(deck, 3), { type: 'pass' })
    expect(begun).toMatchObject({ pending: null, step: 'main1', turn: 1 })
    // At a table of four everybody draws on turn one.
    expect(zone(begun, 'hand')).toHaveLength(8)
    expect(begun.log.slice(0, 2)).toEqual(['Drew a card', 'Turn 1'])
  })

  it('starts just the same when you draw from the deck instead', () => {
    const begun = reduce(deal(deck, 3), { type: 'draw' })
    expect(begun).toMatchObject({ pending: null, step: 'main1', turn: 1 })
    expect(zone(begun, 'hand')).toHaveLength(8)
    // The card after that is one drawn by hand, as ever.
    expect(zone(reduce(begun, { type: 'draw' }), 'hand')).toHaveLength(9)
  })

  it('lets a card be put back by hand first, in place of a mulligan', () => {
    const dealt = deal(deck, 3)
    const [first] = zone(dealt, 'hand')
    const back = reduce(dealt, { type: 'move', iid: first.iid, zone: 'library' })
    expect(back.pending).toEqual({ kind: 'start' })
    expect(zone(back, 'hand')).toHaveLength(6)
    // To the bottom, as a mulligan puts it — not on top, to be drawn straight back.
    expect(zone(back, 'library').at(-1)?.iid).toBe(first.iid)
    expect(zone(reduce(back, { type: 'pass' }), 'hand').map((c) => c.iid)).not.toContain(first.iid)
  })

  it('is dealt again the same way by a reset', () => {
    const again = reduce(reduce(deal(deck, 3), { type: 'pass' }), { type: 'deal', deck, seed: 4 })
    expect(again).toMatchObject({ pending: { kind: 'start' }, turn: 1 })
    expect(zone(again, 'hand')).toHaveLength(7)
  })

  it('waits the same way with the rules off, where the turn button starts it', () => {
    const dealt = deal(deck, 3, false)
    expect(dealt).toMatchObject({ pending: { kind: 'start' }, turn: 1 })
    const begun = reduce(dealt, { type: 'nextTurn' })
    expect(begun).toMatchObject({ pending: null, turn: 1 })
    expect(zone(begun, 'hand')).toHaveLength(8)
    // After that it is the next turn, as it always was.
    expect(reduce(begun, { type: 'nextTurn' })).toMatchObject({ turn: 2 })
    expect(zone(reduce(dealt, { type: 'draw' }), 'hand')).toHaveLength(8)
    expect(reduce(dealt, { type: 'draw' })).toMatchObject({ pending: null, turn: 1 })
  })

  it('is still waiting to start when the rules are switched before it has', () => {
    const off = reduce(deal(deck, 3), { type: 'rules', on: false })
    expect(off.pending).toEqual({ kind: 'start' })
    const on = reduce(off, { type: 'rules', on: true })
    expect(on.pending).toEqual({ kind: 'start' })
    expect(reduce(on, { type: 'pass' })).toMatchObject({ pending: null, step: 'main1', turn: 1 })
  })
})

describe('lands', () => {
  it('allows one a turn, in a main phase', () => {
    const start = ruled([[FOREST, 'hand'], [PLAINS, 'hand']])
    const one = reduce(start, { type: 'play', iid: 'c0' })
    expect(at(one, 'c0').zone).toBe('battlefield')
    expect(one.landsPlayed).toBe(1)
    expect(landProblem(one, 'c1')).toBe('You have already played a land this turn')
    expect(reduce(one, { type: 'play', iid: 'c1' })).toBe(one)
    expect(landProblem({ ...start, step: 'upkeep' }, 'c0')).toMatch(/main phase/)
  })

  it('counts a land dragged to the mat as the land for the turn, and the next as by hand', () => {
    const start = ruled([[FOREST, 'hand'], [PLAINS, 'hand']])
    const one = reduce(start, { type: 'place', iid: 'c0', at: { x: 0.2, y: 0.6 } })
    expect(one.landsPlayed).toBe(1)
    const two = reduce(one, { type: 'place', iid: 'c1', at: { x: 0.3, y: 0.6 } })
    expect(two.landsPlayed).toBe(1)
    expect(two.log[0]).toBe('Put Plains onto the battlefield by hand')
  })
})

describe('casting', () => {
  const lands: [Card, Zone][] = [[FOREST, 'battlefield'], [PLAINS, 'battlefield']]

  it('pays with the cheapest lands and puts the spell on the stack', () => {
    const cast = reduce(ruled([[BEARS, 'hand'], ...lands]), { type: 'play', iid: 'c0' })
    expect(at(cast, 'c0').zone).toBe('stack')
    expect(cast.stack.map((s) => s.iid)).toEqual(['c0'])
    expect(at(cast, 'c1').tapped && at(cast, 'c2').tapped).toBe(true)
    expect(cast.log[0]).toBe('Cast Grizzly Bears — tapped Forest, Plains')
  })

  it('refuses what cannot be paid for, and says why', () => {
    const start = ruled([[BEARS, 'hand'], [FOREST, 'battlefield']])
    expect(checkCast(start, 'c0').why).toBe('Not enough mana — it costs {1}{G}')
    expect(reduce(start, { type: 'play', iid: 'c0' })).toBe(start)
  })

  it('holds sorcery speed to a main phase with an empty stack, and lets an instant through', () => {
    const start = ruled([[BEARS, 'hand'], [GROWTH, 'hand'], [ELVES, 'hand'],
      [FOREST, 'battlefield'], [FOREST, 'battlefield'], [FOREST, 'battlefield'], [FOREST, 'battlefield']])
    const busy = reduce(start, { type: 'play', iid: 'c0' })
    expect(checkCast(busy, 'c2').why).toMatch(/wait for the stack/)
    expect(checkCast(busy, 'c1').why).toBeUndefined()
    expect(checkCast({ ...start, step: 'end' }, 'c2').why).toMatch(/main phase/)
  })

  it('resolves a creature onto the battlefield, summoning sick', () => {
    const done = run(ruled([[BEARS, 'hand'], ...lands]), { type: 'play', iid: 'c0' }, { type: 'pass' })
    expect(done.stack).toEqual([])
    expect(at(done, 'c0')).toMatchObject({ zone: 'battlefield', sick: true, tapped: false })
    expect(done.log[0]).toBe('Grizzly Bears resolves')
  })

  it('resolves an instant to the graveyard, with its words to carry out', () => {
    const done = run(ruled([[RIDDLE, 'hand'], [FOREST, 'battlefield']]), { type: 'play', iid: 'c0' }, { type: 'pass' })
    expect(at(done, 'c0').zone).toBe('graveyard')
    expect(done.reminders).toHaveLength(1)
    expect(done.reminders[0]).toMatchObject({ iid: 'c0', name: 'Riddle' })
    expect(reduce(done, { type: 'done', id: done.reminders[0].id }).reminders).toEqual([])
  })

  it('reminds you of what a permanent does as it enters, when nothing reads it', () => {
    const odd = card('Oddity', 'Creature — Thing', {
      mana_cost: '{G}', oracle_text: 'When this creature enters, do something nobody has written down.',
    })
    const done = run(ruled([[odd, 'hand'], ...lands]), { type: 'play', iid: 'c0' }, { type: 'pass' })
    expect(done.reminders.map((r) => r.text)).toEqual(['When Oddity enters, do something nobody has written down.'])
  })

  it('spends floating mana before tapping anything', () => {
    const start = ruled([[GROWTH, 'hand'], [FOREST, 'battlefield'], [FOREST, 'battlefield']])
    const floated = reduce(start, { type: 'mana', iid: 'c1' })
    expect(floated.pool.G).toBe(1)
    const cast = reduce(floated, { type: 'play', iid: 'c0' })
    expect(cast.pool.G).toBe(0)
    expect(at(cast, 'c2').tapped).toBe(false)
  })

  it('pays a Phyrexian symbol with life when there is no mana for it', () => {
    const cast = reduce(ruled([[SURGE, 'hand']]), { type: 'play', iid: 'c0' })
    expect(cast.life).toBe(38)
    expect(cast.log[0]).toBe('Cast Gitaxian Probe, paid 2 life')
  })

  it('taxes a commander for each time it has come home', () => {
    const start = ruled([
      [COMMANDER, 'command', { commander: true }],
      [FOREST, 'battlefield'], [PLAINS, 'battlefield'], [SWAMP, 'battlefield'],
      [FOREST, 'battlefield'], [PLAINS, 'battlefield'],
    ])
    const out = run(start, { type: 'play', iid: 'c0' }, { type: 'pass' })
    expect(at(out, 'c0').zone).toBe('battlefield')
    // Dies, and the game sends it home rather than leaving it in the yard.
    const home = reduce(out, { type: 'move', iid: 'c0', zone: 'graveyard' })
    expect(at(home, 'c0').zone).toBe('command')
    expect(home.log[0]).toBe('Felothar the Steadfast returns to the command zone')
    expect(checkCast(home, 'c0').cost.generic).toBe(2)
    // Two lands left untapped: not enough for {2}{W}{B}{G}.
    expect(checkCast(home, 'c0').why).toBe('Not enough mana — it costs {2}{W}{B}{G}')
  })

  it('pays X as generic, and remembers what it was', () => {
    const blaze = card('Blaze', 'Sorcery', { mana_cost: '{X}{R}', oracle_text: 'Blaze deals X damage to any target.' })
    const mountain = card('Mountain', 'Basic Land — Mountain')
    const start = ruled([[blaze, 'hand'], [mountain, 'battlefield'], [mountain, 'battlefield'], [mountain, 'battlefield']])
    expect(checkCast(start, 'c0', 3).why).toBe('Not enough mana — it costs {X}{R}')
    const cast = reduce(start, { type: 'play', iid: 'c0', x: 2 })
    expect(cast.stack[0].x).toBe(2)
    expect(cast.log[0]).toBe('Cast Blaze (X = 2) — tapped Mountain ×3')
  })

  it('lights what can be played', () => {
    const start = ruled([[BEARS, 'hand'], [GROWTH, 'hand'], [PLAINS, 'hand'], [FOREST, 'battlefield']])
    expect([...playable(start)].sort()).toEqual(['c1', 'c2'])
  })
})

describe('mana', () => {
  it('asks which color when a source could make several', () => {
    const state = ruled([[TOWER, 'battlefield'], [COMMANDER, 'command', { commander: true }]])
    expect(manaOptions(state, 'c0').map((o) => o.kinds)).toEqual([['W'], ['B'], ['G']])
    const tapped = reduce(state, { type: 'mana', iid: 'c0', kinds: ['B'] })
    expect(tapped.pool.B).toBe(1)
    expect(tapped.log[0]).toBe('Tapped Command Tower for {B}')
  })

  it('feeds a Signet from the pool, then from a land', () => {
    const state = ruled([[ORZHOV_SIGNET, 'battlefield'], [FOREST, 'battlefield']])
    const signet = reduce(state, { type: 'mana', iid: 'c0' })
    expect(at(signet, 'c1').tapped).toBe(true)
    expect(signet.pool).toMatchObject({ W: 1, B: 1, G: 0 })
  })

  it('still lets you turn a land by hand, making nothing', () => {
    const turned = reduce(ruled([[FOREST, 'battlefield']]), { type: 'tap', iid: 'c0' })
    expect(at(turned, 'c0').tapped).toBe(true)
    expect(turned.pool.G).toBe(0)
  })

  it('will not tap a summoning-sick creature', () => {
    const state = ruled([[ELVES, 'battlefield', { sick: true }]])
    expect(reduce(state, { type: 'mana', iid: 'c0' })).toBe(state)
  })

  it('empties the pool as the step ends', () => {
    const floated = reduce(ruled([[SOL_RING, 'battlefield']]), { type: 'mana', iid: 'c0' })
    const moved = reduce(floated, { type: 'pass' })
    expect(moved.pool.C).toBe(0)
    expect(moved.log).toContain('2 unspent mana left the pool')
  })
})

describe('the turn', () => {
  it('passes from the first main phase to the second', () => {
    expect(reduce(ruled([]), { type: 'pass' }).step).toBe('main2')
  })

  it('untaps, wakes creatures, resets the land drop and draws, on to the next main phase', () => {
    const start = ruled([
      [FOREST, 'battlefield', { tapped: true }], [ELVES, 'battlefield', { sick: true }], [PLAINS, 'library'],
    ], { step: 'main2', landsPlayed: 1 })
    const next = reduce(start, { type: 'pass' })
    expect(next).toMatchObject({ turn: 2, step: 'main1', landsPlayed: 0 })
    expect(at(next, 'c0').tapped).toBe(false)
    expect(at(next, 'c1').sick).toBe(false)
    expect(at(next, 'c2').zone).toBe('hand')
  })

  it('passes to a chosen step, next turn if it has gone by', () => {
    expect(reduce(ruled([]), { type: 'passTo', step: 'end' })).toMatchObject({ step: 'end', turn: 1 })
    expect(reduce(ruled([], { step: 'main2' }), { type: 'passTo', step: 'upkeep' }))
      .toMatchObject({ step: 'upkeep', turn: 2 })
  })

  it('resolves the stack on the way', () => {
    const cast = reduce(ruled([[GROWTH, 'hand'], [FOREST, 'battlefield']]), { type: 'play', iid: 'c0' })
    const later = reduce(cast, { type: 'passTo', step: 'end' })
    expect(later.stack).toEqual([])
    expect(at(later, 'c0').zone).toBe('graveyard')
  })

  it('makes you discard to seven in cleanup', () => {
    const hand: [Card, Zone][] = Array.from({ length: 9 }, () => [BEARS, 'hand'])
    const over = reduce(ruled([...hand, [FOREST, 'library']], { step: 'main2' }), { type: 'pass' })
    expect(over).toMatchObject({ step: 'cleanup', pending: { kind: 'discard', count: 2 } })
    // Nothing else happens until it is answered.
    expect(reduce(over, { type: 'pass' })).toBe(over)
    const done = reduce(over, { type: 'choose', iids: ['c0', 'c1'] })
    expect(done).toMatchObject({ pending: null, turn: 2, step: 'main1' })
    expect(zone(done, 'graveyard')).toHaveLength(2)
  })

  it('lets Reliquary Tower keep a big hand', () => {
    const hand: [Card, Zone][] = Array.from({ length: 9 }, () => [BEARS, 'hand'])
    const next = reduce(ruled([...hand, [TOWER_OF_RELICS, 'battlefield'], [FOREST, 'library']], { step: 'main2' }),
      { type: 'pass' })
    expect(next).toMatchObject({ pending: null, turn: 2 })
  })

  it('loses — and carries on — on drawing from an empty library', () => {
    const next = reduce(ruled([], { step: 'main2' }), { type: 'pass' })
    expect(next.lost).toBe('You drew from an empty library on turn 2')
    expect(next.step).toBe('main1')
  })
})

describe('state-based actions', () => {
  const soldier = card('Soldier', 'Token Creature — Soldier')

  it('lets a token cease to exist off the battlefield', () => {
    const state = ruled([[soldier, 'battlefield', { token: true }]])
    const gone = reduce(state, { type: 'move', iid: 'c0', zone: 'graveyard' })
    expect(gone.cards).toEqual([])
    expect(gone.log[0]).toBe('Soldier ceases to exist')
  })

  it('puts a planeswalker with no loyalty into the graveyard', () => {
    const state = ruled([[WALKER, 'battlefield', { loyalty: 1 }]])
    expect(at(reduce(state, { type: 'loyalty', iid: 'c0', by: -1 }), 'c0').zone).toBe('graveyard')
  })

  it('records a loss at zero life', () => {
    expect(reduce(ruled([], { life: 1 }), { type: 'life', by: -1 }).lost).toBe('Your life reached 0 on turn 1')
  })

  it('leaves the sandbox alone', () => {
    const state = game([[soldier, 'battlefield', { token: true }]])
    expect(reduce(state, { type: 'move', iid: 'c0', zone: 'graveyard' }).cards).toHaveLength(1)
  })
})

describe('the rules switch', () => {
  it('lets the stack land where it was going when turned off', () => {
    const cast = reduce(ruled([[BEARS, 'hand'], [FOREST, 'battlefield'], [PLAINS, 'battlefield']]),
      { type: 'play', iid: 'c0' })
    const off = reduce(cast, { type: 'rules', on: false })
    expect(off.rules).toBe(false)
    expect(at(off, 'c0').zone).toBe('battlefield')
  })

  it('plays freely with them off', () => {
    const free = reduce(game([[BEARS, 'hand']]), { type: 'play', iid: 'c0' })
    expect(at(free, 'c0').zone).toBe('battlefield')
    expect(free.stack).toEqual([])
  })

  it('brings a tapland in tapped either way', () => {
    expect(at(reduce(ruled([[TAPLAND, 'hand']]), { type: 'play', iid: 'c0' }), 'c0').tapped).toBe(true)
  })
})
