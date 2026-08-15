import type { DeckReport, DeckStats } from '../lib/api'

const RARITY_ORDER = ['common', 'uncommon', 'rare', 'mythic', 'special', 'bonus']

const RARITY_COLOR: Record<string, string> = {
  common: 'var(--rarity-common)',
  uncommon: 'var(--rarity-uncommon)',
  rare: 'var(--rarity-rare)',
  mythic: 'var(--rarity-mythic)',
  special: 'var(--rarity-special)',
  bonus: 'var(--rarity-special)',
}

function when(iso: string | null | undefined) {
  if (!iso) return '—'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="deck-stat">
      <span className="v mono">{value}</span>
      <span className="label">{label}</span>
      {hint && <span className="faint">{hint}</span>}
    </div>
  )
}

/**
 * The deck's vital statistics.
 *
 * Replaces the format-legality grid that used to sit here. Legality is one bit
 * of information about a deck you already chose a format for; what you actually
 * want at a glance is size, curve, spend and composition.
 */
export function DeckInfo({
  report, stats, createdAt, updatedAt,
}: {
  report: DeckReport
  stats: DeckStats
  createdAt?: string | null
  updatedAt?: string | null
}) {
  const rarity = stats.rarity?.main ?? {}
  const rarityTotal = Object.values(rarity).reduce((sum, n) => sum + n, 0)
  const ranked = RARITY_ORDER.filter((r) => rarity[r]).map((r) => [r, rarity[r]] as const)

  const priced = report.total_cards - report.cards_missing_price
  const nonlands = stats.total_cards - stats.lands

  return (
    <div className="panel deck-info">
      <h3>Deck info</h3>

      <div className="deck-stats">
        <Stat label="Cards" value={String(report.total_cards)}
          hint={report.sideboard_cards ? `+${report.sideboard_cards} side` : undefined} />
        <Stat label="Unique" value={String(report.unique_cards)} />
        <Stat label="Lands" value={String(stats.lands)}
          hint={stats.untapped_lands ? `${stats.untapped_lands} untapped` : undefined} />
        <Stat label="Nonlands" value={String(nonlands)} />
        <Stat label="Avg. mana value" value={stats.avg_cmc.toFixed(2)} hint="nonlands only" />
        <Stat
          label="Est. value"
          value={`$${report.price_usd.toFixed(2)}`}
          hint={report.cards_missing_price ? `${priced}/${report.total_cards} priced` : undefined}
        />
        <Stat label="Added" value={when(createdAt)} />
        <Stat label="Updated" value={when(updatedAt)} />
      </div>

      {rarityTotal > 0 && (
        <div className="rarity-split">
          <span className="label">Rarity</span>
          {/* Labelled segments, not a color-only bar: the counts are printed
              beside each swatch so the split is readable without the hues. */}
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

      {stats.tokens.length > 0 && (
        <div className="token-list">
          <span className="label">Makes {stats.tokens.length} token{stats.tokens.length === 1 ? '' : 's'}</span>
          <div className="row wrap gap-1">
            {stats.tokens.map((token) => (
              <span className="chip" key={token.oracle_id} title={token.type_line ?? undefined}>
                {token.name}
                {token.pt && <b className="mono faint"> {token.pt}</b>}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
