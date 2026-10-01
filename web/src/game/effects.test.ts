import { describe, expect, it } from 'vitest'

import type { Card } from '../lib/api'
import { reduce } from './reducer'
import { power, toughness } from './stats'
import {
  BEARS, card, COMMANDER, FOREST, game, OMENS, PLAINS, SWAMP,
} from './testing'
import type { Action, GameState, Instance, Zone } from './types'

const ruled = (placed: [Card, Zone, Partial<Instance>?][], extra: Partial<GameState> = {}) =>
  game(placed, { rules: true, ...extra })
const run = (state: GameState, ...actions: Action[]) => actions.reduce(reduce, state)
const at = (state: GameState, iid: string) => state.cards.find((c) => c.iid === iid)!
const zone = (state: GameState, z: Zone) => state.cards.filter((c) => c.zone === z)
const pass: Action = { type: 'pass' }
const cast = (iid: string): Action => ({ type: 'play', iid })

const spell = (name: string, text: string, cost = '{G}', type = 'Sorcery') =>
  card(name, type, { mana_cost: cost, oracle_text: text })
const creature = (name: string, text: string, extra: Partial<Card> = {}) =>
  card(name, 'Creature — Test', { mana_cost: '{G}', power: '2', toughness: '2', oracle_text: text, ...extra })

const forests: [Card, Zone][] = [[FOREST, 'battlefield'], [FOREST, 'battlefield'], [FOREST, 'battlefield']]

describe('a spell that does what it says', () => {
  it('draws', () => {
    const divination = spell('Divination', 'Draw two cards.')
    const done = run(ruled([[divination, 'hand'], ...forests, [BEARS, 'library'], [OMENS, 'library']]), cast('c0'), pass)
    expect(zone(done, 'hand').map((c) => c.iid)).toEqual(['c4', 'c5'])
    expect(at(done, 'c0').zone).toBe('graveyard')
    expect(done.reminders).toEqual([])
  })

  it('searches, puts the land down tapped, and shuffles', () => {
    const growth = spell('Rampant Growth', 'Search your library for a basic land card, put that card onto the battlefield tapped, then shuffle.')
    const asked = run(ruled([[growth, 'hand'], ...forests, [BEARS, 'library'], [PLAINS, 'library'], [SWAMP, 'library']]), cast('c0'), pass)
    expect(asked.pending).toMatchObject({ kind: 'pick', zone: 'library', options: ['c5', 'c6'], min: 0, max: 1 })
    // The spell waits, and so does everything else, until it is answered.
    expect(reduce(asked, pass)).toBe(asked)
    const found = reduce(asked, { type: 'choose', iids: ['c6'] })
    expect(at(found, 'c6')).toMatchObject({ zone: 'battlefield', tapped: true })
    expect(found.seed).not.toBe(asked.seed)
    expect(found.pending).toBeNull()
    expect(at(found, 'c0').zone).toBe('graveyard')
    // Put onto the battlefield, not played: the land drop is still there.
    expect(found.landsPlayed).toBe(0)
  })

  it('splits Cultivate between the battlefield and your hand', () => {
    const cultivate = spell('Cultivate', 'Search your library for up to two basic land cards, reveal those cards, put one onto the battlefield tapped and the other into your hand, then shuffle.')
    const done = run(ruled([[cultivate, 'hand'], ...forests, [PLAINS, 'library'], [SWAMP, 'library']]),
      cast('c0'), pass, { type: 'choose', iids: ['c4', 'c5'] })
    expect(at(done, 'c4')).toMatchObject({ zone: 'battlefield', tapped: true })
    expect(at(done, 'c5').zone).toBe('hand')
  })

  it('aims at your own creature, and remembers it for the rest', () => {
    const swords = spell('Swords to Plowshares', 'Exile target creature. Its controller gains life equal to its power.', '{G}', 'Instant')
    const asked = run(ruled([[swords, 'hand'], ...forests, [BEARS, 'battlefield']]), cast('c0'), pass)
    expect(asked.pending).toMatchObject({ kind: 'pick', zone: 'battlefield', options: ['c4'], min: 0 })
    const done = reduce(asked, { type: 'choose', iids: ['c4'] })
    expect(at(done, 'c4').zone).toBe('exile')
    expect(done.life).toBe(42)
  })

  it('does nothing when the target is declined', () => {
    const swords = spell('Swords to Plowshares', 'Exile target creature. Its controller gains life equal to its power.', '{G}', 'Instant')
    const done = run(ruled([[swords, 'hand'], ...forests, [BEARS, 'battlefield']]), cast('c0'), pass, { type: 'choose', iids: [] })
    expect(at(done, 'c4').zone).toBe('battlefield')
    expect(done.life).toBe(40)
    expect(at(done, 'c0').zone).toBe('graveyard')
  })

  it('understands a spell that can only hit the other side, and says so', () => {
    const grasp = spell('Feed the Swarm', 'Destroy target creature an opponent controls.')
    const done = run(ruled([[grasp, 'hand'], ...forests, [BEARS, 'battlefield']]), cast('c0'), pass)
    expect(at(done, 'c4').zone).toBe('battlefield')
    expect(done.log).toContain('Feed the Swarm: nothing on the other side to target')
  })

  it('makes tokens, summoning sick, with the deck\'s picture', () => {
    const rally = spell('Raise the Alarm', 'Create two 1/1 white Soldier creature tokens.')
    const done = run(ruled([[rally, 'hand'], ...forests], { tokenArt: { soldier: 'soldier.png' } }), cast('c0'), pass)
    const tokens = done.cards.filter((c) => c.token)
    expect(tokens).toHaveLength(2)
    expect(tokens[0]).toMatchObject({ zone: 'battlefield', sick: true })
    expect(tokens[0].card).toMatchObject({ name: 'Soldier', power: '1', toughness: '1', image_normal: 'soldier.png' })
    expect(new Set(tokens.map((t) => `${t.x},${t.y}`)).size).toBe(2)
  })

  it('damages the opponent, and notices when that wins', () => {
    const bolt = spell('Lava Spike', 'Lava Spike deals 3 damage to target player or planeswalker.')
    const done = run(ruled([[bolt, 'hand'], ...forests], { opponent: { life: 3, poison: 0, commander: {} } }), cast('c0'), pass)
    expect(done.opponent.life).toBe(0)
    expect(done.won).toBe('The opponent reached 0 life on turn 1')
  })

  it('asks which mode', () => {
    const charm = spell('Charm', 'Choose one —\n• Draw a card.\n• You gain 3 life.')
    const asked = run(ruled([[charm, 'hand'], ...forests, [BEARS, 'library']]), cast('c0'), pass)
    expect(asked.pending).toMatchObject({ kind: 'mode', modes: ['Draw a card.', 'You gain 3 life.'] })
    expect(reduce(asked, { type: 'mode', index: 1 }).life).toBe(43)
  })

  it('carries out what it can, and posts the rest', () => {
    const half = spell('Half Read', 'Draw a card. Then do something nobody has written down.')
    const done = run(ruled([[half, 'hand'], ...forests, [BEARS, 'library']]), cast('c0'), pass)
    expect(zone(done, 'hand')).toHaveLength(1)
    expect(done.reminders.map((r) => r.name)).toEqual(['Half Read'])
  })

  it('grants an extra land drop', () => {
    const explore = spell('Explore', 'You may play an additional land this turn.\nDraw a card.')
    const start = ruled([[explore, 'hand'], [PLAINS, 'hand'], [SWAMP, 'hand'], ...forests, [BEARS, 'library']])
    const done = run(start, cast('c1'), cast('c0'), pass, cast('c2'))
    expect(at(done, 'c2').zone).toBe('battlefield')
    expect(done.landsPlayed).toBe(2)
  })

  it('scries: what you keep stays on top in your order, the rest goes under', () => {
    const preordain = spell('Opt', 'Scry 2.')
    const asked = run(ruled([[preordain, 'hand'], ...forests, [BEARS, 'library'], [OMENS, 'library'], [PLAINS, 'library']]), cast('c0'), pass)
    expect(asked.pending).toEqual({ kind: 'arrange', mode: 'scry', cards: ['c4', 'c5'] })
    const done = reduce(asked, { type: 'arrange', keep: ['c5'], away: ['c4'] })
    expect(zone(done, 'library').map((c) => c.iid)).toEqual(['c5', 'c6', 'c4'])
  })
})

describe('triggered abilities', () => {
  it('put an enters ability on the stack, to resolve when you pass', () => {
    const entered = run(ruled([[OMENS, 'hand'], [FOREST, 'battlefield'], [PLAINS, 'battlefield'], [BEARS, 'library']]), cast('c0'), pass)
    expect(entered.stack).toHaveLength(1)
    expect(entered.stack[0]).toMatchObject({ iid: 'c0', ability: { text: 'When Wall of Omens enters, draw a card.' } })
    expect(entered.log[0]).toBe('Wall of Omens triggers')
    const drawn = reduce(entered, pass)
    expect(at(drawn, 'c3').zone).toBe('hand')
    expect(drawn.stack).toEqual([])
  })

  it('see a land arrive, however it arrives', () => {
    const hydra = creature('Hydra', 'Landfall — Whenever a land you control enters, put a +1/+1 counter on ~.')
    const played = run(ruled([[hydra, 'battlefield'], [FOREST, 'hand']]), cast('c1'), pass)
    expect(at(played, 'c0').counters).toEqual({ '+1/+1': 1 })
    expect([power(at(played, 'c0')), toughness(at(played, 'c0'))]).toEqual([3, 3])
    // Dragged on by hand: still a land entering.
    const dragged = run(ruled([[hydra, 'battlefield'], [FOREST, 'graveyard']]),
      { type: 'place', iid: 'c1', at: { x: 0.3, y: 0.6 } }, pass)
    expect(at(dragged, 'c0').counters).toEqual({ '+1/+1': 1 })
  })

  it('see a creature die, by hand or by the rules', () => {
    const mourner = creature('Mourner', 'Whenever another creature you control dies, draw a card.')
    const died = run(ruled([[mourner, 'battlefield'], [BEARS, 'battlefield'], [FOREST, 'library']]),
      { type: 'move', iid: 'c1', zone: 'graveyard' }, pass)
    expect(at(died, 'c2').zone).toBe('hand')
    // Its own death is not another creature's.
    const self = reduce(ruled([[mourner, 'battlefield']]), { type: 'move', iid: 'c0', zone: 'graveyard' })
    expect(self.stack).toEqual([])
  })

  it('trigger for a creature that died itself', () => {
    const martyr = creature('Martyr', 'When ~ dies, you gain 2 life.')
    const done = run(ruled([[martyr, 'battlefield']]), { type: 'move', iid: 'c0', zone: 'graveyard' }, pass)
    expect(done.life).toBe(42)
  })

  it('stop the turn in upkeep when something happens there', () => {
    const zone_ = card('Awakening Zone', 'Enchantment', { oracle_text: 'At the beginning of your upkeep, you gain 1 life.' })
    const next = reduce(ruled([[zone_, 'battlefield'], [FOREST, 'library']], { step: 'main2' }), pass)
    expect(next).toMatchObject({ turn: 2, step: 'upkeep' })
    expect(next.stack).toHaveLength(1)
    const on = run(next, pass, pass)
    expect(on).toMatchObject({ step: 'main1', life: 41 })
  })

  it('ask before a "you may", and skip its "if you do" when declined', () => {
    const druid = creature('Springbloom Druid', 'When ~ enters, you may sacrifice a land. If you do, search your library for up to two basic land cards, put them onto the battlefield tapped, then shuffle.')
    const asked = run(ruled([[druid, 'hand'], [FOREST, 'battlefield'], [PLAINS, 'library']]), cast('c0'), pass, pass)
    expect(asked.pending?.kind).toBe('confirm')
    const no = reduce(asked, { type: 'confirm', yes: false })
    expect(no.pending).toBeNull()
    expect(at(no, 'c1').zone).toBe('battlefield')
    expect(at(no, 'c2').zone).toBe('library')

    const yes = run(asked, { type: 'confirm', yes: true })
    // One land, and it must be sacrificed: no question, straight to the search.
    expect(at(yes, 'c1').zone).toBe('graveyard')
    expect(yes.pending).toMatchObject({ kind: 'pick', zone: 'library' })
  })

  it('trigger only once a turn when they say so', () => {
    const vampire = creature('Welcoming Vampire', 'Whenever one or more other creatures you control with power 2 or less enter, draw a card. This ability triggers only once each turn.')
    const start = ruled([[vampire, 'battlefield'], [BEARS, 'hand'], [BEARS, 'hand'],
      ...forests, [FOREST, 'battlefield'], [FOREST, 'library'], [FOREST, 'library']])
    const twice = run(start, cast('c1'), pass, pass, cast('c2'), pass)
    expect(zone(twice, 'hand')).toHaveLength(1)
    expect(twice.stack).toEqual([])
  })

  it('check their condition as they trigger', () => {
    const mob = creature('Scute Mob', 'At the beginning of your upkeep, if you control five or more lands, put four +1/+1 counters on ~.')
    const few = reduce(ruled([[mob, 'battlefield'], ...forests, [FOREST, 'library']], { step: 'main2' }), pass)
    expect(few.step).toBe('main1')
    const many = run(ruled([[mob, 'battlefield'], ...forests, [FOREST, 'battlefield'], [FOREST, 'battlefield'], [FOREST, 'library']], { step: 'main2' }), pass, pass)
    expect(at(many, 'c0').counters).toEqual({ '+1/+1': 4 })
  })

  it('read "it" as the creature the trigger is about, even after it has gone', () => {
    const vengeance = creature('Stalking Vengeance', 'Whenever another creature you control dies, it deals damage equal to its power to target player or planeswalker.')
    const done = run(ruled([[vengeance, 'battlefield'], [BEARS, 'battlefield', { counters: { '+1/+1': 3 } }]], {}),
      { type: 'move', iid: 'c1', zone: 'graveyard' }, pass)
    // A 2/2 with three counters was a 5/5 when it died.
    expect(done.opponent.life).toBe(35)
  })

  it('double lifegain under Rhox Faithmender, and tell Wall of Limbs', () => {
    const rhox = creature('Rhox Faithmender', 'Lifelink\nIf you would gain life, you gain twice that much life instead.')
    const limbs = creature('Wall of Limbs', 'Whenever you gain life, put a +1/+1 counter on ~.')
    const balm = spell('Healing Salve', 'You gain 3 life.')
    const done = run(ruled([[balm, 'hand'], [rhox, 'battlefield'], [limbs, 'battlefield'], ...forests]), cast('c0'), pass, pass)
    expect(done.life).toBe(46)
    expect(at(done, 'c2').counters).toEqual({ '+1/+1': 1 })
  })

  it('post the words of an ability nothing reads yet', () => {
    const odd = creature('Oddity', 'When ~ dies, do something nobody has written down.')
    const done = reduce(ruled([[odd, 'battlefield']]), { type: 'move', iid: 'c0', zone: 'graveyard' })
    expect(done.stack).toEqual([])
    expect(done.reminders.map((r) => r.text)).toEqual(['When Oddity dies, do something nobody has written down.'])
  })

  it('send a commander home after its death has been seen', () => {
    const mourner = creature('Mourner', 'Whenever another creature you control dies, draw a card.')
    const done = reduce(ruled([[COMMANDER, 'battlefield', { commander: true }], [mourner, 'battlefield'], [FOREST, 'library']]),
      { type: 'move', iid: 'c0', zone: 'graveyard' })
    expect(at(done, 'c0').zone).toBe('command')
    expect(done.stack).toHaveLength(1)
  })
})

describe('counters and size', () => {
  it('bring an X creature in with its counters', () => {
    const hydra = card('Mistcutter Hydra', 'Creature — Hydra', {
      mana_cost: '{X}{G}', power: '0', toughness: '0', oracle_text: '~ enters with X +1/+1 counters on it.',
    })
    const done = run(ruled([[hydra, 'hand'], ...forests]), { type: 'play', iid: 'c0', x: 2 }, pass)
    expect(at(done, 'c0')).toMatchObject({ zone: 'battlefield', counters: { '+1/+1': 2 } })
  })

  it('kill a creature with no toughness left, or lethal damage on it', () => {
    const elf = creature('Elf', '', { power: '1', toughness: '1' })
    const shrunk = reduce(ruled([[elf, 'battlefield']]), { type: 'counter', iid: 'c0', counter: '-1/-1', by: 1 })
    expect(at(shrunk, 'c0').zone).toBe('graveyard')

    const shock = spell('Shock', 'Shock deals 2 damage to target creature.', '{G}', 'Instant')
    const burned = run(ruled([[shock, 'hand'], [elf, 'battlefield'], ...forests]), cast('c0'), pass, { type: 'choose', iids: ['c1'] })
    expect(at(burned, 'c1').zone).toBe('graveyard')
  })

  it('leave alone a creature whose size it cannot work out', () => {
    const rider = card('Allosaurus Rider', 'Creature — Elf', { power: '1+*', toughness: '1+*', oracle_text: '' })
    const star = card('Star', 'Creature — Thing', { power: '*', toughness: '*', oracle_text: '' })
    const state = reduce(ruled([[rider, 'battlefield'], [star, 'battlefield']]), { type: 'life', by: 1 })
    expect(zone(state, 'battlefield')).toHaveLength(2)
  })

  it('wear damage off in cleanup', () => {
    const next = reduce(ruled([[BEARS, 'battlefield', { damage: 1 }], [FOREST, 'library']], { step: 'main2' }), pass)
    expect(at(next, 'c0').damage).toBeUndefined()
  })
})

describe('paying inside an effect', () => {
  const mentor = creature('Mentor of the Meek', 'Whenever another creature you control with power 2 or less enters, you may pay {1}. If you do, draw a card.')

  it('draws when the price is paid', () => {
    const start = ruled([[mentor, 'battlefield'], [BEARS, 'hand'], ...forests, [FOREST, 'library']])
    const asked = run(start, cast('c1'), pass, pass)
    expect(asked.pending?.kind).toBe('confirm')
    const paid = reduce(asked, { type: 'confirm', yes: true })
    expect(at(paid, 'c5').zone).toBe('hand')
    expect(zone(paid, 'battlefield').filter((c) => c.tapped)).toHaveLength(3)
  })

  it('gives nothing when it is declined, or cannot be paid', () => {
    const start = ruled([[mentor, 'battlefield'], [BEARS, 'hand'], ...forests, [FOREST, 'library']])
    const no = run(start, cast('c1'), pass, pass, { type: 'confirm', yes: false })
    expect(at(no, 'c5').zone).toBe('library')

    const broke = ruled([[mentor, 'battlefield'], [BEARS, 'hand'], [FOREST, 'battlefield'], [FOREST, 'battlefield'], [FOREST, 'library']])
    const tried = run(broke, cast('c1'), pass, pass, { type: 'confirm', yes: true })
    expect(at(tried, 'c4').zone).toBe('library')
    expect(tried.log).toContain('Mentor of the Meek: cannot pay {1}')
  })

  it('does not hand out an "if you do" whose condition nobody read', () => {
    const odd = creature('Oddball', 'When ~ enters, you may do something unwritten. If you do, draw a card.')
    const done = run(ruled([[odd, 'hand'], ...forests, [FOREST, 'library']]), cast('c0'), pass)
    expect(at(done, 'c4').zone).toBe('library')
    expect(done.reminders).toHaveLength(1)
  })
})

describe('sizes the board decides', () => {
  it('sizes a creature by its own text, and lets it die of that', () => {
    const elder = card('Faeburrow Elder', 'Creature — Treefolk Druid', {
      power: '0', toughness: '0', colors: 'GW',
      oracle_text: 'Vigilance\nThis creature gets +1/+1 for each color among permanents you control.',
    })
    const alive = reduce(ruled([[elder, 'battlefield']]), { type: 'life', by: 1 })
    expect([power(at(alive, 'c0'), alive), toughness(at(alive, 'c0'), alive)]).toEqual([2, 2])
    // Two -1/-1 counters undo both colors' worth.
    const shrunk = reduce(alive, { type: 'counter', iid: 'c0', counter: '-1/-1', by: 2 })
    expect(at(shrunk, 'c0').zone).toBe('graveyard')
  })

  it('leaves alone a creature whose size is in words nothing reads', () => {
    const odd = card('Oddsize', 'Creature — Thing', {
      power: '0', toughness: '0', oracle_text: 'This creature gets +1/+1 for each card in your hand.',
    })
    const state = reduce(ruled([[odd, 'battlefield', { damage: 3 }]]), { type: 'life', by: 1 })
    expect(at(state, 'c0').zone).toBe('battlefield')
  })

  it('applies an anthem to the others', () => {
    const lord = card('Lord', 'Creature — Spirit', { power: '2', toughness: '2', oracle_text: 'Other creatures you control get +1/+1.' })
    const state = ruled([[lord, 'battlefield'], [BEARS, 'battlefield']])
    expect(power(at(state, 'c0'), state)).toBe(2)
    expect([power(at(state, 'c1'), state), toughness(at(state, 'c1'), state)]).toEqual([3, 3])
  })

  it('reads a size defined by counting', () => {
    const rider = card('Allosaurus Rider', 'Creature — Elf Warrior', {
      power: '1+*', toughness: '1+*',
      oracle_text: "Allosaurus Rider's power and toughness are each equal to 1 plus the number of lands you control.",
    })
    const state = ruled([[rider, 'battlefield'], [FOREST, 'battlefield'], [FOREST, 'battlefield']])
    expect([power(at(state, 'c0'), state), toughness(at(state, 'c0'), state)]).toEqual([3, 3])
  })
})
