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
        <Zone name="battlefield" cards={inZone.battlefield} onMove={move} onTap={(iid) =>
          setCards((cs) => cs.map((c) => (c.iid === iid ? { ...c, tapped: !c.tapped } : c)))
        } />
        <Zone name="command" cards={inZone.command} onMove={move} />
        <div className="pt-row">
          <Zone name="graveyard" cards={inZone.graveyard} onMove={move} compact />
          <Zone name="exile" cards={inZone.exile} onMove={move} compact />
        </div>
      </div>

      <div className="pt-hand" ref={handRef}>
        <div className="pt-zone-head">
          <span className="label">Hand</span>
          <span className="mono faint">{inZone.hand.length}</span>
        </div>
        <div className="pt-cards">
          {inZone.hand.map((c) => (
            <PlayCard key={c.iid} inst={c} onMove={move} inHand />
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
  name, cards, onMove, onTap, compact,
}: {
  name: Zone
  cards: Instance[]
  onMove: (iid: string, zone: Zone) => void
  onTap?: (iid: string) => void
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
          <PlayCard key={c.iid} inst={c} onMove={onMove} onTap={onTap} />
        ))}
        {!cards.length && <p className="faint drop-hint">Drop here</p>}
      </div>
    </div>
  )
}

function PlayCard({
  inst, onMove, onTap, inHand,
}: {
  inst: Instance
  onMove: (iid: string, zone: Zone) => void
  onTap?: (iid: string) => void
  inHand?: boolean
}) {
  const image = inst.card.image_normal ?? inst.card.image_small
  return (
    <div
      className={`pt-card ${inst.tapped ? 'tapped' : ''}`}
      draggable
      onDragStart={(e) => e.dataTransfer.setData('text/plain', inst.iid)}
      onClick={() => onTap?.(inst.iid)}
      title={`${inst.card.name}${onTap ? ' — click to tap' : ''}`}
    >
      {image
        ? <img src={image} alt={inst.card.name} loading="lazy" />
        : <div className="pt-fallback">{inst.card.name}</div>}
      <div className="pt-acts">
        {inHand && (
          <>
            <button onClick={(e) => { e.stopPropagation(); onMove(inst.iid, 'battlefield') }} title="Play">▲</button>
            <button onClick={(e) => { e.stopPropagation(); onMove(inst.iid, 'library') }} title="Bottom of library">↓</button>
          </>
        )}
        <button onClick={(e) => { e.stopPropagation(); onMove(inst.iid, 'graveyard') }} title="Graveyard">✝</button>
      </div>
    </div>
  )
}
