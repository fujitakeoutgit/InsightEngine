import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import { abilitiesOf, activationProblem, costLabel } from '../game/activate'
import {
  checkCast, isLand, landDrops, landProblem, manaOptions, manaProblem, playable,
} from '../game/cast'
import { eligibleAttackers, expectedDamage } from '../game/combat'
import { compile } from '../game/compiler/compile'
import { report } from '../game/compiler/report'
import { canFetch, fetchFinds, obviousFetch, type Fetch } from '../game/fetch'
import type { ManaType } from '../game/mana'
import { randomSeed } from '../game/random'
import { deal } from '../game/reducer'
import { isCreature, manaAbilities } from '../game/sources'
import { resized, sizeLabel } from '../game/stats'
import type { GameState, Instance, Spot, Zone } from '../game/types'
import { freshTable, reduceTable } from '../game/undo'
import { useCardFace } from '../lib/faces'
import { useEscape, usePersisted } from '../lib/usePersisted'
import { sleeveFor } from '../lib/sleeves'
import { readCoinSkin, readD20Skin, readDieSkin, readMatSkin, skinVars } from '../lib/skins'
import { solidDragImage } from '../lib/useQuietDrag'
import { Lightbox } from './Lightbox'
import { ManaCost } from './ManaCost'
import { PlayCoin, type CoinFace } from './PlayCoin'

import { PlayDie } from './PlayDie'
import {
  AbilityMenu, ArrangeDialog, CoverageDialog, DecisionPrompt, ManaPicker, NumberPrompt, OrderPrompt, PhaseBar,
  PickDialog, Reminders,
  StackPanel, XPrompt, type Offered,
} from './PlaytestHud'
import { canAnimate, gsap } from '../lib/motion'
import { type DeckToken } from '../lib/api'
import { type DeckCard } from '../lib/deckModel'
import {
  deckSignature, makeDie, MAX_DICE, recallGame, rememberGame, type DieState,
} from '../lib/playtestCache'

/** A card being looked at, and the rect it grew from. */
interface ZoomView {
  src: string
  alt: string
  from: DOMRect
}

/** Draws the hand has already animated in.
 *
 * Kept by identity, and outside the component: a game's `drawn` is the same
 * array for as long as nothing new is drawn, so undoing back to an earlier
 * state, or closing the mat and resuming, hands back a draw that has already
 * been shown — and it is not shown twice. */
const animated = new WeakSet<readonly string[]>()

/**
 * The loyalty shield, drawn from the supplied artwork.
 *
 * Three stacked paths: the dark outer body, the pale rim inside it, and the
 * dark field the number sits on. The source file holds two copies of the
 * symbol side by side, one of them invisible (`fill-opacity: 0`), so only
 * these three are drawn.
 *
 * The viewBox is measured, not guessed: with the group's own translate
 * applied the art lands at exactly 0,0 and spans 444.33 x 270.2, which is the
 * file's declared page. It is landscape, 1.64:1 — the badge box below is
 * shaped to match, or `meet` would letterbox it and waste half the height.
 */
function LoyaltyShield() {
  return (
    <svg className="pt-loyalty-shield" viewBox="0 0 444.33029 270.20328" aria-hidden>
      <g transform="translate(1043.7177,321.68759)">
        <path
          className="body"
          d="m -914.42409,-83.409802 c -50.7838,-17.621318 -92.41181,-32.116228 -92.50651,-32.210918 -0.095,-0.0947 0.3031,-2.52411 0.884,-5.39867 3.714,-18.37974 3.9967,-41.71129 0.7444,-61.41905 -2.8079,-17.01442 -7.751,-32.4724 -15.2389,-47.65504 -6.0613,-12.29004 -12.5641,-22.31572 -22.3278,-34.42374 -0.5419,-0.67205 -0.9189,-1.27901 -0.8378,-1.34879 0.2874,-0.24729 162.40991,-55.58467 163.00151,-55.63744 0.4105,-0.0366 0.8713,0.65729 1.4525,2.18721 2.556,6.72838 6.6698,12.99076 12.1584,18.50881 4.4834,4.50734 8.538,7.47927 13.9603,10.23254 13.054,6.62837 30.8299,8.65059 47.2902,5.37982 17.5088,-3.4791 31.65858,-13.82026 39.37917,-28.77969 1.09215,-2.11617 2.28804,-4.6879 2.65753,-5.71495 0.36946,-1.02706 0.71461,-1.92603 0.76697,-1.99773 0.0781,-0.10695 163.2938,55.54035 163.65088,55.7957 0.0608,0.0436 -1.37634,1.93538 -3.19395,4.204 -20.13098,25.126 -32.21042,53.74216 -36.29046,85.97181 -2.3632,18.66812 -1.59522,40.43893 1.98896,56.38464 0.70453,3.1345 0.75213,3.74858 0.30368,3.92067 -2.86639,1.09993 -184.20448,63.841458 -184.76188,63.926098 -0.4108,0.0624 -42.2974,-14.30396 -93.0812,-31.92528 z"
        />
        <path
          className="rim"
          d="m -883.23121,-318.4297 c -52.3537,17.52771 -104.5433,35.59297 -156.82619,53.36914 26.622,32.59855 40.92419,74.85269 39.1309,116.92968 -0.183,10.27512 -1.7304,20.86034 -3.2969,30.71875 60.87609,21.254379 121.78839,42.410675 182.81249,63.236324 60.85674,-20.848109 121.61654,-41.980085 182.40033,-63.039064 -5.9873,-32.93263 -4.11969,-67.61554 7.80281,-99.06249 6.5288,-17.7363 16.5349,-33.9838 28.16012,-48.81445 -52.82642,-18.03795 -105.58352,-36.2901 -158.54692,-53.89062 -8.239,20.07803 -27.85504,34.80663 -49.57414,36.51953 -22.8606,2.91974 -48.7282,-3.6289 -62.6996,-23.14961 -3.1689,-4.08281 -5.3515,-8.78166 -7.6286,-13.3836 l -0.9505,0.31045 z"
        />
        <path
          className="field"
          d="m -892.31132,-303.98635 c -43.00245,14.25045 -85.77467,29.18167 -128.65428,43.79492 26.51226,38.76592 36.77393,87.74233 30.10936,134.06055 56.49704,19.49164 112.84115,39.430323 169.47266,58.531251 56.45965,-19.543578 113.00844,-38.814101 169.33398,-58.714851 -7.21005,-46.25606 3.47944,-95.1888 29.91016,-133.89648 -44.5212,-15.11443 -88.86283,-30.88185 -133.59375,-45.24219 -17.84998,29.92014 -57.62981,41.31935 -90.02344,31.32031 -17.04835,-5.00026 -32.72844,-15.93933 -41.74414,-31.43945 -1.60352,0.52865 -3.20703,1.05729 -4.81055,1.58594 z"
        />
      </g>
    </svg>
  )
}

const ZONE_LABEL: Record<Zone, string> = {
  library: 'Library', hand: 'Hand', battlefield: 'Battlefield',
  graveyard: 'Graveyard', exile: 'Exile', command: 'Command', stack: 'Stack',
}

/** How long an explanation of a refused play stays up. */
const HINT_MS = 2600

/** What passing does next, for the button that does it. */
function passLabel(game: GameState) {
  if (game.stack.length) return 'Resolve'
  if (game.step === 'main1') return eligibleAttackers(game).length ? 'Combat' : 'Main 2'
  if (game.step === 'combatBegin' || game.step === 'combatAttackers') return 'Damage'
  if (game.step === 'main2') return 'End turn'
  return 'Continue'
}

/** The most X a spell can be cast with, as the board stands. */
function largestX(game: GameState, iid: string) {
  let x = 0
  while (x < 40 && checkCast(game, iid, x + 1).payment) x += 1
  return x
}

/** How long an armed Reset stays armed. Long enough to mean it, short enough
 *  that it never outlives the moment you pressed it. */
const RESET_WINDOW_MS = 5000

/** The share of a card in hand, measured from the bottom, that reads it
 *  instead of playing it. */
const READ_ZONE = 0.42

/**
 * Goldfishing.
 *
 * The game itself is `game/` — a reducer this component dispatches to and
 * renders, so every change to the board is one action, and undo is handing
 * back the state before it. Nothing is enforced yet: it shuffles, draws, and
 * lets you move cards around and tap them, and the rules arrive in the engine
 * rather than in here.
 *
 * The battlefield is a bare playmat rather than a set of labelled lanes. A real
 * table has no lines on it, and where you put a permanent carries meaning that
 * a layout algorithm cannot guess: attackers pushed forward, an untapped
 * blocker held back, a combo lined up in a corner.
 */
export function Playtest({
  deck, deckName, tokens = [], gameKey, onClose,
}: {
  deck: DeckCard[]
  /** As saved. Only the sleeve reads it, to find the one a seeded deck ships
   *  wearing — see `lib/sleeves`. */
  deckName?: string
  /** Tokens and emblems this deck can make. Not in the library -- a token is
   *  created, never drawn -- so Tutor offers them as a separate list. */
  tokens?: DeckToken[]
  /** Which deck's game this is, so closing and reopening resumes it. */
  gameKey: string
  onClose: () => void
}) {
  const signature = useMemo(() => deckSignature(deck), [deck])
  /** The deck's sleeves, if it has been given any. Read once: sleeves are
   *  changed in the Deck Lab, not mid-game. */
  const [sleeve] = useState(() => sleeveFor(gameKey, deckName))
  /** The chosen dice and coin finishes, as custom properties on this mat.
   *  Read once: skins are changed in Settings, not mid-game. */
  const [skin] = useState(() => skinVars(readDieSkin(), readD20Skin(), readCoinSkin(), readMatSkin()))
  // Read once, at mount. An effect would re-read under StrictMode's double
  // invocation and could observe what this component had itself just written.
  const [resumed] = useState(() => recallGame(gameKey, signature))

  /** Whether new games play by the rules. Remembered, because it is a way of
   *  using the table rather than a fact about one game. */
  const [rulesByDefault, setRulesByDefault] = usePersisted('insight-enigma:playtest-rules', true)
  /** Whether turn 1 draws: remembered, since it is how you play rather than a fact about one game. */
  const [firstDraw, setFirstDraw] = usePersisted('insight-enigma:playtest-first-draw', false)

  /* The game, and the states undo can return to. A resumed game comes back
   * with its undo intact; anything else is dealt here, so the first frame the
   * table draws already has a hand in it. */
  const [table, dispatch] = useReducer(reduceTable, undefined, () => (
    resumed?.table ?? freshTable(deal(deck, randomSeed(), rulesByDefault, tokens, firstDraw))
  ))
  const game = table.game
  const { cards, turn, life, log, drawn } = game
  /* Dice and the coin start fresh every time the mat is opened. They are what
   * is on the table right now rather than what the game is, so they are not
   * part of what a resumed game restores. */
  const [dice, setDice] = useState<DieState[]>(() => [makeDie('d20'), makeDie('d6')])
  const [coin, setCoin] = useState<CoinFace>('heads')
  const [showHistory, setShowHistory] = useState(false)
  /* Reset asks twice, in place, rather than opening a dialog.
   *
   * A modal for this was the wrong weight: it covers the board you are being
   * asked about, and it takes a decision that is one button away from Tutor
   * and makes it a conversation. Arming the button says the same thing in the
   * same spot — press it again and the game goes.
   *
   * Disarmed by a timeout, and by touching anything else at all. Five seconds
   * is long enough to mean it and short enough that a primed Reset never
   * outlives the moment you pressed it; and a button that stays armed while
   * you go back to playing is a trap set for your own next click. */
  const [resetArmed, setResetArmed] = useState(false)
  const resetTimer = useRef<number | undefined>(undefined)
  const resetRef = useRef<HTMLButtonElement>(null)

  const disarmReset = useCallback(() => {
    window.clearTimeout(resetTimer.current)
    setResetArmed(false)
  }, [])

  useEffect(() => {
    if (!resetArmed) return
    resetTimer.current = window.setTimeout(() => setResetArmed(false), RESET_WINDOW_MS)
    // Anything else you do stands the button down. The button's own press is
    // excluded, or arming it would immediately cancel itself.
    const elsewhere = (event: Event) => {
      if (!resetRef.current?.contains(event.target as Node)) disarmReset()
    }
    document.addEventListener('pointerdown', elsewhere, true)
    document.addEventListener('keydown', elsewhere, true)
    return () => {
      window.clearTimeout(resetTimer.current)
      document.removeEventListener('pointerdown', elsewhere, true)
      document.removeEventListener('keydown', elsewhere, true)
    }
  }, [resetArmed, disarmReset])
  const matRef = useRef<HTMLDivElement>(null)
  /** One tray per kind. A die at home is placed from its own tray's measured
   *  box, which is the only way to land exactly inside an outline that
   *  flexbox positioned. */
  const trays = {
    d6: useRef<HTMLDivElement>(null),
    d20: useRef<HTMLDivElement>(null),
  }
  const handRef = useRef<HTMLDivElement>(null)
  /** The hand's scrolling strip, which the wheel drives — see below. */
  const handCardsRef = useRef<HTMLDivElement>(null)
  /** The bin, and whether a die is over it. It exists only while one is being
   *  carried: a permanent trash icon beside the dice invites a misclick and
   *  answers a question nobody is asking until a die is already in hand. */
  const binRef = useRef<HTMLDivElement>(null)
  const [carrying, setCarrying] = useState(false)
  const [binHot, setBinHot] = useState(false)

  /** The in-flight drag: which card, and where in it you grabbed. Kept in a
   *  ref because dataTransfer only yields its payload on drop, and the grab
   *  offset is needed to stop cards jumping to their corner. */
  const drag = useRef<{ iid: string; dx: number; dy: number } | null>(null)
  const [zoomed, setZoomed] = useState<ZoomView | null>(null)
  /** The library search. `fetch` is set when a fetch land opened it, and
   *  narrows the list to what that land is actually allowed to find. */
  const [tutoring, setTutoring] = useState<
    null | { fetch?: Fetch & { source: string; iid: string } }
  >(null)

  const note = useCallback((line: string) => dispatch({ type: 'note', line }), [])
  const undo = useCallback(() => dispatch({ type: 'undo' }), [])
  const canUndo = table.past.length > 0

  /** Why the last thing you tried did not happen, briefly. A refused play
   *  that only did nothing would read as a broken button. */
  const [hint, setHint] = useState<string | null>(null)
  useEffect(() => {
    if (!hint) return
    const timer = window.setTimeout(() => setHint(null), HINT_MS)
    return () => window.clearTimeout(timer)
  }, [hint])

  /** Cards picked in hand for a pending bottom or discard. */
  const [selected, setSelected] = useState<string[]>([])
  useEffect(() => { setSelected([]) }, [game.pending])
  /** A spell with X, waiting on how much. */
  const [choosingX, setChoosingX] = useState<{ iid: string; name: string; max: number } | null>(null)
  /** A source that could make more than one kind of mana, waiting on which. */
  const [pickingMana, setPickingMana] = useState<
    { iid: string; at: Spot; options: { ability: number; kinds: ManaType[] }[] } | null
  >(null)
  /** The permanent whose abilities are being chosen from. */
  const [abilitiesFor, setAbilitiesFor] = useState<string | null>(null)
  /** The list of what the engine does and does not do with this deck. */
  const [showCoverage, setShowCoverage] = useState(false)
  const coverage = useMemo(() => report(
    deck.filter((entry) => entry.section !== 'sideboard' && entry.section !== 'maybeboard').map((entry) => entry.card),
  ), [deck])
  /** The card in hand under the pointer, whose payment is previewed. */
  const [previewing, setPreviewing] = useState<string | null>(null)
  /** The loss already acknowledged, so its banner stays down. */
  const [seenLoss, setSeenLoss] = useState<string | null>(null)
  const [seenWin, setSeenWin] = useState<string | null>(null)

  const canPlay = useMemo(() => playable(game), [game])
  /** What the tapper would tap for the card being previewed. */
  const wouldTap = useMemo(() => {
    if (!previewing || !game.rules || !canPlay.has(previewing)) return new Set<string>()
    const inst = cards.find((c) => c.iid === previewing)
    if (!inst || isLand(inst.card)) return new Set<string>()
    return new Set(checkCast(game, previewing).payment?.taps.map((t) => t.id) ?? [])
  }, [previewing, game, canPlay, cards])

  const setRules = (on: boolean) => {
    setRulesByDefault(on)
    dispatch({ type: 'rules', on })
  }

  const pass = useCallback(() => dispatch({ type: 'pass' }), [])

  // Written on every change rather than on the way out: unmount is too late to
  // read state in an effect cleanup that has closed over an older render, and
  // this is cheap -- a Map assignment against state React has already built.
  useEffect(() => {
    rememberGame(gameKey, { table, signature })
  }, [gameKey, signature, table])

  const inZone = useMemo(() => {
    const map: Record<Zone, Instance[]> = {
      library: [], hand: [], battlefield: [], graveyard: [], exile: [], command: [], stack: [],
    }
    for (const card of cards) map[card.zone].push(card)
    return map
  }, [cards])

  const move = (iid: string, zone: Exclude<Zone, 'battlefield' | 'stack'>) =>
    dispatch({ type: 'move', iid, zone })

  const draw = (count = 1) => dispatch({ type: 'draw', count })

  /* Ctrl+Z takes back the last thing you did to the game — a play, a tap, a
   * draw, a whole new deal. Not while typing, where it belongs to the field,
   * and not while a dialog is up: Tutor is showing you the library as it is,
   * and undoing underneath it would leave it showing a library that is not. */
  /* Space passes priority, as it does at most digital tables. Never when a
   * control has focus, which already answers Space by pressing itself. */
  const dialogOpen = Boolean(tutoring || zoomed || choosingX || pickingMana || abilitiesFor || showCoverage)
  useEffect(() => {
    if (dialogOpen) return
    const onKey = (event: KeyboardEvent) => {
      const { target } = event
      const typing = target instanceof Element
        && target.closest('input, textarea, select, [contenteditable="true"]')
      if (event.key === ' ' && !event.ctrlKey && !event.metaKey && !event.altKey) {
        if (!game.rules || game.pending || typing) return
        if (target instanceof Element && target.closest('button, a, [role="button"]')) return
        event.preventDefault()
        pass()
        return
      }
      if (!(event.ctrlKey || event.metaKey) || event.shiftKey || event.altKey) return
      if (event.key.toLowerCase() !== 'z' || typing) return
      event.preventDefault()
      undo()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [dialogOpen, undo, pass, game.rules, game.pending])

  /* The wheel scrolls the hand.
   *
   * The hand overflows sideways, and a wheel reports only vertical movement
   * unless Shift is held — so on a hand wider than the strip the wheel did
   * nothing at all, and the only ways along were the scrollbar and dragging.
   * Vertical wheel movement is spent on horizontal distance here, which is
   * what every sideways strip on the web has taught people to expect.
   *
   * A native listener rather than `onWheel`: React registers wheel passively
   * at the root, so `preventDefault` from a React handler is ignored.
   */
  useEffect(() => {
    const strip = handCardsRef.current
    if (!strip) return

    const onWheel = (event: WheelEvent) => {
      // Ctrl+wheel is the browser's zoom, not ours to take.
      if (event.ctrlKey) return
      const overflow = strip.scrollWidth - strip.clientWidth
      if (overflow <= 0) return
      // A trackpad's sideways swipe already scrolls this; only stand in when
      // the gesture is mostly vertical, or there is nothing vertical about it
      // and the browser is reporting a plain wheel notch.
      if (Math.abs(event.deltaX) > Math.abs(event.deltaY)) return
      // Firefox reports lines, not pixels, and a full page for deltaMode 2.
      const step = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? strip.clientWidth : 1
      const delta = event.deltaY * step
      if (!delta) return
      const before = strip.scrollLeft
      strip.scrollLeft = Math.max(0, Math.min(overflow, before + delta))
      // Only claim the gesture if it moved something. At either end the wheel
      // belongs to whatever is behind this again.
      if (strip.scrollLeft !== before) event.preventDefault()
    }

    strip.addEventListener('wheel', onWheel, { passive: false })
    return () => strip.removeEventListener('wheel', onWheel)
  }, [])

  // Only the new cards animate. Re-revealing the whole hand every turn made it
  // impossible to see which card had actually arrived.
  useEffect(() => {
    if (animated.has(drawn)) return
    animated.add(drawn)
    if (!handRef.current || !drawn.length || !canAnimate()) return
    const tiles = drawn
      .map((iid) => handRef.current!.querySelector(`[data-iid="${iid}"]`))
      .filter(Boolean) as Element[]
    if (!tiles.length) return
    gsap.fromTo(tiles,
      { opacity: 0, y: 26, rotateX: -30, filter: 'blur(10px)' },
      { opacity: 1, y: 0, rotateX: 0, filter: 'blur(0px)', duration: 0.5,
        ease: 'power3.out', stagger: { amount: 0.22 } },
    )
  }, [drawn])

  /** Start over: a fresh deal *and* the dice swept back into their trays.
   *
   * The only way back to a new opening hand now that Mulligan is gone, which
   * is why it also sweeps the table — it is a new game, not the same one
   * re-dealt, so a die still tracking something from the last one would be
   * tracking nothing. The deal itself can be undone; the dice cannot, being
   * no part of the game. */
  const resetGame = () => {
    disarmReset()
    setDice([makeDie('d20'), makeDie('d6')])
    setCoin('heads')
    dispatch({ type: 'deal', deck, seed: randomSeed(), tokens })
  }

  /* Dice come out of a tray rather than there being exactly one of them.
   *
   * Moving the tray die away leaves the tray empty, so a fresh one takes its
   * place -- you reach for a die and there is always a die to reach for.
   * Dropping a loose one back on the tray puts it away again, which is the
   * only tidying gesture needed because the replacement is already there. */
  const updateDie = (id: string, next: Partial<DieState>, backInTray = false) => {
    setDice((current) => {
      const after = current.map((d) => (d.id === id ? { ...d, ...next } : d))
      const moved = after.find((d) => d.id === id)
      if (!moved) return after

      // Left its tray: hand out a replacement of the same kind.
      if (moved.home && !backInTray) {
        const loose = after.map((d) => (d.id === id ? { ...d, home: false } : d))
        return loose.length < MAX_DICE ? [...loose, makeDie(moved.kind)] : loose
      }
      // Put away -- but never the tray's own die, or the tray would be empty.
      if (!moved.home && backInTray) {
        return after.filter((d) => d.id !== id)
      }
      return after
    })
  }

  /** Bin a die.
   *
   * The tray is a supply and must never be empty, so binning the die that is
   * sitting in one leaves a fresh one behind rather than a hole. Binning a
   * loose die just removes it — that is the whole point of the bin. */
  const discardDie = (id: string) => {
    setDice((current) => {
      const gone = current.find((d) => d.id === id)
      const after = current.filter((d) => d.id !== id)
      if (!gone) return current
      return after.some((d) => d.kind === gone.kind && d.home)
        ? after
        : [...after, makeDie(gone.kind)]
    })
  }

  const shuffleLibrary = () => dispatch({ type: 'shuffle' })

  const nextTurn = () => dispatch({ type: 'nextTurn' })

  const makeToken = (token: DeckToken) => dispatch({ type: 'token', token })

  /* A fetch land is not a thing you tap, it is a thing you crack — so the tap
   * opens the search already narrowed to what this particular land can find,
   * rather than toggling a state the card does not really have. When the land
   * can only want one thing, it takes it without asking. */
  const crackOrAsk = (inst: Instance, finds: Fetch) => {
    const pick = obviousFetch(finds, inZone.library)
    if (pick) {
      dispatch({ type: 'crack', iid: inst.iid, pick: pick.iid })
      return
    }
    setTutoring({ fetch: { ...finds, source: inst.card.name, iid: inst.iid } })
  }

  /** A permanent on the mat, tapped. With the rules on, a source of mana taps
   *  *for* mana — into the pool, asking which kind when it could make more
   *  than one. Anything else turns sideways by hand, and so does anything at
   *  all with Shift held: the way to carry out "put it onto the battlefield
   *  tapped", or "untap target land", when the rules would rather it made
   *  mana. */
  const tap = (iid: string, byHand = false) => {
    const inst = cards.find((c) => c.iid === iid)
    if (!inst) return
    if (byHand) {
      dispatch({ type: 'tap', iid })
      return
    }
    const finds = fetchFinds(inst.card)
    const makesMana = game.rules && manaAbilities(inst, game).length > 0
    if (game.rules && (finds || makesMana) && inst.tapped) {
      setHint('Already tapped — Undo takes a tap back')
      return
    }
    if (makesMana) {
      const why = manaProblem(game, iid)
      if (why) {
        setHint(why)
        return
      }
      const options = manaOptions(game, iid)
      if (options.length === 1 && !finds) {
        dispatch({ type: 'mana', iid, ability: options[0].ability, kinds: options[0].kinds })
        return
      }
      setPickingMana({ iid, at: { x: inst.x, y: inst.y }, options })
      return
    }
    if (finds) {
      crackOrAsk(inst, finds)
      return
    }
    dispatch({ type: 'tap', iid })
  }

  const stepLoyalty = (iid: string, by: number) => dispatch({ type: 'loyalty', iid, by })

  /* What a pending choice lets you pick, where it is a choice of cards on
   * the table: how many, and which. A search or a scry is answered in its
   * own dialog instead. */
  const pending = game.rules ? game.pending : null
  const pickLimit = pending?.kind === 'bottom' || pending?.kind === 'discard' ? pending.count
    : pending?.kind === 'pick' ? pending.max
      : pending?.kind === 'attack' ? pending.options.length : 0
  const candidates = useMemo(() => new Set(
    pending?.kind === 'bottom' || pending?.kind === 'discard' ? inZone.hand.map((c) => c.iid)
      : pending?.kind === 'pick' && (pending.zone === 'hand' || pending.zone === 'battlefield') ? pending.options
        : pending?.kind === 'attack' ? pending.options
          : [],
  ), [pending, inZone.hand])

  const pick = (iid: string) => {
    if (!candidates.has(iid)) return
    setSelected((picked) => (
      picked.includes(iid) ? picked.filter((p) => p !== iid)
        // One to pick: a second click moves the choice rather than refusing it.
        : pickLimit === 1 ? [iid]
          : picked.length < pickLimit ? [...picked, iid] : picked
    ))
  }

  /** The cards a dialog offers, as it shows them. */
  const offered = (iids: readonly string[]): Offered[] => iids.flatMap((iid) => {
    const c = cards.find((x) => x.iid === iid)
    return c ? [{
      iid,
      name: c.card.name,
      cost: c.card.mana_cost,
      type: c.card.type_line,
      image: c.card.image_small ?? c.card.card_faces?.[0]?.image_uris?.small ?? null,
    }] : []
  })

  /** A card in hand, or a commander at home, clicked. With the rules on it is
   *  played if it may be and refused with the reason if not; while the game
   *  is waiting on a choice of cards, the click picks it instead. */
  const play = (iid: string) => {
    if (pending) {
      if (candidates.has(iid)) pick(iid)
      else setHint(pending.kind === 'mulligan' ? 'Keep this hand, or mulligan, first' : 'Answer the question first')
      return
    }
    if (!game.rules) {
      dispatch({ type: 'play', iid })
      return
    }
    const inst = cards.find((c) => c.iid === iid)
    if (!inst) return
    if (isLand(inst.card)) {
      const why = landProblem(game, iid)
      if (why) setHint(why)
      else dispatch({ type: 'play', iid })
      return
    }
    const check = checkCast(game, iid)
    if (check.why) {
      setHint(check.why)
      return
    }
    if (check.cost.x > 0) {
      setChoosingX({ iid, name: inst.card.name, max: largestX(game, iid) })
      return
    }
    // X that is life rather than mana: Toxic Deluge. Any amount you have.
    if (/as an additional cost to cast [^.]*, pay x life/i.test(inst.card.oracle_text ?? '')) {
      setChoosingX({ iid, name: inst.card.name, max: Math.max(0, game.life - 1) })
      return
    }
    dispatch({ type: 'play', iid })
  }

  /** Drop onto the mat: place the card where the pointer released it. A land
   *  arriving this way obeys its own enters-tapped text exactly as one
   *  clicked in hand does — see `place` in the engine. */
  const onMatDrop = (event: React.DragEvent) => {
    event.preventDefault()
    const mat = matRef.current
    const held = drag.current
    const iid = event.dataTransfer.getData('text/plain') || held?.iid
    if (!mat || !iid) return
    const rect = mat.getBoundingClientRect()
    const x = (event.clientX - rect.left - (held?.dx ?? 0)) / rect.width
    const y = (event.clientY - rect.top - (held?.dy ?? 0)) / rect.height
    dispatch({
      type: 'place',
      iid,
      at: { x: Math.min(0.97, Math.max(0, x)), y: Math.min(0.94, Math.max(0, y)) },
    })
    drag.current = null
  }

  /* The top bar is gone, and with it the last of its contents.
   *
   * It held a back button, a board reading, and once a Mulligan — all three
   * laid across a strip that runs *underneath* the app header, so everything
   * in it was visible for exactly the frame before the header painted over
   * it. That flash, and the reflow behind it, was the stutter on load.
   *
   * Nothing in it is rebuilt elsewhere. The readings it carried are already
   * on the board: the library count is printed on the deck pile you are
   * looking at, and how many lands are untapped is what untapped lands look
   * like. Leaving the mat is Escape, or the nav above.
   *
   * The mat now starts below the header rather than under it — see the
   * `--header-h` padding on `.playtest`.
   */

  /** Escape leaves the table, standing in for the back button that used to
   *  say so. Disarmed while a dialog is open, because Escape belongs to the
   *  dialog then and closing both at once would be one keypress too many. */
  useEscape(onClose, !tutoring && !zoomed)

  /* Switch the page behind off rather than trusting this layer to cover it.
   *
   * A layout effect, so it runs after the DOM is built and before the browser
   * paints: the footer is gone in the very first frame the table is drawn in,
   * not one frame later. See `:root.playtesting` in global.css. */
  useLayoutEffect(() => {
    document.documentElement.classList.add('playtesting')
    return () => document.documentElement.classList.remove('playtesting')
  }, [])

  /* Portalled to `<body>`, not rendered where the page keeps its content.
   *
   * `dissolvePage` resolves every route out of blur by putting a `filter` on
   * `<main>` for half a second. A filtered element is a containing block for
   * the fixed-position boxes inside it, so for that half second this layer's
   * `inset: 0` meant "the size of `<main>`" rather than "the size of the
   * screen" — which is why the footer showed underneath it — and it is also a
   * stacking context, so no z-index here could lift the table over the header.
   * Then the tween cleared the filter, the layer re-resolved against the
   * viewport, and everything on it moved: the stutter after the table had
   * already drawn.
   *
   * A mode that takes the whole screen has no business living inside the
   * element the page animates. Out here it is measured against the viewport
   * and nothing above it can be made to matter. */
  return createPortal(
    <div className="playtest" style={skin}>
      {/* The mat. No border, no lanes, no labels: cards sit where you put them. */}
      <div
        className="pt-mat"
        ref={matRef}
        onDragOver={(e) => e.preventDefault()}
        onDrop={onMatDrop}
      >
        {inZone.battlefield.map((c) => (
          <PlayCard
            key={c.iid} inst={c} drag={drag} onTap={tap} onZoom={setZoomed}
            onLoyalty={stepLoyalty} placed willTap={wouldTap.has(c.iid)}
            tapHint={game.rules ? ' — click to tap for mana, Shift+click to turn it by hand' : undefined}
            rules={game.rules}
            size={game.rules && isCreature(c) && (resized(c, game) || !c.card.image_normal) ? sizeLabel(c, game) : ''}
            onCounter={(iid, by) => dispatch({ type: 'counter', iid, counter: '+1/+1', by })}
            onPick={candidates.has(c.iid) ? pick : undefined}
            selected={selected.includes(c.iid)}
            attacking={game.attacking.includes(c.iid)}
            onAbilities={game.rules && abilitiesOf(c).some((a) => !a.fromHand) ? setAbilitiesFor : undefined}
          />
        ))}

        <PhaseBar
          turn={turn}
          step={game.step}
          rules={game.rules}
          pool={game.pool}
          landsPlayed={game.landsPlayed}
          landDrops={game.rules ? landDrops(game) : 1}
          opponent={game.opponent.life}
          poison={game.opponent.poison}
          onOpponent={(by) => dispatch({ type: 'opponentLife', by })}
          waiting={Boolean(game.pending)}
          onPassTo={(step) => dispatch({ type: 'passTo', step })}
          onRules={setRules}
          coverage={coverage}
          onCoverage={() => setShowCoverage(true)}
        />

        {/* The stack and the jobs left to do by hand, down the right-hand
            side under the history tab: present only while there is
            something on them. */}
        {game.rules && (game.stack.length > 0 || game.reminders.length > 0) && (
          <div className={`pt-side${showHistory ? ' beside-history' : ''}`}>
            <StackPanel
              items={game.stack.map((item) => {
                const spell = cards.find((c) => c.iid === item.iid)
                return {
                  id: item.id,
                  name: spell?.card.name ?? '?',
                  image: spell?.card.image_small ?? spell?.card.card_faces?.[0]?.image_uris?.small ?? null,
                  x: item.x,
                  ability: item.ability?.text ?? null,
                }
              })}
              onResolve={pass}
            />
            <Reminders items={game.reminders} onDone={(id) => dispatch({ type: 'done', id })} />
          </div>
        )}

        {game.rules && game.lost && game.lost !== seenLoss && (
          <div className="pt-lost" role="status">
            <span><strong>Game lost.</strong> {game.lost}. Play on, or reset.</span>
            <button className="btn btn-ghost sm" onClick={() => setSeenLoss(game.lost)}>OK</button>
          </div>
        )}

        {game.rules && game.won && game.won !== seenWin && (
          <div className="pt-lost won" role="status">
            <span><strong>Game won.</strong> {game.won}. Play on, or reset.</span>
            <button className="btn btn-ghost sm" onClick={() => setSeenWin(game.won)}>OK</button>
          </div>
        )}

        {pending && (
          <DecisionPrompt
            decision={pending}
            chosen={selected.length}
            onKeep={() => dispatch({ type: 'keep' })}
            onMulligan={() => dispatch({ type: 'mulligan' })}
            damage={pending.kind === 'attack' ? expectedDamage(game, selected) : 0}
            spent={pending.kind === 'pick' && pending.budget
              ? selected.reduce((sum, iid) => sum + (pending.budget!.cost[iid] ?? 0), 0)
              : 0}
            onAll={pending.kind === 'attack' ? () => setSelected(pending.options) : undefined}
            onConfirm={() => dispatch(pending.kind === 'attack'
              ? { type: 'attack', iids: selected }
              : { type: 'choose', iids: selected })}
            onAnswer={(yes) => dispatch({ type: 'confirm', yes })}
            onMode={(index) => dispatch({ type: 'mode', index })}
            name={pending.kind === 'type' ? cards.find((c) => c.iid === pending.iid)?.card.name : undefined}
            onType={(subtype) => dispatch({ type: 'pickType', subtype })}
            firstDraw={game.firstDraw}
            onFirstDraw={(on) => { setFirstDraw(on); dispatch({ type: 'firstDraw', on }) }}
          />
        )}

        {pending?.kind === 'number' && (
          <NumberPrompt
            prompt={pending.prompt}
            min={pending.min}
            max={pending.max}
            onChoose={(value) => dispatch({ type: 'number', value })}
          />
        )}

        {pending?.kind === 'order' && (
          <OrderPrompt
            // A new set of triggers is a new question.
            key={pending.ids.join()}
            items={pending.ids.flatMap((id) => {
              const item = game.stack.find((entry) => entry.id === id)
              const source = item && cards.find((c) => c.iid === item.iid)
              return item ? [{ id, name: source?.card.name ?? 'An ability', text: item.ability?.text ?? '' }] : []
            })}
            onOrder={(ids) => dispatch({ type: 'order', ids })}
          />
        )}

        {abilitiesFor && (() => {
          const source = cards.find((c) => c.iid === abilitiesFor)
          if (!source) return null
          // From hand, only what is used from hand — cycling; on the
          // battlefield, the rest.
          const offers = abilitiesOf(source)
            .map((ability, index) => ({ ability, index }))
            .filter(({ ability }) => ability.fromHand === (source.zone === 'hand'))
            .map(({ ability, index }) => ({
              index,
              cost: costLabel(ability),
              text: ability.text.split('~').join(source.card.name).replace(/^[^:]*:\s*/, ''),
              problem: activationProblem(game, source.iid, index),
            }))
          return (
            <AbilityMenu
              name={source.card.name}
              offers={offers}
              onActivate={(index) => {
                dispatch({ type: 'activate', iid: source.iid, index })
                setAbilitiesFor(null)
              }}
              onCancel={() => setAbilitiesFor(null)}
            />
          )
        })()}

        {choosingX && (
          <XPrompt
            name={choosingX.name}
            max={choosingX.max}
            onCast={(x) => {
              dispatch({ type: 'play', iid: choosingX.iid, x })
              setChoosingX(null)
            }}
            onCancel={() => setChoosingX(null)}
          />
        )}

        {pickingMana && (
          <ManaPicker
            options={pickingMana.options}
            at={pickingMana.at}
            onPick={(option) => {
              dispatch({ type: 'mana', iid: pickingMana.iid, ability: option.ability, kinds: option.kinds })
              setPickingMana(null)
            }}
            onSearch={(() => {
              const source = cards.find((c) => c.iid === pickingMana.iid)
              const finds = source && fetchFinds(source.card)
              if (!source || !finds) return undefined
              return () => {
                setPickingMana(null)
                crackOrAsk(source, finds)
              }
            })()}
            onCancel={() => setPickingMana(null)}
          />
        )}

        {hint && <p className="pt-hint" role="status">{hint}</p>}
        {/* The tools, stacked just above the deck: the d20, the tray the d6s
            come out of, and the coin at the bottom. Both dice trays hand out
            replacements — take one and another is waiting — so what sits here
            is a supply, not a control. The coin is the exception: it is not a
            thing you carry onto the board, it is a question you ask. */}
        <div className="pt-tools">
          {/* Above the d20 slot, so a die is carried *up* to be thrown away
              and never crosses the bin on its way to anywhere else. */}
          <div
            className={`pt-die-bin${carrying ? ' shown' : ''}${binHot ? ' hot' : ''}`}
            ref={binRef}
            aria-hidden
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
              <path d="M4 7h16M10 4h4M9 7v12M15 7v12M6 7l1 13h10l1-13" strokeLinecap="round" />
            </svg>
          </div>
          <div className="pt-die-tray d20" ref={trays.d20} aria-hidden />
          <div className="pt-die-tray d6" ref={trays.d6} aria-hidden />
          <PlayCoin face={coin} onFlip={(next) => { setCoin(next); note(`Coin: ${next}`) }} />
        </div>
        {dice.map((d) => (
          <PlayDie
            key={d.id}
            die={d}
            matRef={matRef}
            trayRef={trays[d.kind]}
            binRef={binRef}
            onDragState={(held, overBin) => { setCarrying(held); setBinHot(held && overBin) }}
            onDiscard={() => { discardDie(d.id); note(`Removed a ${d.kind}`) }}
            onChange={(next, backInTray) => updateDie(d.id, next, backInTray)}
            onRoll={(value, counting) =>
              note(counting ? `Counter at ${value}` : `Rolled ${d.kind === 'd20' ? 'a d20: ' : 'a '}${value}`)}
          />
        ))}

        {/* The record, as a drawer off the right edge. Collapsed by default:
            it answers "what just happened", which is a question you ask
            occasionally and not one worth a permanent column of the board.
            Wide when open, so a card name is one line rather than two. */}
        <div className={`pt-history-drawer ${showHistory ? 'open' : ''}`}>
          <button
            className="pt-history-tab"
            onClick={() => setShowHistory((v) => !v)}
            aria-expanded={showHistory}
            title={showHistory ? 'Hide the play history' : 'Show the play history'}
          >
            <span>History</span>
            <span className="chev" aria-hidden>{showHistory ? '›' : '‹'}</span>
          </button>
          {showHistory && (
            <div className="pt-history mono">
              {log.length
                ? log.map((line, i) => <div key={`${log.length}-${i}`}>{line}</div>)
                : <div className="faint">Nothing yet.</div>}
            </div>
          )}
        </div>

        {!inZone.battlefield.length && (
          <p className="pt-empty faint">Click a card in hand to play it, or drag it here.</p>
        )}
      </div>

      {/* Everything below the mat is one row, so the seam between the board and
          your hand is a single line across the screen rather than one per
          panel. The zones you touch are gathered at the right: the piles sit
          immediately left of the deck, the way they lie beside it on a table,
          and the corner above the deck stacks the die, the history and the
          actions in reach of the same hand. */}
      <div className="pt-tray">
        {/* The hand takes drops too: a card played by mistake, or one you want
            to pick back up, has to have a way home. */}
        <div
          className="pt-hand"
          ref={handRef}
          onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move' }}
          onDrop={(e) => {
            e.preventDefault()
            const iid = e.dataTransfer.getData('text/plain') || drag.current?.iid
            if (iid) move(iid, 'hand')
            drag.current = null
          }}
        >
          <div className="pt-cards" ref={handCardsRef}>
            {inZone.hand.map((c) => (
              <PlayCard
                key={c.iid} inst={c} drag={drag} onPlay={play} onZoom={setZoomed} splitRead
                playable={canPlay.has(c.iid)}
                selected={selected.includes(c.iid)}
                onHover={setPreviewing}
                rules={game.rules}
                onAbilities={game.rules && abilitiesOf(c).some((a) => a.fromHand) ? setAbilitiesFor : undefined}
              />
            ))}
            {!inZone.hand.length && <p className="faint" style={{ fontSize: 12 }}>Empty hand.</p>}
          </div>
        </div>

        {/* Three actions over three zones, on the same three columns.
            Shuffle is not among them — it belongs to the library, so it sits
            on the library. The buttons stretch to fill whatever height the
            deck leaves above the piles, which makes them the easiest targets
            on the screen without taking a pixel from the board. */}
        <div className="pt-zones">
          {/* Life, in the deck's own row rather than up in the bar with the
              turn counter. It is the number you reach for most and change by
              hand most often, and it belongs with the things you press, not
              with the things you read. */}
          <div className="pt-life">
            <button
              className="pt-life-step"
              onClick={() => dispatch({ type: 'life', by: -1 })}
              aria-label="Lose a life"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4">
                <path d="M6 9l6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
            <span className="pt-life-value mono">{life}</span>
            <button
              className="pt-life-step"
              onClick={() => dispatch({ type: 'life', by: 1 })}
              aria-label="Gain a life"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4">
                <path d="M6 15l6-6 6 6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          </div>

          <div className="pt-actions">
            {/* Solid: the one action here you take every single turn, and the
                only one that advances the game rather than rearranging it.
                With the rules on it passes priority, and says what that will
                do — resolve the top of the stack, or move the turn on. */}
            {game.rules ? (
              <button
                className="btn btn-primary sm"
                onClick={pass}
                disabled={Boolean(game.pending)}
                title="Pass priority (Space). The opponent passes too."
              >
                {passLabel(game)}
              </button>
            ) : (
              <button className="btn btn-primary sm" onClick={nextTurn}>Next turn</button>
            )}
            <button
              className="btn btn-ghost sm"
              onClick={() => setTutoring({})}
              disabled={!inZone.library.length}
              title="Search your library for a card"
            >
              Tutor
            </button>
            {/* Confirmed: this throws away the whole board and deals again,
                and it sits one button away from Tutor.
                Armed in place rather than behind a dialog — see resetArmed. */}
            <button
              ref={resetRef}
              className={`btn btn-danger sm pt-reset${resetArmed ? ' armed' : ''}`}
              onClick={() => (resetArmed ? resetGame() : setResetArmed(true))}
              title={resetArmed
                ? 'Press again to throw the board away'
                : 'Start the game over'}
              aria-label={resetArmed ? 'Confirm reset' : 'Reset the game'}
            >
              {resetArmed ? 'Confirm' : 'Reset'}
            </button>
          </div>

          <div className="pt-piles">
            <Pile name="graveyard" cards={inZone.graveyard} drag={drag} onMove={move} onZoom={setZoomed} />
            <Pile name="exile" cards={inZone.exile} drag={drag} onMove={move} onZoom={setZoomed} />
            <Pile
              name="command" cards={inZone.command} drag={drag} onMove={move} onPlay={play} onZoom={setZoomed}
              playable={canPlay} taxes={game.casts}
            />
          </div>
        </div>

        <div className="pt-corner">
          {/* One row, so neither costs the board any height: a row of its
              own made the tray 20px taller, and that came out of the mat. */}
          <div className="pt-corner-row">
            {/* Takes back the last thing done to the game, as Ctrl+Z does.
                Not among the turn actions: it is a step out of the game
                rather than a move in it, and it should never be what you hit
                reaching for Next turn. */}
            <button
              className="btn btn-ghost sm pt-undo"
              onClick={undo}
              disabled={!canUndo}
              title="Undo the last action (Ctrl+Z)"
            >
              Undo
            </button>
            {/* Shuffling is something you do *to the library*, so it is
                attached to the library rather than filed with the turn
                actions. */}
            <button
              className="btn btn-ghost sm pt-shuffle"
              onClick={() => shuffleLibrary()}
              disabled={inZone.library.length < 2}
              title="Shuffle the library"
            >
              Shuffle
            </button>
          </div>

          {/* The deck sits at the end of your hand, where it does on a table,
              and drawing is clicking it rather than hunting for a button. */}
          <div
            className="pt-library"
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault()
              const iid = e.dataTransfer.getData('text/plain') || drag.current?.iid
              if (iid) move(iid, 'library')
              drag.current = null
            }}
          >
            <button
              className="pt-deck"
              onClick={() => draw(1)}
              disabled={!inZone.library.length}
              /* The hover says how many are left, because the number under
                 the pile now says which turn it is. "Draw a card" was telling
                 you what clicking a deck does, which the deck already says. */
              title={inZone.library.length
                ? `${inZone.library.length} cards left`
                : 'Library is empty'}
              aria-label={`Draw a card — ${inZone.library.length} left`}
            >
              {/* Wearing this deck's sleeves, if it has any. The pile is the
                  one place in the mat you only ever see the back of a card,
                  so it is the one place sleeves can actually show. */}
              <span
                className={`pt-deck-back${sleeve ? ' sleeved' : ''}`}
                style={sleeve ? { backgroundImage: `url(${sleeve})` } : undefined}
                aria-hidden
              />
            </button>
            {/* The turn, not the card count. Which turn it is changes what
                you do next; how many cards remain almost never does, and it is
                a hover away. */}
            <span className="mono faint pt-turn">Turn {turn}</span>
          </div>
        </div>
      </div>

      {pending?.kind === 'pick' && (pending.zone === 'library' || pending.zone === 'graveyard') && (
        <PickDialog
          prompt={pending.prompt}
          cards={offered(pending.options)}
          seen={offered(pending.seen ?? [])}
          budget={pending.budget}
          min={pending.min}
          max={pending.max}
          onChoose={(iids) => dispatch({ type: 'choose', iids })}
        />
      )}

      {showCoverage && <CoverageDialog report={coverage} onClose={() => setShowCoverage(false)} />}

      {pending?.kind === 'arrange' && (
        <ArrangeDialog
          mode={pending.mode}
          cards={offered(pending.cards)}
          onDone={(keep, away) => dispatch({ type: 'arrange', keep, away })}
        />
      )}

      {tutoring && (
        <Tutor
          cards={inZone.library}
          /* Only when searching the library at large. A fetch land looks for a
             land in your deck, and no token was ever in there to be found. */
          tokens={tutoring.fetch ? [] : tokens}
          fetch={tutoring.fetch}
          onClose={() => setTutoring(null)}
          onMakeToken={(token) => {
            makeToken(token)
            setTutoring(null)
          }}
          onPick={(iid) => {
            const from = tutoring.fetch
            // A fetch does not put the land in your hand: it puts it onto the
            // battlefield, and cracks the land that went looking.
            dispatch(from && cards.some((c) => c.iid === from.iid)
              ? { type: 'crack', iid: from.iid, pick: iid }
              : { type: 'tutor', iid })
            setTutoring(null)
          }}
        />
      )}

      {zoomed && (
        <Lightbox
          src={zoomed.src}
          alt={zoomed.alt}
          from={zoomed.from}
          onClose={() => setZoomed(null)}
        />
      )}
    </div>,
    document.body,
  )
}

/**
 * Search the library.
 *
 * Sorted by name rather than left in library order, because this is the one
 * moment you are allowed to look and the deck's real order is not information
 * you should be reading off the screen. Picking a card shuffles afterwards, so
 * what you saw here does not survive the search.
 */
function Tutor({
  cards, tokens = [], fetch, onPick, onMakeToken, onClose,
}: {
  cards: Instance[]
  /** Tokens this deck can make. Empty when a fetch land opened the dialog. */
  tokens?: DeckToken[]
  onMakeToken?: (token: DeckToken) => void
  /** Set when a fetch land opened this: the search is then over what that
   *  land can find rather than over the whole library. */
  fetch?: Fetch & { source: string; iid: string }
  onPick: (iid: string) => void
  onClose: () => void
}) {
  const [needle, setNeedle] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEscape(onClose)
  // Mount only. Depending on `onClose` re-ran this on every parent render,
  // which stole the caret back to the start of whatever had been typed.
  useEffect(() => { inputRef.current?.focus() }, [])

  const term = needle.trim().toLowerCase()
  const shown = cards
    .filter((c) => !fetch || canFetch(fetch, c.card))
    .filter((c) => !term || c.card.name.toLowerCase().includes(term))
    .sort((a, b) => a.card.name.localeCompare(b.card.name))

  const shownTokens = tokens
    .filter((t) => !term || t.name.toLowerCase().includes(term))
    .sort((a, b) => a.name.localeCompare(b.name))

  return (
    <div className="modal-backdrop" onClick={onClose} role="presentation">
      <div className="modal pt-tutor" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal>
        <h3>{fetch ? `${fetch.source} — what it can find` : 'Search your library'}</h3>
        <input
          ref={inputRef}
          className="fld"
          placeholder={`Filter ${shown.length} card${shown.length === 1 ? '' : 's'}…`}
          value={needle}
          onChange={(e) => setNeedle(e.target.value)}
          aria-label="Filter library"
        />
        <div className="pt-tutor-list">
          {shown.map((c) => (
            <button key={c.iid} className="pt-tutor-row" onClick={() => onPick(c.iid)}>
              <span className="nm">{c.card.name}</span>
              <ManaCost cost={c.card.mana_cost} />
              <span className="faint">{c.card.type_line}</span>
            </button>
          ))}
          {/* Tokens are not in the library, so they are listed apart from it
              rather than mixed in. Picking one creates it on the battlefield;
              picking a card puts it in your hand. Two different verbs, so the
              heading says which is which. */}
          {shownTokens.length > 0 && (
            <>
              <p className="pt-tutor-head label">Tokens this deck makes</p>
              {shownTokens.map((t) => (
                <button
                  key={t.oracle_id}
                  className="pt-tutor-row"
                  onClick={() => onMakeToken?.(t)}
                >
                  <span className="nm">{t.name}</span>
                  {t.pt && <span className="mono faint">{t.pt}</span>}
                  <span className="faint">{t.type_line}</span>
                </button>
              ))}
            </>
          )}
          {!shown.length && !shownTokens.length && (
            <p className="faint" style={{ fontSize: 12 }}>Nothing matches.</p>
          )}
        </div>
        <div className="row gap-2" style={{ marginTop: 'var(--gap-2)' }}>
          <button className="btn btn-ghost sm" onClick={onClose}>Cancel</button>
          <span className="faint" style={{ fontSize: 11 }}>
            Taking a card shuffles the library.
          </span>
        </div>
      </div>
    </div>
  )
}

type DragRef = React.MutableRefObject<{ iid: string; dx: number; dy: number } | null>

function Pile({
  name, cards, drag, onMove, onPlay, onZoom, playable, taxes,
}: {
  name: Exclude<Zone, 'battlefield' | 'stack'>
  cards: Instance[]
  drag: DragRef
  onMove: (iid: string, zone: Exclude<Zone, 'battlefield' | 'stack'>) => void
  onPlay?: (iid: string) => void
  onZoom: (view: ZoomView) => void
  /** What may be cast from here — a commander, from the command zone. */
  playable?: ReadonlySet<string>
  /** Casts from the command zone so far, per commander: the tax. */
  taxes?: Record<string, number>
}) {
  return (
    <div
      className="pt-pile"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault()
        const iid = e.dataTransfer.getData('text/plain') || drag.current?.iid
        if (iid) onMove(iid, name)
        drag.current = null
      }}
    >
      <div className="pt-pile-head">
        <span className="label">{ZONE_LABEL[name]}</span>
        <span className="mono faint">{cards.length}</span>
      </div>
      <div className="pt-pile-body">
        {cards.slice(-3).map((c, i) => (
            <PlayCard
              key={c.iid} inst={c} drag={drag} onPlay={onPlay} onZoom={onZoom}
              style={{ marginLeft: i ? -34 : 0 }}
              playable={playable?.has(c.iid)}
              tax={2 * (taxes?.[c.iid] ?? 0)}
            />
        ))}
      </div>
    </div>
  )
}

function PlayCard({
  inst, drag, onTap, onPlay, onZoom, onLoyalty, placed, splitRead, style,
  playable, selected, willTap, tax = 0, onHover, tapHint = ' — click to tap',
  rules, onCounter, onPick, attacking, size = '', onAbilities,
}: {
  inst: Instance
  drag: DragRef
  /** `byHand` is a Shift+click: turn it sideways without it doing anything,
   *  whatever the rules would have it do. */
  onTap?: (iid: string, byHand?: boolean) => void
  /** Present in hand and the command zone: click puts it onto the battlefield. */
  onPlay?: (iid: string) => void
  onZoom: (view: ZoomView) => void
  /** Step a planeswalker's loyalty by ±1. */
  onLoyalty?: (iid: string, by: number) => void
  /** On the mat, so it is positioned absolutely. */
  placed?: boolean
  /** In hand: the card is its own two controls. See READ_ZONE. */
  splitRead?: boolean
  style?: React.CSSProperties
  /** It could be played or cast right now, and is lit to say so. */
  playable?: boolean
  /** Picked, for a pending bottom or discard. */
  selected?: boolean
  /** The tapper would tap it to pay for the card being previewed. */
  willTap?: boolean
  /** A commander's tax, shown on it while it waits at home. */
  tax?: number
  /** The pointer arrived on this card, or left it. */
  onHover?: (iid: string | null) => void
  /** What clicking it does, where that is a tap. */
  tapHint?: string
  /** The rules are on: show how much of the card plays itself. */
  rules?: boolean
  /** Add or remove a +1/+1 counter by hand. */
  onCounter?: (iid: string, by: number) => void
  /** The game is asking for a card, and this is one it could be: a click
   *  picks it, whatever a click would otherwise do. */
  onPick?: (iid: string) => void
  /** Declared as an attacker, this combat. */
  attacking?: boolean
  /** Its size as the board has it, when that is worth showing. */
  size?: string
  /** It has abilities to activate: open the menu of them. */
  onAbilities?: (iid: string) => void
}) {
  const face = useCardFace(inst.card)

  /* Lands are tapped; everything else is read.
   *
   * On the battlefield a land's whole job is to be turned sideways, over and
   * over, so its click stays the tap. A nonland is mostly there to be looked
   * at — what does this trigger, what does it cost — and hunting for a 19px
   * `i` to do the commonest thing on the board was the wrong way round. So a
   * nonland's click zooms, and tapping moves to a control of its own, big
   * enough to hit without aiming. */
  const isLand = /\bLand\b/.test(inst.card.type_line ?? '')
  const isWalker = /\bPlaneswalker\b/.test(inst.card.type_line ?? '')
  const readOnClick = Boolean(placed) && !isLand

  const zoomFrom = (event: React.MouseEvent) => {
    if (!face.src) return
    const tile = (event.currentTarget as HTMLElement).closest('.pt-card')
    if (!tile) return
    onZoom({ src: face.src, alt: face.faceName, from: tile.getBoundingClientRect() })
  }

  // A card is either somewhere it can be played from or somewhere it can be
  // tapped, never both, so one click means one thing wherever you are.
  const action = readOnClick ? undefined : onPlay ?? onTap
  const hint = readOnClick
    ? ' — click to look, ⟳ to tap'
    : splitRead ? ' — click the top to play, the bottom to read'
      : onPlay ? ' — click to play' : onTap ? tapHint : ''

  /* In hand the card is its own two controls: play from the top, read from
   * the bottom. No `i` to aim at, which in a fanned row is a 25px target
   * overlapped by the next card.
   *
   * The split is low on purpose. Playing is the commoner action and gets the
   * larger share, and the bottom of a card is the half you can still see when
   * the hand is fanned — it is also, conveniently, where the rules text is,
   * so "click the words to read the words" needs no explaining. */
  const onCardClick = (event: React.MouseEvent) => {
    if (onPick) { onPick(inst.iid); return }
    if (readOnClick) { zoomFrom(event); return }
    if (splitRead) {
      const rect = event.currentTarget.getBoundingClientRect()
      const down = (event.clientY - rect.top) / rect.height
      if (down > 1 - READ_ZONE) { zoomFrom(event); return }
    }
    if (action === onTap) onTap?.(inst.iid, event.shiftKey)
    else action?.(inst.iid)
  }

  const coverage = rules ? compile(inst.card).coverage : null
  const creature = Boolean(placed) && isCreature(inst)
  /** Counters that are not the size-changing kind, which the size shows. */
  const others = Object.entries(inst.counters ?? {})
    .filter(([kind, n]) => n > 0 && kind !== '+1/+1' && kind !== '-1/-1')

  const flags = [
    inst.tapped && 'tapped',
    (action || onPick) && 'actionable',
    onPick && 'candidate',
    attacking && 'attacking',
    playable && 'playable',
    selected && 'selected',
    willTap && 'will-tap',
    inst.sick && placed && 'sick',
  ].filter(Boolean).join(' ')

  return (
    <div
      className={`pt-card ${flags}`}
      data-iid={inst.iid}
      onMouseEnter={onHover && (() => onHover(inst.iid))}
      onMouseLeave={onHover && (() => onHover(null))}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData('text/plain', inst.iid)
        e.dataTransfer.effectAllowed = 'move'
        // A tapped card is sideways; it should be sideways while it moves too.
        solidDragImage(e, e.currentTarget as HTMLElement, { keepTransform: inst.tapped })
        // Where in the card you grabbed, so it does not snap its corner to the
        // pointer when dropped.
        const rect = e.currentTarget.getBoundingClientRect()
        drag.current = {
          iid: inst.iid,
          dx: e.clientX - rect.left,
          dy: e.clientY - rect.top,
        }
      }}
      onClick={onCardClick}
      title={`${inst.card.name}${inst.sick && placed ? ' (summoning sick)' : ''}${hint}`}
      style={placed
        ? { ...style, left: `${inst.x * 100}%`, top: `${inst.y * 100}%` }
        : style}
    >
      {face.src
        ? <img src={face.src} alt={face.faceName} loading="lazy" draggable={false} />
        : <div className="pt-fallback">{inst.card.name}</div>}

      {/* Zooms in place rather than opening the card page. Reading a card is
          something you do mid-game; leaving the table to do it would end the
          game you are in the middle of. Absent where the card itself already
          zooms on click — a second way in would be one too many. */}
      {/* How much of this card the engine carries out: all of it, some, or
          none — so a card that needs doing by hand says so before it is on
          the stack. Not on lands, which only make mana. */}
      {coverage && !isLand && (placed || splitRead) && (
        <span
          className={`pt-coverage ${coverage}`}
          title={coverage === 'auto' ? 'Plays itself'
            : coverage === 'partial' ? 'Partly automatic — the rest is posted for you to do'
              : 'By hand — its text is posted for you to do'}
        />
      )}

      {/* Its size, once the board has changed it, with its counters to hand. */}
      {creature && size && (
        <span className="pt-size mono" title={`${size}${inst.damage ? `, ${inst.damage} damage` : ''}`}>
          {size}
          {inst.damage ? <span className="pt-size-damage">−{inst.damage}</span> : null}
        </span>
      )}
      {onAbilities && (
        <button
          className="pt-act"
          title={`${inst.card.name}: abilities`}
          aria-label={`Abilities of ${inst.card.name}`}
          onClick={(e) => { e.stopPropagation(); onAbilities(inst.iid) }}
        >
          ⚡
        </button>
      )}
      {creature && rules && onCounter && (
        <span className="pt-counter-step">
          <button
            title="Remove a +1/+1 counter"
            aria-label="Remove a +1/+1 counter"
            onClick={(e) => { e.stopPropagation(); onCounter(inst.iid, -1) }}
          >−</button>
          <button
            title="Add a +1/+1 counter"
            aria-label="Add a +1/+1 counter"
            onClick={(e) => { e.stopPropagation(); onCounter(inst.iid, 1) }}
          >+</button>
        </span>
      )}
      {(others.length > 0 || inst.chosenType) && placed && (
        <span className="pt-counters mono">
          {inst.chosenType && <span title="The creature type chosen for it">{inst.chosenType}</span>}
          {others.map(([kind, n]) => <span key={kind}>{kind} {n}</span>)}
        </span>
      )}

      {/* What the commander costs on top of itself, by now. */}
      {tax > 0 && <span className="pt-tax mono" title={`Commander tax: {${tax}} more each cast`}>+{tax}</span>}

      {/* Absent in hand: the bottom of the card is the button now. */}
      {!readOnClick && !splitRead && (
        <button
          className="pt-info"
          title={`Look at ${inst.card.name}`}
          aria-label={`Look at ${inst.card.name}`}
          onClick={(event) => { event.stopPropagation(); zoomFrom(event) }}
        >
          i
        </button>
      )}

      {/* Tapping, for the cards whose click now reads them instead.
          Not on planeswalkers: they do not tap, and the corner it lives in is
          where their loyalty goes. */}
      {readOnClick && onTap && !isWalker && (
        <button
          className="pt-tap"
          title={inst.tapped ? `Untap ${inst.card.name}` : `Tap ${inst.card.name}`}
          aria-label={inst.tapped ? `Untap ${inst.card.name}` : `Tap ${inst.card.name}`}
          aria-pressed={inst.tapped}
          onClick={(event) => { event.stopPropagation(); onTap(inst.iid, event.shiftKey) }}
        >
          ⟳
        </button>
      )}

      {/* Loyalty, in the bottom-right corner the tap symbol has vacated —
          which is also the corner it is printed in on the card itself. The
          two arrows are hidden until the corner is hovered: loyalty changes a
          few times a game, and two live buttons parked on every walker would
          be two more things to misclick while dragging the card around. */}
      {/* No `stopPropagation` on pointerdown, and the container itself is
          inert — see `.pt-loyalty` in the stylesheet. Swallowing the press
          there stopped a drag ever starting in this corner, so a walker
          grabbed anywhere near its own loyalty could not be picked up and
          returned to hand. Only the two arrows take the pointer. */}
      {isWalker && placed && onLoyalty && (
        <div className="pt-loyalty">
          <button
            className="pt-loyalty-step down"
            title={`${inst.card.name}: lose a loyalty counter`}
            aria-label="Lose a loyalty counter"
            onClick={(e) => { e.stopPropagation(); onLoyalty(inst.iid, -1) }}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
              <path d="M6 9l6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>

          <span className="pt-loyalty-badge">
            <LoyaltyShield />
            <span className="n">{inst.loyalty ?? 0}</span>
          </span>

          <button
            className="pt-loyalty-step up"
            title={`${inst.card.name}: add a loyalty counter`}
            aria-label="Add a loyalty counter"
            onClick={(e) => { e.stopPropagation(); onLoyalty(inst.iid, 1) }}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
              <path d="M6 15l6-6 6 6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </div>
      )}

      {face.flippable && (
        <button
          className="pt-flip"
          title={`Turn over — showing ${face.faceName}`}
          aria-label="Turn card over"
          onClick={(e) => { e.stopPropagation(); face.flip() }}
        >
          ⟳
        </button>
      )}
    </div>
  )
}
