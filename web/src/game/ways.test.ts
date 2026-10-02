import { describe, expect, it } from 'vitest'

import type { Card } from '../lib/api'
import { abilitiesOf, activationProblem, usedFrom } from './activate'
import { castWays, costOf, playable } from './cast'
import { compile } from './compiler/compile'
import { reduce } from './reducer'
import { hasKeyword, power } from './stats'
import { BEARS, card, FOREST, game, PLAINS, SWAMP } from './testing'
import type { Action, GameState, Instance, Zone } from './types'

const ruled = (placed: [Card, Zone, Partial<Instance>?][], extra: Partial<GameState> = {}) =>
  game(placed, { rules: true, ...extra })
const run = (state: GameState, ...actions: Action[]) => actions.reduce(reduce, state)
const at = (state: GameState, iid: string) => state.cards.find((c) => c.iid === iid)!
const zone = (state: GameState, iid: string) => at(state, iid).zone
const hand = (state: GameState) => state.cards.filter((c) => c.zone === 'hand').map((c) => c.iid)
const tokens = (state: GameState) => state.cards.filter((c) => c.token)
const keys = (state: GameState, iid: string) => castWays(state, at(state, iid)).map((way) => way.key)
const pass: Action = { type: 'pass' }
const yes: Action = { type: 'confirm', yes: true }
const cast = (iid: string): Action => ({ type: 'play', iid })
const by = (way: string): Action => ({ type: 'cast', way })
const spell = (name: string, text: string, cost = '{G}', type = 'Sorcery', extra: Partial<Card> = {}) =>
  card(name, type, { mana_cost: cost, oracle_text: text, ...extra })
const island = card('Island', 'Basic Land — Island')
const lands = (of: Card, n: number): [Card, Zone][] => Array.from({ length: n }, () => [of, 'battlefield'])
const library: [Card, Zone][] = [[PLAINS, 'library'], [SWAMP, 'library'], [PLAINS, 'library'], [SWAMP, 'library']]
/** On to the given step, attacking with nothing if the game asks. */
const onTo = (state: GameState, step: 'end' | 'upkeep' | 'main1') => {
  const asked = reduce(state, { type: 'passTo', step })
  return asked.pending?.kind === 'attack' ? run(asked, { type: 'attack', iids: [] }, { type: 'passTo', step }) : asked
}
const giant = card('Hill Giant', 'Creature — Giant', { mana_cost: '{3}{R}', cmc: 4, power: '3', toughness: '3', colors: 'R' })

describe('another cost in place of the printed one', () => {
  const drifter = card('Mulldrifter', 'Creature — Elemental', {
    mana_cost: '{4}{U}', power: '2', toughness: '2', keywords: ['Flying', 'Evoke'],
    oracle_text: "Flying\nWhen this creature enters, draw two cards.\nEvoke {2}{U} (You may cast this spell for its evoke cost. If you do, it's sacrificed when it enters.)",
  })

  it('offers evoke, and sacrifices what was evoked once it has arrived', () => {
    expect(compile(drifter)).toMatchObject({ coverage: 'auto', skipped: [], ways: [{ kind: 'evoke', cost: '{2}{U}' }] })
    const start = ruled([[drifter, 'hand'], ...lands(island, 3), ...library])
    // Three lands: evoke is the only way, and it is still asked.
    expect(keys(start, 'c0')).toEqual(['evoke'])
    expect(playable(start).has('c0')).toBe(true)
    const asked = reduce(start, cast('c0'))
    expect(asked.pending).toMatchObject({ kind: 'way', iid: 'c0', ways: [{ key: 'evoke' }] })
    const done = run(asked, by('evoke'), pass, pass, pass)
    expect(zone(done, 'c0')).toBe('graveyard')
    expect(hand(done)).toHaveLength(2)
  })

  it('offers both with the mana for either, and keeps one cast as printed', () => {
    const start = ruled([[drifter, 'hand'], ...lands(island, 5), ...library])
    expect(keys(start, 'c0')).toEqual(['normal', 'evoke'])
    const kept = run(start, cast('c0'), by('normal'), pass, pass)
    expect(zone(kept, 'c0')).toBe('battlefield')
    // Backing out costs nothing.
    const asked = reduce(start, cast('c0'))
    expect(reduce(asked, { type: 'cast', way: null })).toMatchObject({ pending: null, stack: [] })
  })

  it('casts for its freerunning cost once a commander has dealt combat damage', () => {
    const vision = spell('Eagle Vision', 'Freerunning {1}{U} (You may cast this spell for its freerunning cost if you dealt combat damage to a player this turn with an Assassin or commander.)\nDraw three cards.', '{4}{U}')
    expect(compile(vision)).toMatchObject({ coverage: 'auto', skipped: [] })
    const board: [Card, Zone, Partial<Instance>?][] = [[vision, 'hand'], ...lands(island, 2), [BEARS, 'battlefield', { commander: true }], ...library]
    expect(keys(ruled(board), 'c0')).toEqual([])
    const hit = ruled(board, { tally: { drawn: 0, discarded: 0, died: 0, left: 0, binned: 0, gained: 0, lost: 0, struck: 1 } })
    expect(keys(hit, 'c0')).toEqual(['freerunning'])
    const done = run(hit, cast('c0'), by('freerunning'), pass)
    expect(hand(done)).toHaveLength(3)
  })

  it('counts combat damage from a commander toward freerunning', () => {
    const start = ruled([[BEARS, 'battlefield', { commander: true }], ...library], { step: 'combatAttackers', pending: { kind: 'attack', options: ['c0'] } })
    // Attacking runs combat through to the second main phase.
    const struck = run(start, { type: 'attack', iids: ['c0'] })
    expect([struck.step, struck.tally.struck]).toEqual(['main2', 1])
  })

  it('counts a changeling as the Assassin it is', () => {
    const vandal = card('Masked Vandal', 'Creature — Shapeshifter', { power: '1', toughness: '3', keywords: ['Changeling'], oracle_text: 'Changeling' })
    const start = ruled([[vandal, 'battlefield'], [BEARS, 'battlefield'], ...library], { step: 'combatAttackers', pending: { kind: 'attack', options: ['c0', 'c1'] } })
    expect(run(start, { type: 'attack', iids: ['c0'] }).tally.struck).toBe(1)
    // A Bear is neither an Assassin nor anyone's commander.
    expect(run(start, { type: 'attack', iids: ['c1'] }).tally.struck).toBe(0)
  })

  it('exiles two green cards from hand rather than pay', () => {
    const rider = card('Allosaurus Rider', 'Creature — Elf Warrior', {
      mana_cost: '{5}{G}{G}', colors: 'G', power: '1+*', toughness: '1+*',
      oracle_text: "You may exile two green cards from your hand rather than pay this spell's mana cost.\nAllosaurus Rider's power and toughness are each equal to 1 plus the number of lands you control.",
    })
    const green = { ...BEARS, colors: 'G' }
    const offered = ruled([[rider, 'hand'], [green, 'hand'], [green, 'hand']])
    expect(castWays(offered, at(offered, 'c0')).map((way) => way.label)).toEqual(['Exile two green cards from your hand instead of paying'])
    expect(compile(rider)).toMatchObject({ coverage: 'auto', skipped: [] })
    const start = ruled([[rider, 'hand'], [green, 'hand'], [green, 'hand'], [giant, 'hand'], [green, 'hand'], ...library])
    expect(keys(start, 'c0')).toEqual(['pitch'])
    const asked = run(start, cast('c0'), by('pitch'))
    // Three green cards to choose two from; the red one is not offered.
    expect(asked.pending).toMatchObject({ kind: 'pick', zone: 'hand', options: ['c1', 'c2', 'c4'], min: 2, max: 2 })
    const done = run(asked, { type: 'choose', iids: ['c1', 'c4'] })
    expect([zone(done, 'c0'), zone(done, 'c1'), zone(done, 'c4'), zone(done, 'c2')]).toEqual(['stack', 'exile', 'exile', 'hand'])
    // With one green card there is nothing to offer.
    expect(keys(ruled([[rider, 'hand'], [green, 'hand'], ...library]), 'c0')).toEqual([])
  })
})

describe('a cost on top of the printed one', () => {
  it('kicks a spell for more', () => {
    const charts = spell('Consult the Star Charts', 'Kicker {1}{U} (You may pay an additional {1}{U} as you cast this spell.)\nLook at the top X cards of your library, where X is the number of lands you control. Put one of those cards into your hand. If this spell was kicked, put two of those cards into your hand instead. Put the rest on the bottom of your library in a random order.', '{1}{U}', 'Instant')
    expect(compile(charts)).toMatchObject({ coverage: 'auto', skipped: [] })
    const start = ruled([[charts, 'hand'], ...lands(island, 4), ...library, ...library])
    expect(keys(start, 'c0')).toEqual(['normal', 'kicked'])
    const plain = run(start, cast('c0'), by('normal'), pass)
    expect(plain.pending).toMatchObject({ kind: 'pick', min: 1, max: 1 })
    expect(plain.cards.filter((c) => c.zone === 'battlefield' && c.tapped)).toHaveLength(2)
    const kicked = run(start, cast('c0'), by('kicked'), pass)
    expect(kicked.pending).toMatchObject({ kind: 'pick', min: 2, max: 2 })
    expect(kicked.cards.filter((c) => c.zone === 'battlefield' && c.tapped)).toHaveLength(4)
  })

  it('beholds a creature for the rest of what the spell does', () => {
    const clap = spell("Hulk's Thunderclap", "As an additional cost to cast this spell, you may behold a Gamma creature. (You may choose a Gamma creature you control or reveal a Gamma creature card from your hand.)\nTarget creature you control deals damage equal to its power to another target creature. If this spell's additional cost was paid, destroy target noncreature artifact or noncreature enchantment.")
    const gamma = card('Green Scar', 'Creature — Gamma Warrior', { power: '5', toughness: '5' })
    const relic = card('Relic', 'Artifact')
    expect(compile(clap)).toMatchObject({ coverage: 'auto', skipped: [] })
    expect(keys(ruled([[clap, 'hand'], [FOREST, 'battlefield'], [BEARS, 'battlefield']]), 'c0')).toEqual(['normal'])
    const start = ruled([[clap, 'hand'], [FOREST, 'battlefield'], [gamma, 'battlefield'], [BEARS, 'battlefield'], [relic, 'battlefield'], ...library])
    expect(keys(start, 'c0')).toEqual(['normal', 'behold'])
    // Said as the card prints it.
    expect(castWays(start, at(start, 'c0'))[1].label).toMatch(/^Behold a Gamma creature — /)
    const done = run(start, cast('c0'), by('behold'), pass, { type: 'choose', iids: ['c2'] }, { type: 'choose', iids: ['c3'] }, { type: 'choose', iids: ['c4'] })
    expect([zone(done, 'c3'), zone(done, 'c4')]).toEqual(['graveyard', 'graveyard'])
    // Not beheld: the Relic is never asked about.
    const plain = run(start, cast('c0'), by('normal'), pass, { type: 'choose', iids: ['c2'] }, { type: 'choose', iids: ['c3'] })
    expect([plain.pending, zone(plain, 'c4')]).toEqual([null, 'battlefield'])
  })
})

describe('creatures that help pay', () => {
  const scheme = spell('Lethal Scheme', 'Convoke (Your creatures can help cast this spell. Each creature you tap while casting this spell pays for {1} or one mana of that creature\'s color.)\nDestroy target creature or planeswalker. Each creature that convoked this spell connives.', '{2}{B}{B}', 'Instant')
  const zombie = card('Walking Corpse', 'Creature — Zombie', { power: '2', toughness: '2', colors: 'B' })

  it('taps creatures for what the lands cannot cover, and has them connive', () => {
    expect(compile(scheme)).toMatchObject({ coverage: 'auto', skipped: [] })
    const start = ruled([[scheme, 'hand'], ...lands(SWAMP, 2), [zombie, 'battlefield'], [zombie, 'battlefield', { sick: true }], [giant, 'battlefield'], ...library])
    expect(keys(start, 'c0')).toEqual(['normal', 'convoke'])
    const paid = run(start, cast('c0'), by('normal'))
    // Two Swamps and two creatures; a summoning-sick one can convoke too.
    expect(paid.cards.filter((c) => c.zone === 'battlefield' && c.tapped)).toHaveLength(4)
    expect(paid.stack[0].convoked).toHaveLength(2)
    const conniving = run(paid, pass, { type: 'choose', iids: ['c5'] })
    expect(zone(conniving, 'c5')).toBe('graveyard')
    // Each of the two that convoked connives: a card, and a discard.
    expect(conniving.pending).toMatchObject({ kind: 'pick', zone: 'hand' })
  })

  it('taps creatures first when asked to, and leaves the lands', () => {
    const start = ruled([[scheme, 'hand'], ...lands(SWAMP, 4), [zombie, 'battlefield'], [zombie, 'battlefield'], [BEARS, 'battlefield'], [BEARS, 'battlefield'], ...library])
    const paid = run(start, cast('c0'), by('convoke'))
    expect(paid.stack[0].convoked).toHaveLength(4)
    expect(['c1', 'c2', 'c3', 'c4'].some((iid) => at(paid, iid).tapped)).toBe(false)
  })

  it('costs less for each Sliver', () => {
    const hivepool = card('Thrumming Hivepool', 'Artifact', {
      mana_cost: '{6}',
      oracle_text: 'Affinity for Slivers (This spell costs {1} less to cast for each Sliver you control.)\nSlivers you control have double strike and haste.\nAt the beginning of your upkeep, create two 1/1 colorless Sliver creature tokens.',
    })
    const sliver = card('Metallic Sliver', 'Artifact Creature — Sliver', { power: '1', toughness: '1' })
    expect(compile(hivepool)).toMatchObject({ coverage: 'auto', skipped: [] })
    const state = ruled([[hivepool, 'hand'], [sliver, 'battlefield'], [sliver, 'battlefield'], [BEARS, 'battlefield']])
    expect(costOf(state, at(state, 'c0')).generic).toBe(4)
  })
})

describe('cast from the graveyard', () => {
  const abomination = card('Abomination', 'Legendary Creature — Gamma Berserker Villain', {
    mana_cost: '{7}{R}', power: '10', toughness: '10', keywords: ['Mayhem', 'Trample', 'Menace'],
    oracle_text: 'Menace, trample\nMayhem {4}{R} (You may cast this card from your graveyard for {4}{R} if you discarded it this turn. Timing rules still apply.)',
  })
  const mountain = card('Mountain', 'Basic Land — Mountain')

  it('casts a card discarded this turn for its mayhem cost, and only this turn', () => {
    expect(compile(abomination)).toMatchObject({ coverage: 'auto', skipped: [] })
    const start = ruled([[abomination, 'hand'], ...lands(mountain, 5), ...library, ...library])
    const discarded = reduce(start, { type: 'move', iid: 'c0', zone: 'graveyard' })
    expect(playable(discarded).has('c0')).toBe(true)
    // From the graveyard there is one way, and it is not asked about.
    const done = run(discarded, cast('c0'), pass)
    expect(zone(done, 'c0')).toBe('battlefield')
    expect(done.cards.filter((c) => c.zone === 'battlefield' && c.tapped)).toHaveLength(5)
    const later = onTo(discarded, 'main1')
    expect(playable(later).has('c0')).toBe(false)
    expect(reduce(later, cast('c0'))).toBe(later)
  })

  it('does not offer it to a card that reached the graveyard another way', () => {
    const start = ruled([[abomination, 'battlefield'], ...lands(mountain, 5), ...library])
    const died = reduce(start, { type: 'move', iid: 'c0', zone: 'graveyard' })
    expect(playable(died).has('c0')).toBe(false)
  })
})

describe('keywords that are abilities of a card somewhere else', () => {
  it('unearths a creature for a turn', () => {
    const sentinel = card('Tri-Sentinel', 'Legendary Artifact Creature — Robot Villain', {
      mana_cost: '{7}', power: '7', toughness: '7', keywords: ['Flying', 'Unearth'],
      oracle_text: 'Flying, menace, trample\nUnearth {2} ({2}: Return this card from your graveyard to the battlefield. It gains haste. Exile it at the beginning of the next end step or if it would leave the battlefield. Unearth only as a sorcery.)',
    })
    expect(compile(sentinel)).toMatchObject({ coverage: 'auto', skipped: [] })
    const [ability] = abilitiesOf({ iid: 'x', card: sentinel, zone: 'graveyard', tapped: false, x: 0, y: 0 })
    expect([usedFrom(ability), ability.sorcery]).toEqual(['graveyard', true])
    const start = ruled([[sentinel, 'graveyard'], ...lands(FOREST, 2), ...library])
    const back = run(start, { type: 'activate', iid: 'c0', index: 0 }, pass)
    expect([zone(back, 'c0'), hasKeyword(at(back, 'c0'), 'Haste', back)]).toEqual(['battlefield', true])
    expect(zone(onTo(back, 'main1'), 'c0')).toBe('exile')
  })

  it('embalms a clone as a Zombie copy of something', () => {
    const vizier = card('Vizier of Many Faces', 'Creature — Shapeshifter Cleric', {
      mana_cost: '{2}{U}{U}', power: '0', toughness: '0', colors: 'U', keywords: ['Embalm'],
      oracle_text: "You may have this creature enter as a copy of any creature on the battlefield, except if this creature was embalmed, the token has no mana cost, it's white, and it's a Zombie in addition to its other types.\nEmbalm {3}{U}{U}",
    })
    expect(compile(vizier)).toMatchObject({ coverage: 'auto', skipped: [] })
    const start = ruled([[vizier, 'graveyard'], ...lands(island, 5), [giant, 'battlefield'], ...library])
    const asked = run(start, { type: 'activate', iid: 'c0', index: 0 }, pass)
    expect(zone(asked, 'c0')).toBe('exile')
    expect(asked.pending).toMatchObject({ kind: 'pick', options: ['c6'] })
    const done = run(asked, { type: 'choose', iids: ['c6'] })
    expect(tokens(done).map((c) => c.card)).toMatchObject([{ name: 'Hill Giant', type_line: 'Creature — Giant Zombie', colors: 'W', mana_cost: null }])
  })

  it('encores a creature as a hasty copy for the turn', () => {
    const belonging = card('Belonging', 'Creature — Elemental Incarnation', {
      mana_cost: '{5}{W}', power: '6', toughness: '6', keywords: ['Encore'],
      oracle_text: "When this creature enters, create three 1/1 colorless Shapeshifter creature tokens with changeling. (They're every creature type.)\nEncore {2}{W} ({2}{W}, Exile this card from your graveyard: For each opponent, create a token copy that attacks that opponent this turn if able. They gain haste. Sacrifice them at the beginning of the next end step. Activate only as a sorcery.)",
    })
    expect(compile(belonging)).toMatchObject({ coverage: 'auto', skipped: [] })
    const start = ruled([[belonging, 'graveyard'], ...lands(PLAINS, 3), ...library])
    const made = run(start, { type: 'activate', iid: 'c0', index: 0 }, pass, pass)
    expect(zone(made, 'c0')).toBe('exile')
    expect(tokens(made).map((c) => c.card.name).sort()).toEqual(['Belonging', 'Shapeshifter', 'Shapeshifter', 'Shapeshifter'])
    const copy = tokens(made).find((c) => c.card.name === 'Belonging')!
    expect([hasKeyword(copy, 'Haste', made), power(copy, made)]).toEqual([true, 6])
    expect(tokens(onTo(made, 'main1')).map((c) => c.card.name)).not.toContain('Belonging')
  })

  it('plots a card to cast on a later turn for nothing', () => {
    const bandit = card('Visage Bandit', 'Creature — Shapeshifter Rogue', {
      mana_cost: '{3}{U}', power: '2', toughness: '2', keywords: ['Plot'],
      oracle_text: "You may have this creature enter as a copy of a creature you control, except it's a Shapeshifter Rogue in addition to its other types.\nPlot {2}{U} (You may pay {2}{U} and exile this card from your hand. Cast it as a sorcery on a later turn without paying its mana cost. Plot only as a sorcery.)",
    })
    expect(compile(bandit)).toMatchObject({ coverage: 'auto', skipped: [] })
    const start = ruled([[bandit, 'hand'], ...lands(island, 3), ...library, ...library])
    const plotted = run(start, { type: 'activate', iid: 'c0', index: 0 }, pass)
    expect(at(plotted, 'c0')).toMatchObject({ zone: 'exile', mayPlay: { free: true, sorcery: true } })
    expect(playable(plotted).has('c0')).toBe(false)
    const next = onTo(plotted, 'main1')
    expect(playable(next).has('c0')).toBe(true)
    // The lands are still untapped: it costs nothing now.
    const done = run(next, cast('c0'), pass, { type: 'choose', iids: [] })
    expect(zone(done, 'c0')).toBe('battlefield')
    expect(done.cards.filter((c) => c.zone === 'battlefield' && c.tapped)).toHaveLength(0)
  })

  it('suspends a spell from hand, and casts it when the counters are gone', () => {
    const search = spell('Search for Tomorrow', 'Search your library for a basic land card, put it onto the battlefield, then shuffle.\nSuspend 2—{G} (Rather than cast this card from your hand, you may pay {G} and exile it with two time counters on it. At the beginning of your upkeep, remove a time counter. When the last is removed, you may cast it without paying its mana cost.)', '{2}{G}', 'Sorcery', { keywords: ['Suspend'] })
    expect(compile(search)).toMatchObject({ coverage: 'auto', skipped: [] })
    const start = ruled([[search, 'hand'], [FOREST, 'battlefield'], ...library, ...library, ...library])
    const [ability] = abilitiesOf(at(start, 'c0'))
    expect(usedFrom(ability)).toBe('hand')
    const waiting = run(start, { type: 'activate', iid: 'c0', index: 0 }, pass)
    expect(at(waiting, 'c0')).toMatchObject({ zone: 'exile', suspended: 2 })
    const cast2 = run(onTo(onTo(waiting, 'main1'), 'upkeep'), pass, yes, pass)
    expect(cast2.pending).toMatchObject({ kind: 'pick', zone: 'library' })
    // Suspending is done when a sorcery could be cast.
    expect(activationProblem({ ...start, step: 'upkeep' }, 'c0', 0)).toBeTruthy()
  })
})
