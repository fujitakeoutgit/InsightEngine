/**
 * Every change to a game in progress is an `Action` applied here.
 *
 * Pure — the same state and action always give the same next state — which is
 * what makes undo a list of earlier states and a test a list of actions. One
 * gesture at the table is one action, however many things it changes:
 * cracking a fetch plays a land, sacrifices the fetch and shuffles, and undo
 * has to take all of that back in one press.
 *
 * With the rules on, a play is checked before it happens and the game checks
 * itself after (`stateBased`). With them off, the table is the free sandbox it
 * always was: cards go where you put them and nothing is paid.
 */

import type { Card, DeckToken } from '../lib/api'
import type { DeckCard } from '../lib/deckModel'
import {
  castSpell, castWays, convokeChoice, enterBattlefield, isLand, isPermanentSpell, landProblem, pitchable, playLand, tapForMana,
} from './cast'
import { compile } from './compiler/compile'
import { activate, paid } from './activate'
import { declareAttackers } from './combat'
import { fetchFinds } from './fetch'
import { emptyPool } from './mana'
import { begin, pass, passTo, settle, toNextStop } from './priority'
import { shuffle } from './random'
import { frontOf } from './faces'
import { answer, enterAsCopy, resume } from './resolve'
import { keepLegend } from './sba'
import {
  draw, emptyTally, find, mint, noted, relocate, shuffleLibrary, startingLoyalty, toBottom, toTop,
} from './state'
import type { Action, GameState, Instance, Spot, Zone } from './types'

export { startingLoyalty }

/** Expand quantities into individual copies. The sideboard and maybeboard
 *  never reach the table. */
function build(deck: readonly DeckCard[]): Instance[] {
  const out: Instance[] = []
  for (const entry of deck) {
    if (entry.section === 'sideboard' || entry.section === 'maybeboard') continue
    const loyalty = startingLoyalty(frontOf(entry.card))
    const commander = entry.section === 'commander'
    for (let i = 0; i < entry.quantity; i += 1) {
      out.push({
        iid: `${entry.uid}-${i}`,
        // A card with two faces is in the deck as its front one.
        card: frontOf(entry.card),
        zone: commander ? 'command' : 'library',
        tapped: false,
        x: 0.5,
        y: 0.5,
        ...(loyalty !== null ? { loyalty } : {}),
        ...(commander ? { commander } : {}),
      })
    }
  }
  return out
}

/** A new game: the library shuffled, seven in hand, the commander waiting,
 *  and the first turn not yet begun — see `start`. There is no mulligan: a
 *  hand not worth keeping is dealt again, or a card put back by hand. */
export function deal(
  deck: readonly DeckCard[], seed: number, rules = true, tokens: readonly DeckToken[] = [],
): GameState {
  const [everything, next] = shuffle(build(deck), seed)
  const library = everything.filter((c) => c.zone === 'library')
  const command = everything.filter((c) => c.zone === 'command')
  const hand = library.slice(0, 7).map((c) => ({ ...c, zone: 'hand' as Zone }))
  return {
    cards: [...command, ...hand, ...library.slice(7)],
    turn: 1,
    life: 40,
    log: ['New game — drew 7'],
    drawn: hand.map((c) => c.iid),
    seed: next,
    serial: 0,
    rules,
    step: rules ? 'untap' : 'main1',
    pool: emptyPool(),
    stack: [],
    landsPlayed: 0,
    pending: { kind: 'start' },
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
    casting: null,
    delayed: [],
    untilEnd: [],
    extraBeginnings: 0,
    beginning: false,
    tokenArt: Object.fromEntries(tokens.map((t) => [t.name.toLowerCase(), t.image])),
    events: [],
    tally: emptyTally(),
    blessing: false,
  }
}

/** The first turn begins: by the rules, through its untap, upkeep and draw
 *  to its main phase; without them, a card is drawn and that is all. */
function start(state: GameState): GameState {
  if (state.rules) return begin(state)
  return noted(draw({ ...state, pending: null }, 1), 'Turn 1')
}

/** Sandbox play: instants and sorceries resolve to the graveyard, permanents
 *  are dealt into the region their type belongs to. */
function playFreely(state: GameState, iid: string): GameState {
  const inst = find(state, iid)
  if (!inst) return state
  // Instants and sorceries resolve and are done; they never sit on a
  // battlefield, and leaving one there inflates the board you are reading.
  if (/\b(Instant|Sorcery)\b/.test(inst.card.type_line ?? '')) {
    return noted({ ...state, cards: relocate(state.cards, iid, 'graveyard') }, `Cast ${inst.card.name}`)
  }
  const entered = enterBattlefield(state, iid)
  const because = entered.why ? ` — ${entered.why}` : ''
  return noted(entered.state, entered.tapped
    ? `Played ${inst.card.name} tapped${because}`
    : `Played ${inst.card.name}${because}`)
}

/** Play a land — which, for Vesuva and its kind, may be as a copy of one
 *  already there: the turn's land drop is spent, and it asks which. */
function playLandOrCopy(state: GameState, iid: string, at?: Spot): GameState {
  const inst = find(state, iid)
  if (inst && !landProblem(state, iid)) {
    const copying = enterAsCopy(
      noted({ ...state, landsPlayed: state.landsPlayed + 1 }, `Played ${inst.card.name}`), iid,
    )
    if (copying) return copying
  }
  return playLand(state, iid, at)
}

/** Cast a spell the way that was chosen. A cost paid in cards from hand
 *  asks which, when there are more than it takes; convoke asks which
 *  creatures help. */
function beginCast(state: GameState, iid: string, x: number, way: string): GameState {
  const inst = find(state, iid)
  if (inst && way === 'convoke') {
    const choice = convokeChoice(state, iid, x)
    if (!choice) return state
    return {
      ...state,
      casting: { iid, x, way },
      pending: {
        kind: 'pick',
        zone: 'battlefield',
        prompt: `${inst.card.name}: tap creatures to help pay — each pays {1} or one mana of its color`,
        cancel: true,
        ...choice,
      },
    }
  }
  if (!inst || way !== 'pitch') return castSpell(state, iid, x, way)
  const pitch = compile(inst.card).ways.find((other) => other.kind === 'pitch')
  const options = pitchable(state, inst).map((c) => c.iid)
  if (pitch?.kind !== 'pitch' || options.length < pitch.count) return state
  if (options.length === pitch.count) return castSpell(state, iid, x, way, options)
  return {
    ...state,
    casting: { iid, x, way },
    pending: {
      kind: 'pick',
      zone: 'hand',
      prompt: `${inst.card.name}: exile ${pitch.count} of these from your hand to cast it`,
      options,
      min: pitch.count,
      max: pitch.count,
      cancel: true,
    },
  }
}

/** Crack a fetch: the land it found arrives (tapped, if the fetch said so),
 *  the fetch itself is sacrificed, and the library is shuffled. */
function crack(state: GameState, iid: string, pick: string): GameState {
  const source = find(state, iid)
  const found = find(state, pick)
  const finds = source && fetchFinds(source.card)
  if (!source || !found || !finds) return state
  // A fetch taps to search; one already tapped has nothing to pay with.
  if (state.rules && source.tapped) return state
  /* The land takes the square the fetch is vacating — but only when the
   * fetch actually leaves. One that taps instead of sacrificing is still
   * standing there, so the land is dealt a fresh square. */
  const at = finds.sacrifices ? { x: source.x, y: source.y } : undefined
  const entered = enterBattlefield(state, pick, { at, forceTapped: finds.tapped })
  let next = noted(entered.state, entered.tapped ? `Played ${found.card.name} tapped` : `Played ${found.card.name}`)
  next = { ...next, cards: finds.sacrifices
    ? relocate(next.cards, iid, 'graveyard')
    : next.cards.map((c) => (c.iid === iid ? { ...c, tapped: true } : c)) }
  next = shuffleLibrary(next)
  return noted(next, `${source.card.name}: found ${found.card.name}${
    finds.sacrifices ? ', sacrificed' : ''}, then shuffled`)
}

/** Turning the rules off mid-stack lets every spell on it land where it was
 *  going, without the ceremony; abilities waiting there are dropped, and so
 *  is whatever was half-resolved. */
function clearStack(state: GameState): GameState {
  let next: GameState = { ...state, stack: [], resolving: null, pending: null, casting: null }
  const spells = [
    ...state.stack.filter((item) => !item.ability).map((item) => item.iid),
    ...(state.resolving?.spell ? [state.resolving.source] : []),
  ]
  for (const iid of spells) {
    const inst = find(next, iid)
    if (inst?.zone !== 'stack') continue
    next = isPermanentSpell(inst.card)
      ? enterBattlefield(next, iid).state
      : { ...next, cards: relocate(next.cards, iid, 'graveyard') }
  }
  return next
}

function apply(state: GameState, action: Action): GameState {
  // While the game waits on a choice, the choice is all it will take — and
  // the moves you make by hand, which are not the game's to refuse.
  const waiting = state.rules && state.pending

  switch (action.type) {
    case 'deal': {
      const dealt = deal(action.deck, action.seed, state.rules, action.tokens)
      // A reset keeps the pictures it already had.
      return action.tokens ? dealt : { ...dealt, tokenArt: state.tokenArt }
    }

    case 'draw':
      // The first card drawn from the deck starts the turn, as the button does.
      if (state.pending?.kind === 'start') return start(state)
      return draw(state, action.count ?? 1)

    case 'nextTurn': {
      if (state.pending?.kind === 'start') return start(state)
      if (state.rules) return passTo(state, 'main1')
      const untapped = state.cards.map((c) => (
        c.zone === 'battlefield' && c.tapped ? { ...c, tapped: false } : c
      ))
      const drawn = draw({ ...state, cards: untapped, turn: state.turn + 1 }, 1)
      return noted(drawn, `Turn ${state.turn + 1}`)
    }

    case 'play': {
      if (!state.rules) return playFreely(state, action.iid)
      const inst = find(state, action.iid)
      if (!inst || waiting) return state
      if (isLand(inst.card)) return playLandOrCopy(state, action.iid)
      // Where it could be cast more than one way — evoked, kicked, without
      // paying — which is asked before anything is paid. So is the one way
      // there is, when that is not simply paying for it: nobody evokes a
      // Mulldrifter by accident. From the graveyard there is only mayhem.
      const ways = castWays(state, inst)
      const plain = ways.length === 1 && (ways[0].key === 'normal' || inst.zone === 'graveyard')
      if (ways.length && !plain) {
        return { ...state, pending: { kind: 'way', iid: action.iid, x: action.x ?? 0, ways } }
      }
      return beginCast(state, action.iid, action.x ?? 0, ways[0]?.key ?? 'normal')
    }

    case 'cast': {
      const { pending } = state
      // Thought better of, while choosing what to pay with: nothing was paid.
      if (pending?.kind === 'pick' && pending.cancel && state.casting && action.way === null) {
        return { ...state, pending: null, casting: null }
      }
      if (pending?.kind !== 'way') return state
      const asked: GameState = { ...state, pending: null }
      // Left where it is.
      if (action.way === null) return asked
      return pending.ways.some((way) => way.key === action.way) ? beginCast(asked, pending.iid, pending.x, action.way) : state
    }

    case 'place': {
      const inst = find(state, action.iid)
      if (!inst) return state
      if (inst.zone === 'battlefield') {
        // Nudged, not played: it keeps its tapped state.
        return { ...state, cards: relocate(state.cards, action.iid, 'battlefield', action.at) }
      }
      if (inst.zone === 'stack') return state
      // A land from hand dragged to the mat is the turn's land, when it can be.
      if (state.rules && isLand(inst.card) && !landProblem(state, action.iid)) {
        return playLandOrCopy(state, action.iid, action.at)
      }
      const entered = enterBattlefield(state, action.iid, { at: action.at })
      const because = entered.why ? ` — ${entered.why}` : ''
      if (state.rules) {
        // Anything else dragged onto the battlefield is put there by hand:
        // the way to carry out "put a land onto the battlefield", and the
        // override for everything the rules here do not cover yet.
        return noted(entered.state, `Put ${inst.card.name} onto the battlefield by hand${
          entered.tapped ? ', tapped' : ''}${because}`)
      }
      return entered.tapped
        ? noted(entered.state, `Played ${inst.card.name} tapped${because}`)
        : entered.state
    }

    case 'move':
      return find(state, action.iid)?.zone === 'stack' || !find(state, action.iid)
        ? state
        // Laid on the deck, a card is on top of it: the next one drawn. Put
        // back from an opening hand it goes underneath, as a mulligan does.
        : { ...state, cards: action.zone !== 'library' ? relocate(state.cards, action.iid, action.zone)
            : state.pending?.kind === 'start' ? toBottom(state.cards, action.iid, 'library')
              : toTop(state.cards, action.iid, 'library') }

    case 'tap':
      return find(state, action.iid)
        ? { ...state, cards: state.cards.map((c) => (c.iid === action.iid ? { ...c, tapped: !c.tapped } : c)) }
        : state

    case 'mana':
      return tapForMana(state, action.iid, action.ability ?? 0, action.kinds)

    case 'crack':
      return crack(state, action.iid, action.pick)

    case 'tutor': {
      const found = find(state, action.iid)
      if (!found) return state
      // Searching your library shuffles it. Skipping that would leave the
      // order you just read still in place, which is not the same game.
      const moved = { ...state, cards: relocate(state.cards, action.iid, 'hand') }
      return noted(shuffleLibrary(moved), `Tutored ${found.card.name}, then shuffled`)
    }

    case 'shuffle':
      return noted(shuffleLibrary(state), 'Shuffled the library')

    case 'life':
      return { ...state, life: state.life + action.by }

    case 'loyalty':
      // Floored at zero: negative loyalty is not a state the game has.
      return {
        ...state,
        cards: state.cards.map((c) => (
          c.iid === action.iid ? { ...c, loyalty: Math.max(0, (c.loyalty ?? 0) + action.by) } : c
        )),
      }

    case 'counter': {
      const inst = find(state, action.iid)
      if (!inst || inst.zone !== 'battlefield') return state
      const n = Math.max(0, (inst.counters?.[action.counter] ?? 0) + action.by)
      if (n === (inst.counters?.[action.counter] ?? 0)) return state
      return {
        ...state,
        cards: state.cards.map((c) => (
          c.iid === action.iid ? { ...c, counters: { ...c.counters, [action.counter]: n } } : c
        )),
      }
    }

    case 'attack': {
      if (state.pending?.kind !== 'attack') return state
      const declared = settle(state, declareAttackers(state, action.iids))
      // Whatever triggered on attacking is yours to respond to. With nothing
      // on the stack there is nothing to respond to, and combat goes on.
      return declared.stack.length || declared.pending ? declared : toNextStop(declared)
    }

    case 'activate':
      return state.rules ? activate(state, action.iid, action.index, action.x ?? 0) : state

    case 'opponentLife':
      return { ...state, opponent: { ...state.opponent, life: state.opponent.life + action.by } }

    case 'token': {
      /* Tokens are created, not drawn, so this adds an instance that was never
       * in the library. Each gets its own iid — a deck that makes six Soldiers
       * wants six cards on the mat, not one it has to remember is six — and
       * they land in the middle, to be dragged like anything else. */
      const { token } = action
      const card = {
        oracle_id: token.oracle_id,
        name: token.name,
        type_line: token.type_line,
        image_normal: token.image,
        image_small: token.image,
        mana_cost: null,
        color_identity: token.color_identity,
      } as unknown as Card
      const [iid, minted] = mint(state, `token-${token.oracle_id}-`)
      const made: Instance = {
        iid, card, zone: 'battlefield', tapped: false, x: 0.5, y: 0.5, token: true,
        ...(state.rules ? { sick: true } : {}),
      }
      return noted({ ...minted, cards: [...minted.cards, made] }, `Created ${token.name}`)
    }

    case 'note':
      return noted(state, action.line)

    case 'pass':
      if (!state.rules) return state
      return state.pending?.kind === 'start' ? start(state) : pass(state)

    case 'passTo':
      return state.rules ? passTo(state, action.step) : state

    case 'confirm':
    case 'arrange':
    case 'mode':
    case 'number':
      return answer(state, action)

    case 'order': {
      const { pending } = state
      if (pending?.kind !== 'order') return state
      const asked = new Set(pending.ids)
      if (action.ids.length !== asked.size || new Set(action.ids).size !== asked.size
        || !action.ids.every((id) => asked.has(id))) return state
      // The first to resolve is the top of the stack, which is its end.
      const byId = new Map(state.stack.map((item) => [item.id, item]))
      const placed = [...action.ids].reverse().map((id) => byId.get(id)!)
      let next = 0
      const stack = state.stack.map((item) => (asked.has(item.id) ? placed[next++] : item))
      return { ...state, stack, pending: null }
    }

    case 'pickType': {
      const { pending } = state
      if (pending?.kind !== 'type' || !pending.options.includes(action.subtype)) return state
      const name = find(state, pending.iid)?.card.name ?? 'It'
      const chosen = pending.side ? { chosenMode: action.subtype } : { chosenType: action.subtype }
      const said = noted({
        ...state,
        pending: null,
        cards: state.cards.map((c) => (c.iid === pending.iid ? { ...c, ...chosen } : c)),
      }, `${name}: chose ${action.subtype}`)
      // Asked by a spell as it resolved: on with the rest of it.
      return said.resolving?.source === pending.iid ? resume(said) : said
    }

    case 'choose': {
      const { pending } = state
      // The legend rule: the one that stays.
      if (pending?.kind === 'pick' && pending.legend) {
        const [keep] = action.iids
        if (action.iids.length !== 1 || !pending.options.includes(keep)) return state
        return keepLegend({ ...state, pending: null }, pending.options, keep)
      }
      // A pick that is a cost — what to sacrifice — rather than an effect.
      if (pending?.kind === 'pick' && state.paying) return paid(state, action.iids)
      // …or what is exiled from hand to cast a spell.
      if (pending?.kind === 'pick' && state.casting) {
        const { casting } = state
        const cleared: GameState = { ...state, pending: null, casting: null }
        const cast = castSpell(cleared, casting.iid, casting.x, casting.way, action.iids)
        return cast === cleared ? state : cast
      }
      if (pending?.kind === 'pick') return answer(state, action)
      if (pending?.kind !== 'discard') return state
      const picked = [...new Set(action.iids)]
      if (picked.length !== pending.count) return state
      if (!picked.every((iid) => find(state, iid)?.zone === 'hand')) return state
      let cards = state.cards
      for (const iid of picked) cards = relocate(cards, iid, 'graveyard')
      const names = picked.map((iid) => find(state, iid)!.card.name).join(', ')
      // Discarding finishes cleanup, and the turn goes on to the next.
      return toNextStop(noted({ ...state, cards, pending: null }, `Discarded ${names}`))
    }

    case 'done':
      return state.reminders.some((r) => r.id === action.id)
        ? { ...state, reminders: state.reminders.filter((r) => r.id !== action.id) }
        : state

    case 'rules': {
      if (action.on === state.rules) return state
      // A game not yet started is still waiting to be, either way.
      const waitingToStart = state.pending?.kind === 'start' ? state.pending : null
      if (action.on) {
        // Joining a game already under way: it is your main phase, and the
        // land you may or may not have played is taken on trust.
        return noted({
          ...state, rules: true, step: waitingToStart ? 'untap' : 'main1', pending: waitingToStart, pool: emptyPool(),
        }, 'Rules on')
      }
      return noted({ ...clearStack(state), rules: false, pool: emptyPool(), pending: waitingToStart },
        'Rules off — the table is yours')
    }
  }
}

/** Actions that move the game on by themselves, settling as they go. The
 *  rest are settled here, once, after they have happened. */
const SETTLES_ITSELF = new Set<Action['type']>(['pass', 'passTo', 'deal', 'nextTurn', 'attack'])

export function reduce(state: GameState, action: Action): GameState {
  const next = apply(state, action)
  if (next === state) return state
  const stepped = SETTLES_ITSELF.has(action.type)
    || (action.type === 'choose' && state.pending?.kind === 'discard')
    // Starting the first turn runs it to its main phase, however it was started.
    || state.pending?.kind === 'start'
  return stepped ? next : settle(state, next)
}
