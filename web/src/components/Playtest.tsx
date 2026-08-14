import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { useCardFace } from '../lib/faces'
import { entersTapped } from '../lib/landTiming'
import { useEscape } from '../lib/usePersisted'
import { sleeveFor } from '../lib/sleeves'
import { readCoinSkin, readD20Skin, readDieSkin, skinVars } from '../lib/skins'
import { solidDragImage } from '../lib/useQuietDrag'
import { Lightbox } from './Lightbox'
import { ManaCost } from './ManaCost'
import { PlayCoin, type CoinFace } from './PlayCoin'

import { PlayDie } from './PlayDie'
import { canAnimate, gsap } from '../lib/motion'
import { type DeckCard } from '../lib/deckModel'
import {
  deckSignature, makeDie, MAX_DICE, recallGame, rememberGame,
  type DieState, type Instance, type Zone,
} from '../lib/playtestCache'

/** A card being looked at, and the rect it grew from. */
interface ZoomView {
  src: string
  alt: string
  from: DOMRect
}

const BASIC_TYPES = ['Plains', 'Island', 'Swamp', 'Mountain', 'Forest']

/** What a fetch land can go and get, or null if this is not one.
 *
 * Read off the oracle text rather than kept as a list of card names, because
 * the list is long, it grows every set, and the text already says exactly what
 * the card can find — "search your library for a Plains or Island card" names
 * its own two types. `types` empty means it is unrestricted by subtype, which
 * is Evolving Wilds and friends: any basic, or any land at all.
 */
function fetchFinds(card: { type_line?: string | null; oracle_text?: string | null }) {
  if (!/\bLand\b/.test(card.type_line ?? '')) return null
  const text = card.oracle_text ?? ''
  /* The whole clause, not just up to the first "card". Krosan Verge fetches
   * "a Forest card and a Plains card", and stopping at the first one offered
   * you half of what the land actually finds. Cut at the "put …"/"then …"
   * that follows, so the tail of the sentence cannot contribute type names. */
  const said = /search your library for (.+?)(?:,\s*(?:put|then)\b|\.)/i.exec(text)
  if (!said) return null
  const phrase = said[1]
  if (!/\bland\b/i.test(phrase) && !BASIC_TYPES.some((t) => new RegExp(`\\b${t}\\b`, 'i').test(phrase))) {
    return null
  }
  return {
    types: BASIC_TYPES.filter((t) => new RegExp(`\\b${t}\\b`, 'i').test(phrase)),
    basicOnly: /\bbasic\b/i.test(phrase),
    /** The fetch says so itself — Terramorphic Expanse and nearly all of its
     *  kin put what they find onto the battlefield tapped. */
    tapped: /onto the battlefield tapped/i.test(text),
    /** Cracking it costs it. Nearly always true, but Krosan Verge-style lands
     *  that tap instead exist, so it is read rather than assumed. */
    sacrifices: /\bsacrifice\b/i.test(text),
  }
}

type Fetch = NonNullable<ReturnType<typeof fetchFinds>>

/** Is this card something the fetch is allowed to find?
 *
 * Subtypes are matched against the type line, which is where a Tundra keeps
 * its Plains and its Island — the reason a fetch finds duals at all, and the
 * reason this is not a filter on the word "basic". */
function canFetch(fetch: Fetch, card: { type_line?: string | null }) {
  const line = card.type_line ?? ''
  if (!/\bLand\b/.test(line)) return false
  if (fetch.basicOnly && !/\bBasic\b/.test(line)) return false
  if (!fetch.types.length) return true
  return fetch.types.some((t) => new RegExp(`\\b${t}\\b`).test(line))
}

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

/** A planeswalker's printed starting loyalty, or null if it is not one.
 *
 * Scryfall gives loyalty as a string because some of them are not numbers --
 * X on Chandra, Awakened Inferno, and the double-faced walkers that print it
 * on the back only. Those come back as 0 and are then yours to set. */
function startingLoyalty(card: { type_line?: string | null; loyalty?: string | null }) {
  if (!/\bPlaneswalker\b/.test(card.type_line ?? '')) return null
  const printed = Number.parseInt(card.loyalty ?? '', 10)
  return Number.isFinite(printed) ? printed : 0
}

const ZONE_LABEL: Record<Zone, string> = {
  library: 'Library', hand: 'Hand', battlefield: 'Battlefield',
  graveyard: 'Graveyard', exile: 'Exile', command: 'Command',
}

/**
 * Where a permanent is dealt, as fractions of the mat.
 *
 * The left two thirds is the board proper -- creatures and planeswalkers up
 * top where combat happens, lands along the bottom where you tap them. The
 * right third holds artifacts and enchantments, which sit to one side and are
 * rarely touched once they are down. Nothing is enforced: this is only where a
 * card *lands*, and dragging it elsewhere is always allowed.
 */
const REGIONS = {
  creatures: { x: 0.02, y: 0.03, dx: 0.105, dy: 0.20, cols: 6 },
  lands: { x: 0.02, y: 0.52, dx: 0.105, dy: 0.20, cols: 6 },
  sides: { x: 0.68, y: 0.03, dx: 0.105, dy: 0.20, cols: 3 },
} as const

/** Land wins over Creature, so an Artifact Land is a land and an Artifact
 *  Creature is a creature. */
function regionFor(line: string): keyof typeof REGIONS {
  if (/\bLand\b/.test(line)) return 'lands'
  if (/\b(Creature|Planeswalker|Battle)\b/.test(line)) return 'creatures'
  return 'sides'
}

/** Fisher-Yates. A biased shuffle would quietly invalidate every draw. */
function shuffle<T>(items: T[]): T[] {
  const out = [...items]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

/** Expand quantities into individual copies. */
function build(deck: DeckCard[]): Instance[] {
  const out: Instance[] = []
  for (const entry of deck) {
    if (entry.section === 'sideboard' || entry.section === 'maybeboard') continue
    for (let i = 0; i < entry.quantity; i++) {
      out.push({
        iid: `${entry.uid}-${i}`,
        card: entry.card,
        zone: entry.section === 'commander' ? 'command' : 'library',
        tapped: false,
        x: 0.5,
        y: 0.5,
        ...(startingLoyalty(entry.card) !== null
          ? { loyalty: startingLoyalty(entry.card) as number }
          : {}),
      })
    }
  }
  return out
}

/**
 * Goldfishing.
 *
 * Deliberately not a rules engine: it shuffles, draws, and lets you move cards
 * around and tap them. Nothing is enforced or prevented, which is the point --
 * you are checking whether the deck does anything, not adjudicating a game.
 *
 * The battlefield is a bare playmat rather than a set of labelled lanes. A real
 * table has no lines on it, and where you put a permanent carries meaning that
 * a layout algorithm cannot guess: attackers pushed forward, an untapped
 * blocker held back, a combo lined up in a corner.
 */
export function Playtest({
  deck, gameKey, onClose,
}: {
  deck: DeckCard[]
  /** Which deck's game this is, so closing and reopening resumes it. */
  gameKey: string
  onClose: () => void
}) {
  const signature = useMemo(() => deckSignature(deck), [deck])
  /** The deck's sleeves, if it has been given any. Read once: sleeves are
   *  changed in the Deck Lab, not mid-game. */
  const [sleeve] = useState(() => sleeveFor(gameKey))
  /** The chosen dice and coin finishes, as custom properties on this mat.
   *  Read once: skins are changed in Settings, not mid-game. */
  const [skin] = useState(() => skinVars(readDieSkin(), readD20Skin(), readCoinSkin()))
  // Read once, at mount. An effect would re-read under StrictMode's double
  // invocation and could observe what this component had itself just written.
  const [resumed] = useState(() => recallGame(gameKey, signature))

  const [cards, setCards] = useState<Instance[]>(resumed?.cards ?? [])
  const [turn, setTurn] = useState(resumed?.turn ?? 1)
  const [life, setLife] = useState(resumed?.life ?? 40)
  const [mulligans, setMulligans] = useState(resumed?.mulligans ?? 0)
  const [log, setLog] = useState<string[]>(resumed?.log ?? [])
  /* Dice and the coin start fresh every time the mat is opened. They are what
   * is on the table right now rather than what the game is, so they are not
   * part of what a resumed game restores. */
  const [dice, setDice] = useState<DieState[]>(() => [makeDie('d20'), makeDie('d6')])
  const [coin, setCoin] = useState<CoinFace>('heads')
  const [showHistory, setShowHistory] = useState(false)
  const [confirmingReset, setConfirmingReset] = useState(false)
  useEscape(() => setConfirmingReset(false), confirmingReset)
  const matRef = useRef<HTMLDivElement>(null)
  /** One tray per kind. A die at home is placed from its own tray's measured
   *  box, which is the only way to land exactly inside an outline that
   *  flexbox positioned. */
  const trays = {
    d6: useRef<HTMLDivElement>(null),
    d20: useRef<HTMLDivElement>(null),
  }
  const handRef = useRef<HTMLDivElement>(null)
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
  /** Cards drawn by the last action, so only they animate in. */
  const [entering, setEntering] = useState<string[]>([])
  const [zoomed, setZoomed] = useState<ZoomView | null>(null)
  /** The library search. `fetch` is set when a fetch land opened it, and
   *  narrows the list to what that land is actually allowed to find. */
  const [tutoring, setTutoring] = useState<
    null | { fetch?: Fetch & { source: string; iid: string } }
  >(null)

  const note = useCallback((line: string) => setLog((l) => [line, ...l].slice(0, 40)), [])

  const newGame = useCallback((mull = 0) => {
    const pool = shuffle(build(deck))
    const library = pool.filter((c) => c.zone === 'library')
    const command = pool.filter((c) => c.zone === 'command')
    const hand = library.slice(0, 7).map((c) => ({ ...c, zone: 'hand' as Zone }))
    const rest = library.slice(7)
    setCards([...command, ...hand, ...rest])
    setTurn(1)
    setLife(40)
    setMulligans(mull)
    setEntering(hand.map((c) => c.iid))
    setLog([mull ? `Mulligan to ${7 - mull}` : 'New game — drew 7'])
  }, [deck])

  // Only when there is nothing to come back to. Editing the deck changes its
  // signature, so a stale board is discarded rather than resumed as if it
  // still described the deck.
  useEffect(() => {
    if (resumed) return
    newGame(0)
  }, [resumed, newGame])

  // Written on every change rather than on the way out: unmount is too late to
  // read state in an effect cleanup that has closed over an older render, and
  // this is cheap -- a Map assignment against state React has already built.
  useEffect(() => {
    rememberGame(gameKey, { cards, turn, life, mulligans, log, signature })
  }, [gameKey, signature, cards, turn, life, mulligans, log])

  const inZone = useMemo(() => {
    const map: Record<Zone, Instance[]> = {
      library: [], hand: [], battlefield: [], graveyard: [], exile: [], command: [],
    }
    for (const card of cards) map[card.zone].push(card)
    return map
  }, [cards])

  const move = (
    iid: string, zone: Zone, at?: { x: number; y: number }, tapped?: boolean,
  ) => {
    setCards((cs) => cs.map((c) => {
      if (c.iid !== iid) return c
      /* Leaving the battlefield resets a planeswalker's loyalty to its
       * printed number. Counters do not travel with a card between zones —
       * the walker that comes back is a new object, and one returning from
       * the graveyard on three loyalty because that is where it died would
       * be quietly wrong every time. */
      const reset = zone !== 'battlefield' && startingLoyalty(c.card) !== null
        ? { loyalty: startingLoyalty(c.card) as number }
        : {}
      return {
        ...c, zone,
        tapped: zone === 'battlefield' ? (tapped ?? c.tapped) : false,
        ...reset, ...(at ?? {}),
      }
    }))
  }

  const draw = (count = 1) => {
    let drawn: string[] = []
    setCards((cs) => {
      const library = cs.filter((c) => c.zone === 'library')
      drawn = library.slice(0, count).map((c) => c.iid)
      const taking = new Set(drawn)
      return cs.map((c) => (taking.has(c.iid) ? { ...c, zone: 'hand' } : c))
    })
    // Only the new cards animate. Re-revealing the whole hand every turn made
    // it impossible to see which card had actually arrived.
    setEntering(drawn)
    note(count === 1 ? 'Drew a card' : `Drew ${count} cards`)
  }

  useEffect(() => {
    if (!handRef.current || !entering.length || !canAnimate()) return
    const tiles = entering
      .map((iid) => handRef.current!.querySelector(`[data-iid="${iid}"]`))
      .filter(Boolean) as Element[]
    if (!tiles.length) return
    gsap.fromTo(tiles,
      { opacity: 0, y: 26, rotateX: -30, filter: 'blur(10px)' },
      { opacity: 1, y: 0, rotateX: 0, filter: 'blur(0px)', duration: 0.5,
        ease: 'power3.out', stagger: { amount: 0.22 } },
    )
  }, [entering])

  const untapAll = () =>
    setCards((cs) => cs.map((c) => (c.zone === 'battlefield' ? { ...c, tapped: false } : c)))

  /* Dice come out of a tray rather than there being exactly one of them.
   *
   * Moving the tray die away leaves the tray empty, so a fresh one takes its
   * place -- you reach for a die and there is always a die to reach for.
   * Dropping a loose one back on the tray puts it away again, which is the
   * only tidying gesture needed because the replacement is already there. */
  /** Start over: a fresh deal *and* the dice swept back into their trays.
   *
   * Mulligan deliberately does not do the second part -- it is still the same
   * game, and a die you set down to track something is still tracking it. */
  const resetGame = () => {
    setConfirmingReset(false)
    setDice([makeDie('d20'), makeDie('d6')])
    setCoin('heads')
    newGame(0)
  }

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

  /** Reorder the library in place.
   *
   * The library's order *is* its array order, so the shuffled sequence is
   * poured back into the slots the library cards already occupy. Rebuilding the
   * whole list would move the other zones around too, and the battlefield's
   * order is the order things were played. */
  const shuffleLibrary = (silent = false) => {
    setCards((cs) => {
      const shuffled = shuffle(cs.filter((c) => c.zone === 'library'))
      let next = 0
      return cs.map((c) => (c.zone === 'library' ? shuffled[next++] : c))
    })
    if (!silent) note('Shuffled the library')
  }

  const nextTurn = () => {
    untapAll()
    setTurn((t) => t + 1)
    draw(1)
    note(`Turn ${turn + 1}`)
  }

  /** Crack a fetch: the land it found arrives (tapped, if the fetch said so),
   *  the fetch itself is sacrificed, and the library is shuffled. Doing only
   *  the search left the fetch sitting on the battlefield having paid nothing
   *  and the land arriving untapped, which is two pieces of bookkeeping wrong
   *  in the one place the goldfish was supposed to get them right. */
  const crack = (source: Instance, pickedIid: string, finds: Fetch) => {
    const found = cards.find((c) => c.iid === pickedIid)
    /* The land takes the square the fetch is vacating. Only when the fetch
     * actually leaves, though: one that taps instead of sacrificing is still
     * standing there, so its seat is not going spare and the land is dealt a
     * fresh one. A second card from the same fetch takes the next free square
     * on its own, because `play` counts the board live. */
    const seat = finds.sacrifices ? { x: source.x, y: source.y } : undefined
    play(pickedIid, finds.tapped, seat)
    if (finds.sacrifices) move(source.iid, 'graveyard')
    shuffleLibrary(true)
    note(`${source.card.name}: found ${found?.card.name ?? 'a land'}${
      finds.sacrifices ? ', sacrificed' : ''}, then shuffled`)
  }

  const tap = (iid: string) => {
    /* A fetch land is not a thing you tap, it is a thing you crack — so the
     * tap opens the search already narrowed to what this particular land can
     * find, rather than toggling a state the card does not really have. */
    const inst = cards.find((c) => c.iid === iid)
    const finds = inst && fetchFinds(inst.card)
    if (inst && finds) {
      /* Named exactly one type — "search your library for a Forest card" —
       * so there is no decision to hand over. Take one and get on with it;
       * a picker offering you a choice you do not have is just a click. A
       * basic is preferred over a dual carrying the same subtype, which is
       * what "fetch a Forest" means when you say it out loud. */
      const options = inZone.library.filter((c) => canFetch(finds, c.card))
      if (finds.types.length === 1 && options.length) {
        const basicFirst = [...options].sort((a, b) =>
          Number(/\bBasic\b/.test(b.card.type_line ?? '')) -
          Number(/\bBasic\b/.test(a.card.type_line ?? '')))
        crack(inst, basicFirst[0].iid, finds)
        return
      }
      setTutoring({ fetch: { ...finds, source: inst.card.name, iid: inst.iid } })
      return
    }
    setCards((cs) => cs.map((c) => (c.iid === iid ? { ...c, tapped: !c.tapped } : c)))
  }

  /** Step a planeswalker's loyalty. Floored at zero — a walker on nought is
   *  already gone, and negative loyalty is not a state the game has. */
  const stepLoyalty = (iid: string, by: number) =>
    setCards((cs) => cs.map((c) => (
      c.iid === iid ? { ...c, loyalty: Math.max(0, (c.loyalty ?? 0) + by) } : c
    )))

  /** Play a card: instants and sorceries resolve to the graveyard, permanents
   *  are dealt into the region their type belongs to. */
  const play = (iid: string, forceTapped = false, seat?: { x: number; y: number }) => {
    const inst = cards.find((c) => c.iid === iid)
    if (!inst) return
    const line = inst.card.type_line ?? ''

    // Instants and sorceries resolve and are done; they never sit on a
    // battlefield, and leaving one there inflates the board you are reading.
    if (/\b(Instant|Sorcery)\b/.test(line)) {
      move(iid, 'graveyard')
      note(`Cast ${inst.card.name}`)
      return
    }

    const name = regionFor(line)
    const region = REGIONS[name]

    /* Lands may arrive tapped, and which ones depends on the board you have
     * built by now. Working it out here saves the one piece of bookkeeping a
     * goldfish otherwise gets wrong every time -- a check land coming down
     * untapped on turn four is the whole reason it is in the deck. */
    const verdict = entersTapped(
      inst.card,
      inZone.battlefield.map((c) => c.card),
      inZone.hand.filter((c) => c.iid !== iid).map((c) => c.card),
    )
    /* `forceTapped` is the fetch land talking: "put it onto the battlefield
     * tapped" is an instruction from the card that found it, and it overrides
     * what the land would have done arriving under its own steam. */
    const tapped = forceTapped || verdict.tapped
    setCards((cs) => {
      /* The slot is counted here, inside the updater, against the board as it
       * stands *now* rather than as it stood when this render happened.
       *
       * Cracking a fetch plays a land and sacrifices the fetch in the same
       * tick. Counting from the render's snapshot gave both of them the same
       * answer, so a two-card fetch dealt its second land exactly on top of
       * its first. Counting from `cs` means each play sees the one before it.
       *
       * `seat` is the square the card is told to take: a fetch hands over the
       * one it is vacating, so the land arrives where the fetch stood instead
       * of at the end of the row. Cards are only *dealt* here — drag one
       * anywhere you like once it is down. */
      const taken = cs.filter((c) => (
        c.zone === 'battlefield' && c.iid !== iid &&
        regionFor(c.card.type_line ?? '') === name
      ))
      const free = seat ?? {
        x: region.x + (taken.length % region.cols) * region.dx,
        y: region.y + Math.floor(taken.length / region.cols) * region.dy,
      }
      return cs.map((c) => (
        c.iid === iid ? { ...c, zone: 'battlefield' as Zone, tapped, ...free } : c
      ))
    })

    const because = forceTapped ? '' : verdict.why ? ` — ${verdict.why}` : ''
    note(tapped
      ? `Played ${inst.card.name} tapped${because}`
      : `Played ${inst.card.name}${because}`)
  }

  /** Drop onto the mat: place the card where the pointer released it. */
  const onMatDrop = (event: React.DragEvent) => {
    event.preventDefault()
    const mat = matRef.current
    const held = drag.current
    const iid = event.dataTransfer.getData('text/plain') || held?.iid
    if (!mat || !iid) return
    const rect = mat.getBoundingClientRect()
    const x = (event.clientX - rect.left - (held?.dx ?? 0)) / rect.width
    const y = (event.clientY - rect.top - (held?.dy ?? 0)) / rect.height
    /* A land dragged onto the mat has to obey its own text.
     *
     * Only `play` consulted `entersTapped`, so a land *clicked* in hand came
     * down tapped when it should and a land *dragged* to the same place came
     * down untapped — same card, same board, different answer depending on
     * which gesture you happened to use. Rootbound Crag with no Mountain and
     * no Forest was the report; every check land, shock land and fast land had
     * it too.
     *
     * Only when it is arriving. Nudging a permanent that is already on the
     * battlefield must not re-roll its tapped state. */
    const inst = cards.find((c) => c.iid === iid)
    const arriving = inst && inst.zone !== 'battlefield'
    const verdict = arriving
      ? entersTapped(
          inst.card,
          inZone.battlefield.map((c) => c.card),
          inZone.hand.filter((c) => c.iid !== iid).map((c) => c.card),
        )
      : null

    move(iid, 'battlefield', {
      x: Math.min(0.97, Math.max(0, x)),
      y: Math.min(0.94, Math.max(0, y)),
    }, verdict ? verdict.tapped : undefined)

    if (verdict?.tapped && inst) {
      note(`Played ${inst.card.name} tapped${verdict.why ? ` — ${verdict.why}` : ''}`)
    }
    drag.current = null
  }

  const lands = inZone.battlefield.filter((c) => /\bLand\b/.test(c.card.type_line ?? ''))
  const untappedLands = lands.filter((c) => !c.tapped).length

  return (
    <div className="playtest" style={skin}>
      <div className="pt-bar">
        <button className="back-link" onClick={onClose}>← Back to deck</button>
        {/* The turn lives under the deck now, beside Next turn — the control
            that changes it. Two of them disagreed about which was the real
            one. What is left here is the board reading you glance at rather
            than act on. */}
        <span className="mono faint">
          {inZone.library.length} in library · {untappedLands}/{lands.length} lands untapped
        </span>

        {/* Next turn and Reset live in the corner beside the deck, with
            Shuffle and Tutor. Only Mulligan stays here.

            Draw and Untap all are deliberately absent. Drawing is a click on
            the deck, which is where a player already looks for it, and a
            button doing the same thing twice is just a second place to check.
            Untapping is what Next turn is for; a standalone untap button is
            not a step anyone takes on its own. */}
        <div className="push row gap-2 wrap">
          <button
            className="btn btn-ghost sm"
            onClick={() => newGame(Math.min(6, mulligans + 1))}
            title="London mulligan: draw 7, put N on the bottom"
          >
            Mulligan {mulligans > 0 && `(${7 - mulligans})`}
          </button>
        </div>
      </div>

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
            onLoyalty={stepLoyalty} placed
          />
        ))}
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
          <div className="pt-cards">
            {inZone.hand.map((c) => (
              <PlayCard key={c.iid} inst={c} drag={drag} onPlay={play} onZoom={setZoomed} />
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
              onClick={() => setLife((l) => l - 1)}
              aria-label="Lose a life"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4">
                <path d="M6 9l6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
            <span className="pt-life-value mono">{life}</span>
            <button
              className="pt-life-step"
              onClick={() => setLife((l) => l + 1)}
              aria-label="Gain a life"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4">
                <path d="M6 15l6-6 6 6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          </div>

          <div className="pt-actions">
            {/* Solid: the one action here you take every single turn, and the
                only one that advances the game rather than rearranging it. */}
            <button className="btn btn-primary sm" onClick={nextTurn}>Next turn</button>
            <button
              className="btn btn-ghost sm"
              onClick={() => setTutoring({})}
              disabled={!inZone.library.length}
              title="Search your library for a card"
            >
              Tutor
            </button>
            {/* Confirmed, unlike Mulligan: this throws away the whole board,
                not just the hand, and it sits one button away from Tutor. */}
            {/* Red, matching the button it opens: it is the one control here
                that throws the whole board away. */}
            <button className="btn btn-danger sm" onClick={() => setConfirmingReset(true)}>
              Reset
            </button>
          </div>

          <div className="pt-piles">
            <Pile name="graveyard" cards={inZone.graveyard} drag={drag} onMove={move} onZoom={setZoomed} />
            <Pile name="exile" cards={inZone.exile} drag={drag} onMove={move} onZoom={setZoomed} />
            <Pile name="command" cards={inZone.command} drag={drag} onMove={move} onPlay={play} onZoom={setZoomed} />
          </div>
        </div>

        <div className="pt-corner">
          {/* Shuffling is something you do *to the library*, so it is attached
              to the library rather than filed with the turn actions. */}
          <button
            className="btn btn-ghost sm pt-shuffle"
            onClick={() => shuffleLibrary()}
            disabled={inZone.library.length < 2}
            title="Shuffle the library"
          >
            Shuffle
          </button>

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

      {confirmingReset && (
        <div className="modal-backdrop" onClick={() => setConfirmingReset(false)} role="presentation">
          <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal>
            <h3>Reset the game?</h3>
            <p className="muted">
              The board, your hand, the graveyard and the dice all go back to the start.
              A new seven is dealt from a fresh shuffle.
            </p>
            <div className="row gap-2" style={{ marginTop: 'var(--gap-3)' }}>
              <button className="btn btn-danger sm" onClick={resetGame}>Reset</button>
              <button className="btn btn-ghost sm" onClick={() => setConfirmingReset(false)}>
                Keep playing
              </button>
            </div>
          </div>
        </div>
      )}

      {tutoring && (
        <Tutor
          cards={inZone.library}
          fetch={tutoring.fetch}
          onClose={() => setTutoring(null)}
          onPick={(iid) => {
            const from = tutoring.fetch
            const source = from && cards.find((c) => c.iid === from.iid)
            if (from && source) {
              // A fetch does not put the land in your hand: it puts it onto
              // the battlefield, and cracks the land that went looking.
              crack(source, iid, from)
              setTutoring(null)
              return
            }
            move(iid, 'hand')
            // Searching your library shuffles it. Skipping that would leave the
            // order you just read still in place, which is not the same game.
            shuffleLibrary(true)
            const found = cards.find((c) => c.iid === iid)
            note(`Tutored ${found?.card.name ?? 'a card'}, then shuffled`)
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
    </div>
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
  cards, fetch, onPick, onClose,
}: {
  cards: Instance[]
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
          {!shown.length && <p className="faint" style={{ fontSize: 12 }}>Nothing matches.</p>}
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
  name, cards, drag, onMove, onPlay, onZoom,
}: {
  name: Zone
  cards: Instance[]
  drag: DragRef
  onMove: (iid: string, zone: Zone, at?: { x: number; y: number }) => void
  onPlay?: (iid: string) => void
  onZoom: (view: ZoomView) => void
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
            />
        ))}
      </div>
    </div>
  )
}

function PlayCard({
  inst, drag, onTap, onPlay, onZoom, onLoyalty, placed, style,
}: {
  inst: Instance
  drag: DragRef
  onTap?: (iid: string) => void
  /** Present in hand and the command zone: click puts it onto the battlefield. */
  onPlay?: (iid: string) => void
  onZoom: (view: ZoomView) => void
  /** Step a planeswalker's loyalty by ±1. */
  onLoyalty?: (iid: string, by: number) => void
  /** On the mat, so it is positioned absolutely. */
  placed?: boolean
  style?: React.CSSProperties
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
    : onPlay ? ' — click to play' : onTap ? ' — click to tap' : ''

  return (
    <div
      className={`pt-card ${inst.tapped ? 'tapped' : ''} ${action ? 'actionable' : ''}`}
      data-iid={inst.iid}
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
      onClick={(event) => (readOnClick ? zoomFrom(event) : action?.(inst.iid))}
      title={`${inst.card.name}${hint}`}
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
      {!readOnClick && (
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
          onClick={(event) => { event.stopPropagation(); onTap(inst.iid) }}
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
