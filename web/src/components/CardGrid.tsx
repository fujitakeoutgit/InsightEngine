import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import type { Card } from '../lib/api'
import { collection, useIsCollected } from '../lib/collection'
import { attachTilt, dissolveIn } from '../lib/motion'
import { useCardFace } from '../lib/faces'
import { FlipButton } from './FlipButton'
import { IdentityDots, ManaCost } from './ManaCost'

function money(value: number | null) {
  return value === null || value === undefined ? '—' : `$${value.toFixed(2)}`
}

/** Opens a per-card menu at the click point instead of navigating. */
export type CardPick = (card: Card, at: { x: number; y: number }) => void

function CollectButton({ card }: { card: Card }) {
  const held = useIsCollected(card.oracle_id)
  return (
    <button
      className={`collect-btn ${held ? 'held' : ''}`}
      title={held ? 'Remove from Cards' : 'Add to Cards'}
      aria-label={held ? `Remove ${card.name} from Cards` : `Add ${card.name} to Cards`}
      onClick={(event) => {
        // The tile is a link; collecting must not navigate.
        event.preventDefault()
        event.stopPropagation()
        collection.toggle(card)
      }}
    >
      {held ? '✓' : '+'}
    </button>
  )
}

function CardTile({
  card, collectable, caption, onPick,
}: { card: Card; collectable: boolean; caption?: string; onPick?: CardPick }) {
  const ref = useRef<HTMLAnchorElement>(null)
  const [loaded, setLoaded] = useState(false)
  const { flippable, faceName, src: image, flip } = useCardFace(card)

  useEffect(() => {
    if (!ref.current) return
    return attachTilt(ref.current)
  }, [])

  return (
    <Link
      ref={ref}
      to={`/card/${card.oracle_id}`}
      className="card-tile"
      // With a picker attached the tile opens a menu instead of navigating;
      // Info is one of the menu's own entries, so nothing becomes unreachable.
      onClick={onPick && ((event) => {
        event.preventDefault()
        onPick(card, { x: event.clientX, y: event.clientY })
      })}
      title={
        caption
          ? `${card.name} — ${card.type_line ?? ''}\n${caption}`
          : `${card.name} — ${card.type_line ?? ''}`
      }
    >
      {collectable && <CollectButton card={card} />}
      {flippable && <FlipButton onFlip={flip} faceName={faceName} />}
      {image ? (
        <img
          src={image}
          alt={faceName}
          loading="lazy"
          decoding="async"
          className={loaded ? 'loaded' : ''}
          onLoad={() => setLoaded(true)}
        />
      ) : (
        <div className="fallback">
          <div>
            <div className="nm">{card.name}</div>
            <ManaCost cost={card.mana_cost} />
          </div>
          <div className="tl">{card.type_line}</div>
        </div>
      )}
      <span className="price mono">{money(card.usd)}</span>
    </Link>
  )
}

function CardRow({ card, onPick }: { card: Card; onPick?: CardPick }) {
  const navigate = useNavigate()
  const held = useIsCollected(card.oracle_id)
  return (
    <tr
      onClick={(event) =>
        onPick
          ? onPick(card, { x: event.clientX, y: event.clientY })
          : navigate(`/card/${card.oracle_id}`)
      }
    >
      <td>
        <button
          className="btn btn-ghost sm"
          title={held ? 'Remove from Cards' : 'Add to Cards'}
          onClick={(event) => {
            event.stopPropagation()
            collection.toggle(card)
          }}
        >
          {held ? '✓' : '+'}
        </button>
      </td>
      <td className="nm">
        <Link to={`/card/${card.oracle_id}`} onClick={(e) => e.stopPropagation()}>
          {card.name}
        </Link>
      </td>
      <td>
        <ManaCost cost={card.mana_cost} />
      </td>
      <td className="muted">{card.type_line}</td>
      <td>
        <IdentityDots identity={card.color_identity} />
      </td>
      <td className="muted mono">{card.set_code?.toUpperCase()}</td>
      <td className="num">{money(card.usd)}</td>
    </tr>
  )
}

export function CardGrid({
  cards,
  view = 'grid',
  size = 190,
  collectable = true,
  captionFor,
  onPick,
}: {
  cards: Card[]
  view?: 'grid' | 'list'
  /** Minimum tile width in px, driven by the size slider. */
  size?: number
  collectable?: boolean
  /** Extra hover text per card — used to keep recommendation reasons visible
   *  in image view, where there is no room to print them. */
  captionFor?: (card: Card) => string | undefined
  /** When set, clicking a card opens a menu here rather than navigating. */
  onPick?: CardPick
}) {
  const container = useRef<HTMLDivElement>(null)

  // Layout effect so the reveal starts from the pre-animation state and the
  // grid is never briefly visible at full opacity first.
  useLayoutEffect(() => {
    if (!container.current) return
    const items = container.current.querySelectorAll(
      view === 'grid' ? '.card-tile' : 'tbody tr',
    )
    dissolveIn(items, { stagger: view === 'grid' ? 0.026 : 0.012 })
  }, [cards, view])

  if (view === 'list') {
    return (
      <div className="scroll-x" ref={container}>
        <table className="card-list">
          <thead>
            <tr>
              <th />
              <th>Name</th>
              <th>Cost</th>
              <th>Type</th>
              <th>ID</th>
              <th>Set</th>
              <th style={{ textAlign: 'right' }}>USD</th>
            </tr>
          </thead>
          <tbody>
            {cards.map((card) => (
              <CardRow key={card.oracle_id} card={card} onPick={onPick} />
            ))}
          </tbody>
        </table>
      </div>
    )
  }

  return (
    <div
      className="card-grid"
      ref={container}
      style={{ ['--card-w' as string]: `${size}px` }}
    >
      {cards.map((card) => (
        <CardTile
          key={card.oracle_id}
          card={card}
          collectable={collectable}
          caption={captionFor?.(card)}
          onPick={onPick}
        />
      ))}
    </div>
  )
}

export function GridSkeleton({ count = 12, size = 190 }: { count?: number; size?: number }) {
  return (
    <div className="card-grid" style={{ ['--card-w' as string]: `${size}px` }} aria-hidden>
      {Array.from({ length: count }, (_, i) => (
        <div className="skeleton" key={i} />
      ))}
    </div>
  )
}
