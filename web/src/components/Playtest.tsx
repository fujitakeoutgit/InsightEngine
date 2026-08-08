import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { useCardFace } from '../lib/faces'
import { entersTapped } from '../lib/landTiming'
import { useEscape } from '../lib/usePersisted'
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
  const matRef = useRef<HTMLDivElement>(null)
  /** One tray per kind. A die at home is placed from its own tray's measured
   *  box, which is the only way to land exactly inside an outline that
   *  flexbox positioned. */
  const trays = {
    d6: useRef<HTMLDivElement>(null),
    d20: useRef<HTMLDivElement>(null),
  }
  const handRef = useRef<HTMLDivElement>(null)

  /** The in-flight drag: which card, and where in it you grabbed. Kept in a
   *  ref because dataTransfer only yields its payload on drop, and the grab
   *  offset is needed to stop cards jumping to their corner. */
  const drag = useRef<{ iid: string; dx: number; dy: number } | null>(null)
  /** Cards drawn by the last action, so only they animate in. */
  const [entering, setEntering] = useState<string[]>([])
  const [zoomed, setZoomed] = useState<ZoomView | null>(null)
  const [tutoring, setTutoring] = useState(false)

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

  const move = (iid: string, zone: Zone, at?: { x: number; y: number }) => {
    setCards((cs) => cs.map((c) => (
      c.iid === iid
        ? { ...c, zone, tapped: zone === 'battlefield' ? c.tapped : false, ...(at ?? {}) }
        : c
    )))
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

  const tap = (iid: string) =>
    setCards((cs) => cs.map((c) => (c.iid === iid ? { ...c, tapped: !c.tapped } : c)))

  /** Play a card: instants and sorceries resolve to the graveyard, permanents
   *  are dealt into the region their type belongs to. */
  const play = (iid: string) => {
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
    // Filled left to right, then wrapped. Cards are only *dealt* here -- drag
    // one anywhere you like once it is down.
    const n = inZone.battlefield.filter(
      (c) => regionFor(c.card.type_line ?? '') === name,
    ).length
    const at = {
      x: region.x + (n % region.cols) * region.dx,
      y: region.y + Math.floor(n / region.cols) * region.dy,
    }

    /* Lands may arrive tapped, and which ones depends on the board you have
     * built by now. Working it out here saves the one piece of bookkeeping a
     * goldfish otherwise gets wrong every time -- a check land coming down
     * untapped on turn four is the whole reason it is in the deck. */
    const verdict = entersTapped(
      inst.card,
      inZone.battlefield.map((c) => c.card),
      inZone.hand.filter((c) => c.iid !== iid).map((c) => c.card),
    )
    setCards((cs) => cs.map((c) => (
      c.iid === iid ? { ...c, zone: 'battlefield' as Zone, tapped: verdict.tapped, ...at } : c
    )))

    const because = verdict.why ? ` — ${verdict.why}` : ''
    note(verdict.tapped
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
    move(iid, 'battlefield', {
      x: Math.min(0.97, Math.max(0, x)),
      y: Math.min(0.94, Math.max(0, y)),
    })
    drag.current = null
  }

  const lands = inZone.battlefield.filter((c) => /\bLand\b/.test(c.card.type_line ?? ''))
  const untappedLands = lands.filter((c) => !c.tapped).length

  return (
    <div className="playtest">
      <div className="pt-bar">
        <button className="back-link" onClick={onClose}>← Back to deck</button>
        <span className="mono">Turn {turn}</span>
        <span className="mono">
          Life{' '}
          <button className="row-act" onClick={() => setLife((l) => l - 1)}>−</button>
          {life}
          <button className="row-act" onClick={() => setLife((l) => l + 1)}>+</button>
        </span>
        <span className="mono faint">
          {inZone.library.length} in library · {untappedLands}/{lands.length} lands untapped
        </span>

        {/* Next turn and Reset moved to the corner beside the deck, with
            Shuffle and Tutor. What stays here is what has no home down there:
            drawing, which is otherwise a click on the deck itself, and the two
            that act on the whole board. */}
        <div className="push row gap-2 wrap">
          <button className="btn sm" onClick={() => draw(1)} disabled={!inZone.library.length}>
            Draw
          </button>
          <button className="btn btn-ghost sm" onClick={untapAll}>Untap all</button>
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
            key={c.iid} inst={c} drag={drag} onTap={tap} onZoom={setZoomed} placed
          />
        ))}
        {/* The tools, stacked just above the deck: the d20, the tray the d6s
            come out of, and the coin at the bottom. Both dice trays hand out
            replacements — take one and another is waiting — so what sits here
            is a supply, not a control. The coin is the exception: it is not a
            thing you carry onto the board, it is a question you ask. */}
        <div className="pt-tools">
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
          <div className="pt-actions">
            {/* Solid: the one action here you take every single turn, and the
                only one that advances the game rather than rearranging it. */}
            <button className="btn btn-primary sm" onClick={nextTurn}>Next turn</button>
            <button
              className="btn btn-ghost sm"
              onClick={() => setTutoring(true)}
              disabled={!inZone.library.length}
              title="Search your library for a card"
            >
              Tutor
            </button>
            <button className="btn btn-ghost sm" onClick={() => newGame(0)}>Reset</button>
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
              title={inZone.library.length ? 'Draw a card' : 'Library is empty'}
              aria-label={`Draw a card — ${inZone.library.length} left`}
            >
              <span className="pt-deck-back" aria-hidden />
            </button>
            <span className="mono faint">{inZone.library.length}</span>
          </div>
        </div>
      </div>

      {tutoring && (
        <Tutor
          cards={inZone.library}
          onClose={() => setTutoring(false)}
          onPick={(iid) => {
            move(iid, 'hand')
            // Searching your library shuffles it. Skipping that would leave the
            // order you just read still in place, which is not the same game.
            shuffleLibrary(true)
            const found = cards.find((c) => c.iid === iid)
            note(`Tutored ${found?.card.name ?? 'a card'}, then shuffled`)
            setTutoring(false)
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
  cards, onPick, onClose,
}: {
  cards: Instance[]
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
    .filter((c) => !term || c.card.name.toLowerCase().includes(term))
    .sort((a, b) => a.card.name.localeCompare(b.card.name))

  return (
    <div className="modal-backdrop" onClick={onClose} role="presentation">
      <div className="modal pt-tutor" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal>
        <h3>Search your library</h3>
        <input
          ref={inputRef}
          className="fld"
          placeholder={`Filter ${cards.length} cards…`}
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
  inst, drag, onTap, onPlay, onZoom, placed, style,
}: {
  inst: Instance
  drag: DragRef
  onTap?: (iid: string) => void
  /** Present in hand and the command zone: click puts it onto the battlefield. */
  onPlay?: (iid: string) => void
  onZoom: (view: ZoomView) => void
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

      {/* Tapping, for the cards whose click now reads them instead. */}
      {readOnClick && onTap && (
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
