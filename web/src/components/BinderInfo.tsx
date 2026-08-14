import { useMemo } from 'react'

import { colorGroup, primaryType, type DeckCard } from '../lib/deckModel'
import { Curve } from './DeckCharts'

/**
 * What the binder holds, computed here rather than on the server.
 *
 * The deck's own panels are built from a server analysis of the whole
 * decklist, which is the right shape for a deck: you analyse it once and read
 * the result. A binder is filtered — by colour, and by which of the four jobs
 * a card does — and the numbers have to answer *the list in front of you*. A
 * round trip per pip click would be both slow and wrong, since the server is
 * being asked about text that no longer describes what is on screen.
 *
 * So this counts the cards it is given. Whatever filtering happened upstream
 * is already reflected, because the filtered list is the input.
 */
export function BinderInfo({ cards }: { cards: DeckCard[] }) {
  const stats = useMemo(() => {
    let total = 0
    let lands = 0
    let value = 0
    let mvSum = 0
    let nonlands = 0
    const curve: Record<string, Record<string, number>> = {}

    for (const entry of cards) {
      const n = entry.quantity
      total += n
      value += (entry.card.usd ?? 0) * n
      const isLand = /\bLand\b/.test(entry.card.type_line ?? '')
      if (isLand) {
        lands += n
      } else {
        nonlands += n
        mvSum += (entry.card.cmc ?? 0) * n
        // Lands are left out of the curve for the same reason a deck's curve
        // leaves them out: they cost nothing and would pile onto zero.
        const mv = Math.min(7, Math.floor(entry.card.cmc ?? 0))
        const bucket = mv >= 7 ? '7+' : String(mv)
        const group = colorGroup(entry.card)
        curve[bucket] = curve[bucket] ?? {}
        curve[bucket][group] = (curve[bucket][group] ?? 0) + n
      }
    }

    const types: Record<string, number> = {}
    for (const entry of cards) {
      const key = primaryType(entry.card)
      types[key] = (types[key] ?? 0) + entry.quantity
    }

    return {
      total,
      unique: cards.length,
      lands,
      nonlands,
      value,
      avgMv: nonlands ? mvSum / nonlands : 0,
      curve,
      types,
    }
  }, [cards])

  if (!cards.length) {
    return (
      <div className="panel deck-info">
        <h3>Binder info</h3>
        <p className="muted" style={{ fontSize: 13, margin: 0 }}>
          Nothing matches the filters you have set.
        </p>
      </div>
    )
  }

  return (
    <>
      <div className="chart-grid">
        <Curve curve={stats.curve} />
      </div>

      <div className="panel deck-info">
        <h3>Binder info</h3>
        <div className="deck-stats">
          <Stat label="Cards" value={String(stats.total)} />
          <Stat label="Unique" value={String(stats.unique)} />
          <Stat label="Lands" value={String(stats.lands)} />
          <Stat label="Nonlands" value={String(stats.nonlands)} />
          <Stat label="Avg. mana value" value={stats.avgMv.toFixed(2)} />
          <Stat label="Est. value" value={`$${stats.value.toFixed(2)}`} />
        </div>
      </div>
    </>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="stat">
      <span className="v mono">{value}</span>
      <span className="label">{label}</span>
    </div>
  )
}
