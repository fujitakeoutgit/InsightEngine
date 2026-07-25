import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'

import { collection, useCollection } from '../lib/collection'
import { CardGrid } from '../components/CardGrid'

const SIZE_KEY = 'insight-enigma:card-size'

/** Cards collected from search results with the hover [x] button. */
export function CardsPage() {
  const cards = useCollection()
  const [view, setView] = useState<'grid' | 'list'>('grid')
  const [size, setSize] = useState(() => Number(localStorage.getItem(SIZE_KEY)) || 190)

  const totals = useMemo(() => {
    const priced = cards.filter((c) => c.usd !== null && c.usd !== undefined)
    return {
      value: priced.reduce((sum, c) => sum + (c.usd ?? 0), 0),
      unpriced: cards.length - priced.length,
    }
  }, [cards])

  const copyList = () => {
    navigator.clipboard?.writeText(cards.map((c) => `1 ${c.name}`).join('\n'))
  }

  return (
    <section className="shell" style={{ paddingTop: 22 }}>
      <div className="section-head">
        <div>
          <span className="eyebrow">Collected</span>
          <h2>Cards</h2>
        </div>
        <div className="row gap-2 wrap">
          <span className="mono muted" style={{ fontSize: 12 }}>
            {cards.length} card{cards.length === 1 ? '' : 's'} · ${totals.value.toFixed(2)}
            {totals.unpriced > 0 && ` · ${totals.unpriced} unpriced`}
          </span>
          {cards.length > 0 && (
            <>
              {view === 'grid' && (
                <label className="size-slider" title="Card size">
                  <span className="label">Size</span>
                  <input
                    type="range" min={110} max={340} step={10} value={size}
                    onChange={(e) => setSize(Number(e.target.value))}
                    aria-label="Card image size"
                  />
                </label>
              )}
              <button className="btn btn-ghost sm" onClick={() => setView(view === 'grid' ? 'list' : 'grid')}>
                {view === 'grid' ? 'List' : 'Grid'}
              </button>
              <button className="btn btn-ghost sm" onClick={copyList}>Copy as list</button>
              <button className="btn btn-danger sm" onClick={() => collection.clear()}>Clear</button>
            </>
          )}
        </div>
      </div>

      {cards.length === 0 ? (
        <div className="notice">
          <h3>Nothing collected yet</h3>
          <p>
            Hover any card in a result grid and press the ✕ in its corner to add it here. The
            page you are on stays put.
          </p>
          <Link to="/" className="btn" style={{ marginTop: 16 }}>Go search</Link>
        </div>
      ) : (
        <CardGrid cards={cards} view={view} size={size} />
      )}
    </section>
  )
}
