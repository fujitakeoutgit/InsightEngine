import { useMemo } from 'react'

import { primaryType, type DeckCard } from '../lib/deckModel'
import { Curve } from './DeckCharts'

const RARITY_ORDER = ['common', 'uncommon', 'rare', 'mythic', 'special', 'bonus'] as const

const RARITY_COLOR: Record<string, string> = {
  common: 'var(--rarity-common)',
  uncommon: 'var(--rarity-uncommon)',
  rare: 'var(--rarity-rare)',
  mythic: 'var(--rarity-mythic)',
  special: 'var(--rarity-special)',
  bonus: 'var(--rarity-special)',
}

/** The curve's own key for a card's colours.
 *
 * `W`/`U`/`B`/`R`/`G` for a single colour, `multi` for more than one, `C` for
 * none — the same vocabulary the server sends for a deck, because the chart
 * that draws it only knows those seven. Keying it any other way leaves every
 * bucket with a total and no bar, which is precisely what a nicer-sounding
 * "White"/"Multicolour" did. */
function curveKey(identity: string | null | undefined): string {
  const id = identity || ''
  if (!id) return 'C'
  return id.length === 1 ? id : 'multi'
}

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
        const group = curveKey(entry.card.color_identity)
        curve[bucket] = curve[bucket] ?? {}
        curve[bucket][group] = (curve[bucket][group] ?? 0) + n
      }
    }

    const rarity: Record<string, number> = {}
    for (const entry of cards) {
      const key = entry.card.rarity ?? 'unknown'
      rarity[key] = (rarity[key] ?? 0) + entry.quantity
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
      rarity,
    }
  }, [cards])

  const rarityTotal = Object.values(stats.rarity).reduce((sum, n) => sum + n, 0)
  const ranked = RARITY_ORDER
    .filter((r) => stats.rarity[r])
    .map((r) => [r, stats.rarity[r]] as const)

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

        {/* Rarity, drawn the way the deck's own panel draws it — same bar,
            same swatches, same labels. Losing it here was a regression, and
            re-inventing it in a different shape would be a second one. */}
        {rarityTotal > 0 && (
          <div className="rarity-split">
            <span className="label">Rarity</span>
            <div className="rarity-bar">
              {ranked.map(([name, count]) => (
                <span
                  key={name}
                  style={{ width: `${(count / rarityTotal) * 100}%`, background: RARITY_COLOR[name] }}
                  title={`${count} ${name}`}
                />
              ))}
            </div>
            <div className="rarity-keys">
              {ranked.map(([name, count]) => (
                <span className="rarity-key" key={name}>
                  <i style={{ background: RARITY_COLOR[name] }} />
                  {name} <b className="mono">{count}</b>
                </span>
              ))}
            </div>
          </div>
        )}
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
