import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { Card } from '../lib/api'
import { useCardFace } from '../lib/faces'
import { canAnimate, gsap } from '../lib/motion'
import { type DeckCard } from '../lib/deckModel'

type Zone = 'library' | 'hand' | 'battlefield' | 'graveyard' | 'exile' | 'command'

interface Instance {
  iid: string
  card: Card
  zone: Zone
  tapped: boolean
  /** Position on the playmat, as a fraction of its size. Only meaningful on
   *  the battlefield; kept as fractions so the board survives a resize. */
  x: number
  y: number
}

const ZONE_LABEL: Record<Zone, string> = {
  library: 'Library', hand: 'Hand', battlefield: 'Battlefield',
  graveyard: 'Graveyard', exile: 'Exile', command: 'Command',
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
export function Playtest({ deck, onClose }: { deck: DeckCard[]; onClose: () => void }) {
  const [cards, setCards] = useState<Instance[]>([])
  const [turn, setTurn] = useState(1)
  const [life, setLife] = useState(40)
  const [mulligans, setMulligans] = useState(0)
  const [log, setLog] = useState<string[]>([])
  const matRef = useRef<HTMLDivElement>(null)
  const handRef = useRef<HTMLDivElement>(null)

  /** The in-flight drag: which card, and where in it you grabbed. Kept in a
   *  ref because dataTransfer only yields its payload on drop, and the grab
   *  offset is needed to stop cards jumping to their corner. */
  const drag = useRef<{ iid: string; dx: number; dy: number } | null>(null)
  /** Cards drawn by the last action, so only they animate in. */
  const [entering, setEntering] = useState<string[]>([])

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

  useEffect(() => { newGame(0) }, [newGame])

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

  const nextTurn = () => {
    untapAll()
    setTurn((t) => t + 1)
    draw(1)
    note(`Turn ${turn + 1}`)
  }

  const tap = (iid: string) =>
    setCards((cs) => cs.map((c) => (c.iid === iid ? { ...c, tapped: !c.tapped } : c)))

  /** Play a card. Instants and sorceries resolve to the graveyard: they never
   *  sit on a battlefield, and leaving one there inflates the board you are
   *  reading. Everything else lands where the mat is free. */
  const play = (iid: string) => {
    const inst = cards.find((c) => c.iid === iid)
    if (!inst) return
    if (/\b(Instant|Sorcery)\b/.test(inst.card.type_line ?? '')) {
      move(iid, 'graveyard')
      note(`Cast ${inst.card.name}`)
      return
    }
    // Dealt left-to-right in rows so a clicked card does not land on the last
    // one; drag it wherever you actually want it.
    const n = inZone.battlefield.length
    move(iid, 'battlefield', { x: 0.07 + (n % 8) * 0.11, y: 0.16 + Math.floor(n / 8) * 0.26 })
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
  const toBottom = Math.max(0, inZone.hand.length - (7 - mulligans))

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

        <div className="push row gap-2 wrap">
          <button className="btn sm" onClick={() => draw(1)} disabled={!inZone.library.length}>
            Draw
          </button>
          <button className="btn sm" onClick={nextTurn}>Next turn</button>
          <button className="btn btn-ghost sm" onClick={untapAll}>Untap all</button>
          <button
            className="btn btn-ghost sm"
            onClick={() => newGame(Math.min(6, mulligans + 1))}
            title="London mulligan: draw 7, put N on the bottom"
          >
            Mulligan {mulligans > 0 && `(${7 - mulligans})`}
          </button>
          <button className="btn btn-ghost sm" onClick={() => newGame(0)}>Reset</button>
        </div>
      </div>

      {toBottom > 0 && (
        <p className="pt-hint mono">
          London mulligan — put {toBottom} card{toBottom > 1 ? 's' : ''} from hand on the
          bottom (drag to Library), then play on.
        </p>
      )}

      {/* The mat. No border, no lanes, no labels: cards sit where you put them. */}
      <div
        className="pt-mat"
        ref={matRef}
        onDragOver={(e) => e.preventDefault()}
        onDrop={onMatDrop}
      >
        {inZone.battlefield.map((c) => (
          <PlayCard
            key={c.iid} inst={c} drag={drag} onTap={tap} placed
          />
        ))}
        {!inZone.battlefield.length && (
          <p className="pt-empty faint">Click a card in hand to play it, or drag it here.</p>
        )}
      </div>

      <div className="pt-piles">
        <Pile name="command" cards={inZone.command} drag={drag} onMove={move} onPlay={play} />
        <Pile name="graveyard" cards={inZone.graveyard} drag={drag} onMove={move} />
        <Pile name="exile" cards={inZone.exile} drag={drag} onMove={move} />
        <Pile name="library" cards={inZone.library} drag={drag} onMove={move} facedown />
      </div>

      <div className="pt-hand" ref={handRef}>
        <div className="pt-cards">
          {inZone.hand.map((c) => (
            <PlayCard key={c.iid} inst={c} drag={drag} onPlay={play} />
          ))}
          {!inZone.hand.length && <p className="faint" style={{ fontSize: 12 }}>Empty hand.</p>}
        </div>
      </div>

      {log.length > 0 && (
        <div className="pt-log mono">
          {log.slice(0, 4).map((line, i) => <div key={i}>{line}</div>)}
        </div>
      )}
    </div>
  )
}

type DragRef = React.MutableRefObject<{ iid: string; dx: number; dy: number } | null>

function Pile({
  name, cards, drag, onMove, onPlay, facedown,
}: {
  name: Zone
  cards: Instance[]
  drag: DragRef
  onMove: (iid: string, zone: Zone, at?: { x: number; y: number }) => void
  onPlay?: (iid: string) => void
  facedown?: boolean
}) {
  return (
    <div
      className={`pt-pile ${facedown ? 'facedown' : ''}`}
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
        {facedown
          ? <div className="pt-back" aria-hidden />
          : cards.slice(-3).map((c, i) => (
            <PlayCard
              key={c.iid} inst={c} drag={drag} onPlay={onPlay}
              style={{ marginLeft: i ? -34 : 0 }}
            />
          ))}
      </div>
    </div>
  )
}

function PlayCard({
  inst, drag, onTap, onPlay, placed, style,
}: {
  inst: Instance
  drag: DragRef
  onTap?: (iid: string) => void
  /** Present in hand and the command zone: click puts it onto the battlefield. */
  onPlay?: (iid: string) => void
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
        ? <img src={face.src} alt={face.faceName} loading="lazy" />
        : <div className="pt-fallback">{inst.card.name}</div>}

      {/* A new tab: navigating away would end the game. */}
      <a
        className="pt-info"
        href={`/card/${inst.card.oracle_id}`}
        target="_blank"
        rel="noreferrer noopener"
        title={`Open ${inst.card.name}`}
        aria-label={`Open ${inst.card.name}`}
        onClick={(e) => e.stopPropagation()}
      >
        i
      </a>

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
