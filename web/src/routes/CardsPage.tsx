import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'

import type { Card } from '../lib/api'
import { collection, useCollection } from '../lib/collection'
import { copyText } from '../lib/clipboard'
import { CardMenu } from '../components/CardMenu'
import { SIZE_KEY, usePersisted, useTransient, VIEW_KEY } from '../lib/usePersisted'
import { CardGrid } from '../components/CardGrid'
import { PageHead } from '../components/PageHead'

/** Cards collected from search results with the hover [x] button. */
export function CardsPage() {
  const cards = useCollection()
  const [view, setView] = usePersisted<'grid' | 'list'>(VIEW_KEY, 'grid')
  const [size, setSize] = usePersisted(SIZE_KEY, 190)
  const [copied, flashCopied] = useTransient()
  const [failed, flashFailed] = useTransient(2400)
  const [picked, setPicked] = useState<{ card: Card; at: { x: number; y: number } } | null>(null)

  const totals = useMemo(() => {
    const priced = cards.filter((c) => c.usd !== null && c.usd !== undefined)
    return {
      value: priced.reduce((sum, c) => sum + (c.usd ?? 0), 0),
      unpriced: cards.length - priced.length,
    }
  }, [cards])

  // Silent success is indistinguishable from a broken button, so the label
  // reports back for a moment -- and so does silent failure, which is what
  // this used to do: a browser that denies clipboard access rejects the write,
  // and with nothing catching it the button simply did nothing at all.
  const copyList = async () => {
    const ok = await copyText(cards.map((c) => `1 ${c.name}`).join('\n'))
    if (ok) flashCopied()
    else flashFailed()
  }

  return (
    <section className="shell">
      <PageHead eyebrow="Collected" title="Cards">
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
              <button
                className={
                  copied ? 'btn btn-primary sm' : failed ? 'btn btn-danger sm' : 'btn btn-ghost sm'
                }
                onClick={copyList}
              >
                {copied ? '✓ Copied' : failed ? 'Clipboard blocked' : 'Copy as list'}
              </button>
              <button className="btn btn-danger sm" onClick={() => collection.clear()}>Clear</button>
            </>
          )}
      </PageHead>

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
        <CardGrid
          cards={cards}
          view={view}
          size={size}
          onPick={(card, at) => setPicked({ card, at })}
        />
      )}

      {picked && (
        <CardMenu
          card={picked.card}
          at={picked.at}
          onClose={() => setPicked(null)}
        />
      )}
    </section>
  )
}
