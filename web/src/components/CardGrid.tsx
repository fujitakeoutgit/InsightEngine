import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import type { Card } from '../lib/api'
import { attachTilt, dissolveIn } from '../lib/motion'
import { IdentityDots, ManaCost } from './ManaCost'

function money(value: number | null) {
  return value === null || value === undefined ? '—' : `$${value.toFixed(2)}`
}

function CardTile({ card }: { card: Card }) {
  const ref = useRef<HTMLAnchorElement>(null)
  const [loaded, setLoaded] = useState(false)
  const image = card.image_normal ?? card.image_small

  useEffect(() => {
    if (!ref.current) return
    return attachTilt(ref.current)
  }, [])

  return (
    <Link
      ref={ref}
      to={`/card/${card.oracle_id}`}
      className="card-tile"
      title={`${card.name} — ${card.type_line ?? ''}`}
    >
      {image ? (
        <img
          src={image}
          alt={card.name}
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

function CardRow({ card }: { card: Card }) {
  const navigate = useNavigate()
  return (
    <tr onClick={() => navigate(`/card/${card.oracle_id}`)}>
      <td className="nm">
        <Link to={`/card/${card.oracle_id}`}>{card.name}</Link>
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
  dense = false,
}: {
  cards: Card[]
  view?: 'grid' | 'list'
  dense?: boolean
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
              <CardRow key={card.oracle_id} card={card} />
            ))}
          </tbody>
        </table>
      </div>
    )
  }

  return (
    <div className={`card-grid ${dense ? 'dense' : ''}`} ref={container}>
      {cards.map((card) => (
        <CardTile key={card.oracle_id} card={card} />
      ))}
    </div>
  )
}

export function GridSkeleton({ count = 12 }: { count?: number }) {
  return (
    <div className="card-grid" aria-hidden>
      {Array.from({ length: count }, (_, i) => (
        <div className="skeleton" key={i} />
      ))}
    </div>
  )
}
