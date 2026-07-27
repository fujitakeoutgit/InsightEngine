import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'

import { api, type SetInfo } from '../lib/api'
import { dissolveIn, riseIn } from '../lib/motion'
import { PageHead } from '../components/PageHead'

const TYPE_LABELS: Record<string, string> = {
  core: 'Core', expansion: 'Expansion', masters: 'Masters', commander: 'Commander',
  draft_innovation: 'Draft innovation', funny: 'Un-set', starter: 'Starter',
  duel_deck: 'Duel deck', promo: 'Promo', token: 'Token', memorabilia: 'Memorabilia',
  alchemy: 'Alchemy', masterpiece: 'Masterpiece', arsenal: 'Arsenal', box: 'Box set',
  from_the_vault: 'From the Vault', premium_deck: 'Premium deck', spellbook: 'Spellbook',
  planechase: 'Planechase', archenemy: 'Archenemy', vanguard: 'Vanguard',
  treasure_chest: 'Treasure chest', minigame: 'Minigame',
}

const PRIMARY_TYPES = ['core', 'expansion', 'masters', 'commander', 'draft_innovation']

export function SetsPage() {
  const [sets, setSets] = useState<SetInfo[]>([])
  const [filter, setFilter] = useState('')
  const [type, setType] = useState('primary')
  const [error, setError] = useState<string | null>(null)
  const gridRef = useRef<HTMLDivElement>(null)
  const headRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    api
      .sets()
      .then((r) => setSets(r.sets))
      .catch((err) => setError(err instanceof Error ? err.message : 'Could not load sets'))
    riseIn(headRef.current)
  }, [])

  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase()
    return sets.filter((s) => {
      if (type === 'primary' && !PRIMARY_TYPES.includes(s.set_type ?? '')) return false
      if (type !== 'primary' && type !== 'all' && s.set_type !== type) return false
      if (!needle) return true
      return s.name.toLowerCase().includes(needle) || s.code.includes(needle)
    })
  }, [sets, filter, type])

  useEffect(() => {
    if (gridRef.current) {
      // No blur: these tiles are 28px icons and a line of text, so the blur is
      // imperceptible but still costs a filter pass per tile.
      dissolveIn(gridRef.current.querySelectorAll('.set-card'), { stagger: 0.008, blur: false })
    }
  }, [visible])

  const types = useMemo(
    () => Array.from(new Set(sets.map((s) => s.set_type).filter(Boolean))).sort() as string[],
    [sets],
  )

  return (
    <section className="shell" style={{ paddingTop: 'var(--gap-4)' }}>
      <PageHead eyebrow="Browse" title="Sets" ref={headRef}>
        <input
          className="field"
          style={{ width: 'auto' }}
          placeholder="Filter by name or code"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <select
          className="field"
          style={{ width: 'auto' }}
          value={type}
          onChange={(e) => setType(e.target.value)}
        >
          <option value="primary">Main sets</option>
          <option value="all">All types</option>
          {types.map((t) => (
            <option key={t} value={t}>{TYPE_LABELS[t] ?? t}</option>
          ))}
        </select>
        <span className="count mono muted">{visible.length}</span>
      </PageHead>

      {error && (
        <div className="notice error">
          <h3>Sets unavailable</h3>
          <p>{error}</p>
        </div>
      )}

      <div className="set-grid" ref={gridRef}>
        {visible.map((set) => (
          <Link
            key={set.code}
            to={`/?q=${encodeURIComponent(`s:${set.code}`)}`}
            className="set-card"
          >
            {set.icon_svg_uri && <img src={set.icon_svg_uri} alt="" loading="lazy" />}
            <div style={{ minWidth: 0 }}>
              <div className="nm">{set.name}</div>
              <div className="meta">
                {set.code.toUpperCase()} · {set.card_count ?? 0} cards
                {set.released_at && ` · ${set.released_at.slice(0, 4)}`}
              </div>
            </div>
          </Link>
        ))}
      </div>

      {visible.length === 0 && !error && (
        <div className="notice">
          <h3>No sets match</h3>
          <p>Try a different filter.</p>
        </div>
      )}
    </section>
  )
}
