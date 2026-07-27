import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { Card } from '../lib/api'
import { canAnimate, gsap } from '../lib/motion'
import { primaryType, type DeckCard } from '../lib/deckModel'

type Zone = 'library' | 'hand' | 'battlefield' | 'graveyard' | 'exile' | 'command'

interface Instance {
  iid: string
  card: Card
  zone: Zone
  tapped: boolean
}

const ZONE_LABEL: Record<Zone, string> = {
  library: 'Library', hand: 'Hand', battlefield: 'Battlefield',
  graveyard: 'Graveyard', exile: 'Exile', command: 'Command',
}

/**
 * Where a permanent sits on the battlefield.
 *
 * The order is how a table is actually laid out from the player's side:
 * creatures forward where combat happens, other permanents behind them, lands
 * at the back. `primaryType` already resolves the awkward cases -- an Artifact
 * Land is a land, an Artifact Creature is a creature.
 */
type Lane = 'creatures' | 'permanents' | 'lands'

const LANES: { key: Lane; label: string }[] = [
  { key: 'creatures', label: 'Creatures' },
  { key: 'permanents', label: 'Other permanents' },
  { key: 'lands', label: 'Lands' },
]

function laneOf(card: Card): Lane {
  const type = primaryType(card)
  if (type === 'Land') return 'lands'
  if (type === 'Creature') return 'creatures'
  return 'permanents'
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

function build(deck: DeckCard[]): Instance[] {
  let n = 0
  const out: Instance[] = []
  for (const entry of deck) {
    if (entry.section === 'sideboard' || entry.section === 'maybeboard') continue
    for (let i = 0; i < entry.quantity; i++) {
      out.push({
        iid: `pi${++n}`,
        card: entry.card,
        zone: entry.section === 'commander' ? 'command' : 'library',
        tapped: false,
      })
    }
  }
  return out
}

/**
 * Goldfish simulator.
 *
 * Deliberately not a rules engine: it shuffles, draws, and lets you move cards
 * between zones and tap them. Nothing is enforced or prevented, which is the
 * point — you are testing whether the deck *does things*, not adjudicating a
 * game. London mulligan, because that is the one that changes how you keep.
 */
export function Playtest({ deck, onClose }: { deck: DeckCard[]; onClose: () => void }) {
  const [cards, setCards] = useState<Instance[]>([])
  const [turn, setTurn] = useState(1)
  const [life, setLife] = useState(40)
  const [mulligans, setMulligans] = useState(0)
  const [toBottom, setToBottom] = useState(0)
  const [log, setLog] = useState<string[]>([])
  const handRef = useRef<HTMLDivElement>(null)

  const note = useCallback((line: string) => setLog((l) => [line, ...l].slice(0, 40)), [])

  const newGame = useCallback((mullCount = 0) => {
    const pool = shuffle(build(deck))
    const library = pool.filter((c) => c.zone === 'library')
    const command = pool.filter((c) => c.zone === 'command')
    const hand = library.slice(0, 7).map((c) => ({ ...c, zone: 'hand' as Zone }))
    const rest = library.slice(7)
    setCards([...command, ...hand, ...rest])
    setTurn(1)
    setMulligans(mullCount)
    setToBottom(mullCount)
    note(mullCount ? `Mulligan to ${7 - mullCount} — put ${mullCount} on the bottom` : 'New game, 7 cards')
  }, [deck, note])

  useEffect(() => { newGame(0) }, [newGame])

  const inZone = useMemo(() => {
    const map: Record<Zone, Instance[]> = {
      library: [], hand: [], battlefield: [], graveyard: [], exile: [], command: [],
    }
    for (const card of cards) map[card.zone].push(card)
    return map
  }, [cards])

  const move = (iid: string, zone: Zone) => {
    setCards((cs) => cs.map((c) => (c.iid === iid ? { ...c, zone, tapped: false } : c)))
  }

  const draw = (count = 1) => {
    setCards((cs) => {
      const library = cs.filter((c) => c.zone === 'library')
      const taking = new Set(library.slice(0, count).map((c) => c.iid))
      return cs.map((c) => (taking.has(c.iid) ? { ...c, zone: 'hand' } : c))
    })
    note(count === 1 ? 'Drew a card' : `Drew ${count} cards`)
  }

  // New hands animate in; the reveal is how you notice the hand changed.
  useEffect(() => {
    if (!handRef.current || !canAnimate()) return
    const tiles = handRef.current.querySelectorAll('.pt-card')
    if (!tiles.length) return
    gsap.fromTo(tiles,
      { opacity: 0, y: 22, rotateX: -28, filter: 'blur(10px)' },
      { opacity: 1, y: 0, rotateX: 0, filter: 'blur(0px)', duration: 0.55,
        ease: 'power3.out', stagger: { amount: 0.28 } },
    )
  }, [inZone.hand.length, mulligans])

  const untapAll = () => {
    setCards((cs) => cs.map((c) => (c.zone === 'battlefield' ? { ...c, tapped: false } : c)))
  }

  const nextTurn = () => {
    untapAll()
    setTurn((t) => t + 1)
    draw(1)
    note(`Turn ${turn + 1}`)
  }

  const tap = (iid: string) =>
    setCards((cs) => cs.map((c) => (c.iid === iid ? { ...c, tapped: !c.tapped } : c)))

  /** Play a card from hand or the command zone. It goes to the battlefield
   *  lane its own type dictates, so this needs no target. Instants and
   *  sorceries resolve to the graveyard: they never sit on a battlefield, and
   *  leaving one there quietly inflates the board you are reading. */
  const play = (iid: string) => {
    const inst = cards.find((c) => c.iid === iid)
    if (!inst) return
    const spell = /\b(Instant|Sorcery)\b/.test(inst.card.type_line ?? '')
    move(iid, spell ? 'graveyard' : 'battlefield')
    note(spell ? `Cast ${inst.card.name}` : `Played ${inst.card.name}`)
  }

  const lands = inZone.battlefield.filter((c) => primaryType(c.card) === 'Land')
  const untappedLands = lands.filter((c) => !c.tapped).length

  return (
    <div className="playtest">
      <div className="pt-bar">
        <span className="label">Playtest</span>
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
          <button className="btn btn-ghost sm" onClick={onClose}>Close</button>
        </div>
      </div>

      {toBottom > 0 && (
        <p className="pt-hint mono">
          London mulligan — put {toBottom} card{toBottom > 1 ? 's' : ''} from hand on the
          bottom (click ↓ Library), then play on.
        </p>
      )}

      <div className="pt-zones">
        <div
          className="pt-zone battlefield"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault()
            const iid = e.dataTransfer.getData('text/plain')
            if (iid) move(iid, 'battlefield')
          }}
        >
          <div className="pt-zone-head">
            <span className="label">Battlefield</span>
            <span className="mono faint">{inZone.battlefield.length}</span>
          </div>
          {/* One lane per kind of permanent. A card lands in the right lane by
              its own type, so playing it never asks you where to put it. */}
          {LANES.map(({ key, label }) => {
            const inLane = inZone.battlefield.filter((c) => laneOf(c.card) === key)
            return (
              <div className={`pt-lane ${key}`} key={key}>
                <span className="pt-lane-label label">
                  {label} <b className="mono faint">{inLane.length}</b>
                </span>
                <div className="pt-cards">
                  {inLane.map((c) => (
                    <PlayCard key={c.iid} inst={c} onMove={move} onTap={tap} />
                  ))}
                  {!inLane.length && <p className="faint drop-hint">—</p>}
                </div>
              </div>
            )
          })}
        </div>

        <Zone name="command" cards={inZone.command} onMove={move} onPlay={play} />
        <div className="pt-row">
          <Zone name="graveyard" cards={inZone.graveyard} onMove={move} compact />
          <Zone name="exile" cards={inZone.exile} onMove={move} compact />
        </div>
      </div>

      <div className="pt-hand" ref={handRef}>
        <div className="pt-zone-head">
          <span className="label">Hand</span>
          <span className="mono faint">{inZone.hand.length}</span>
          <span className="faint" style={{ fontSize: 10.5 }}>click to play</span>
        </div>
        <div className="pt-cards">
          {inZone.hand.map((c) => (
            <PlayCard key={c.iid} inst={c} onMove={move} onPlay={play} inHand />
          ))}
          {!inZone.hand.length && <p className="faint" style={{ fontSize: 12 }}>Empty hand.</p>}
        </div>
      </div>

      {log.length > 0 && (
        <div className="pt-log mono">
          {log.slice(0, 5).map((line, i) => <div key={i}>{line}</div>)}
        </div>
      )}
    </div>
  )
}

function Zone({
  name, cards, onMove, onTap, onPlay, compact,
}: {
  name: Zone
  cards: Instance[]
  onMove: (iid: string, zone: Zone) => void
  onTap?: (iid: string) => void
  onPlay?: (iid: string) => void
  compact?: boolean
}) {
  return (
    <div
      className={`pt-zone ${compact ? 'compact' : ''}`}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault()
        const iid = e.dataTransfer.getData('text/plain')
        if (iid) onMove(iid, name)
      }}
    >
      <div className="pt-zone-head">
        <span className="label">{ZONE_LABEL[name]}</span>
        <span className="mono faint">{cards.length}</span>
      </div>
      <div className="pt-cards">
        {cards.map((c) => (
          <PlayCard key={c.iid} inst={c} onMove={onMove} onTap={onTap} onPlay={onPlay} />
        ))}
        {!cards.length && <p className="faint drop-hint">Drop here</p>}
      </div>
    </div>
  )
}

function PlayCard({
  inst, onMove, onTap, onPlay, inHand,
}: {
  inst: Instance
  onMove: (iid: string, zone: Zone) => void
  onTap?: (iid: string) => void
  /** Present in hand and the command zone: click puts it onto the battlefield. */
  onPlay?: (iid: string) => void
  inHand?: boolean
}) {
  const image = inst.card.image_normal ?? inst.card.image_small
  // A card is either somewhere it can be played from or somewhere it can be
  // tapped, never both, so one click means one thing wherever you are.
  const action = onPlay ?? onTap
  const hint = onPlay ? ' — click to play' : onTap ? ' — click to tap' : ''

  return (
    <div
      className={`pt-card ${inst.tapped ? 'tapped' : ''} ${action ? 'actionable' : ''}`}
      draggable
      onDragStart={(e) => e.dataTransfer.setData('text/plain', inst.iid)}
      onClick={() => action?.(inst.iid)}
      title={`${inst.card.name}${hint}`}
    >
      {image
        ? <img src={image} alt={inst.card.name} loading="lazy" />
        : <div className="pt-fallback">{inst.card.name}</div>}
      <div className="pt-acts">
        {inHand && (
          <button onClick={(e) => { e.stopPropagation(); onMove(inst.iid, 'library') }} title="Bottom of library">↓</button>
        )}
        <button onClick={(e) => { e.stopPropagation(); onMove(inst.iid, 'graveyard') }} title="Graveyard">✝</button>
      </div>
    </div>
  )
}
