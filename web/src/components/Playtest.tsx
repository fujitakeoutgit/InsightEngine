import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { useCardFace } from '../lib/faces'
import { useEscape } from '../lib/usePersisted'
import { solidDragImage } from '../lib/useQuietDrag'
import { Lightbox } from './Lightbox'
import { ManaCost } from './ManaCost'
import { PlayDie } from './PlayDie'
import { canAnimate, gsap } from '../lib/motion'
import { type DeckCard } from '../lib/deckModel'
import {
  deckSignature, INITIAL_DIE, recallGame, rememberGame,
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
  const [die, setDie] = useState<DieState>(resumed?.die ?? INITIAL_DIE)
  const matRef = useRef<HTMLDivElement>(null)
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
    rememberGame(gameKey, { cards, turn, life, mulligans, log, die, signature })
  }, [gameKey, signature, cards, turn, life, mulligans, log, die])

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
    move(iid, 'battlefield', {
      x: region.x + (n % region.cols) * region.dx,
      y: region.y + Math.floor(n / region.cols) * region.dy,
    })
    note(`Played ${inst.card.name}`)
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
        {/* The die is a thing on the table, not a control beside it: it lives
            in the mat's coordinate space so it can be thrown across the board
            and left wherever it lands. */}
        <PlayDie
          die={die}
          matRef={matRef}
          onChange={(next) => setDie((d) => ({ ...d, ...next }))}
          onRoll={(value, counting) =>
            note(counting ? `Counter at ${value}` : `Rolled a ${value}`)}
        />

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

        <div className="pt-piles">
          <Pile name="graveyard" cards={inZone.graveyard} drag={drag} onMove={move} onZoom={setZoomed} />
          <Pile name="exile" cards={inZone.exile} drag={drag} onMove={move} onZoom={setZoomed} />
          <Pile name="command" cards={inZone.command} drag={drag} onMove={move} onPlay={play} onZoom={setZoomed} />
        </div>

        <div className="pt-corner">
          {/* Floated above the deck rather than stacked on top of it in flow.
              These three would otherwise add their own height to the tray and
              take it off the battlefield, which is the part of this screen
              worth having. Transparent to the pointer except where a control
              actually is, so the mat underneath still takes drops. */}
          <div className="pt-corner-top">
          <div className="pt-actions">
            <button className="btn btn-ghost sm" onClick={nextTurn}>Next turn</button>
            <button
              className="btn btn-ghost sm"
              onClick={() => shuffleLibrary()}
              disabled={inZone.library.length < 2}
              title="Shuffle the library"
            >
              Shuffle
            </button>
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

          {/* The history sits between the actions and the die because that is
              where it is read from: it is the record of what those buttons and
              that die just did. */}
          <div className="pt-history mono">
            {log.slice(0, 5).map((line, i) => <div key={`${log.length}-${i}`}>{line}</div>)}
          </div>

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
  // A card is either somewhere it can be played from or somewhere it can be
  // tapped, never both, so one click means one thing wherever you are.
  const action = onPlay ?? onTap
  const hint = onPlay ? ' — click to play' : onTap ? ' — click to tap' : ''

  return (
    <div
      className={`pt-card ${inst.tapped ? 'tapped' : ''} ${action ? 'actionable' : ''}`}
      data-iid={inst.iid}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData('text/plain', inst.iid)
        e.dataTransfer.effectAllowed = 'move'
        solidDragImage(e, e.currentTarget as HTMLElement)
        // Where in the card you grabbed, so it does not snap its corner to the
        // pointer when dropped.
        const rect = e.currentTarget.getBoundingClientRect()
        drag.current = {
          iid: inst.iid,
          dx: e.clientX - rect.left,
          dy: e.clientY - rect.top,
        }
      }}
      onClick={() => action?.(inst.iid)}
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
          game you are in the middle of. */}
      <button
        className="pt-info"
        title={`Look at ${inst.card.name}`}
        aria-label={`Look at ${inst.card.name}`}
        onClick={(event) => {
          event.stopPropagation()
          if (face.src) {
            onZoom({ src: face.src, alt: face.faceName, from: event.currentTarget
              .closest('.pt-card')!.getBoundingClientRect() })
          }
        }}
      >
        i
      </button>

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
