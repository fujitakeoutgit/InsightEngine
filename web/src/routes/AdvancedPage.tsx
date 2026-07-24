import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'

import { api, type SetInfo } from '../lib/api'
import { quoteIfNeeded } from '../lib/query'
import { revealOnScroll, riseIn } from '../lib/motion'

const COLORS = [
  ['W', 'White'], ['U', 'Blue'], ['B', 'Black'], ['R', 'Red'], ['G', 'Green'], ['C', 'Colourless'],
]

const TYPES = [
  'Creature', 'Instant', 'Sorcery', 'Artifact', 'Enchantment', 'Land',
  'Planeswalker', 'Battle', 'Legendary', 'Token', 'Saga', 'Equipment', 'Aura',
]

const RARITIES = [['common', 'Common'], ['uncommon', 'Uncommon'], ['rare', 'Rare'], ['mythic', 'Mythic']]

const FORMATS = [
  'standard', 'pioneer', 'modern', 'legacy', 'vintage', 'commander',
  'pauper', 'brawl', 'historic', 'timeless', 'penny', 'oathbreaker',
]

const COLOR_MODES = [
  [':', 'includes'],
  ['=', 'exactly'],
  ['<=', 'at most (identity)'],
  ['>=', 'includes all of'],
]

interface BuilderState {
  colors: string[]
  colorMode: string
  colorField: 'c' | 'id'
  types: string[]
  excludeTypes: string[]
  oracle: string
  oracleWildcard: boolean
  name: string
  mvMin: string
  mvMax: string
  powMin: string
  touMin: string
  rarities: string[]
  set: string
  format: string
  priceMax: string
  keyword: string
  semantic: string
  isFlags: string[]
}

const INITIAL: BuilderState = {
  colors: [], colorMode: ':', colorField: 'c', types: [], excludeTypes: [],
  oracle: '', oracleWildcard: false, name: '', mvMin: '', mvMax: '',
  powMin: '', touMin: '', rarities: [], set: '', format: '', priceMax: '',
  keyword: '', semantic: '', isFlags: [],
}

const IS_FLAGS = [
  ['commander', 'Can be commander'], ['permanent', 'Permanent'], ['vanilla', 'Vanilla'],
  ['dfc', 'Double-faced'], ['hybrid', 'Hybrid mana'], ['reserved', 'Reserved List'],
  ['gamechanger', 'Game Changer'],
]

/** Assemble the query string. The generated text is the real interface --
 *  users learn the syntax by watching this update. */
function buildQuery(state: BuilderState): string {
  const parts: string[] = []

  // q: must lead, so the planner sees the prose before structured filters.
  if (state.semantic.trim()) parts.push(`q:"${state.semantic.trim().replace(/"/g, '')}"`)
  if (state.name.trim()) parts.push(quoteIfNeeded(state.name.trim()))

  if (state.colors.length) {
    parts.push(`${state.colorField}${state.colorMode}${state.colors.join('').toLowerCase()}`)
  }
  for (const type of state.types) parts.push(`t:${type.toLowerCase()}`)
  for (const type of state.excludeTypes) parts.push(`-t:${type.toLowerCase()}`)

  if (state.oracle.trim()) {
    const text = state.oracle.trim()
    parts.push(`o:"${text.replace(/"/g, '')}"`)
  }

  if (state.mvMin) parts.push(`mv>=${state.mvMin}`)
  if (state.mvMax) parts.push(`mv<=${state.mvMax}`)
  if (state.powMin) parts.push(`pow>=${state.powMin}`)
  if (state.touMin) parts.push(`tou>=${state.touMin}`)

  if (state.rarities.length === 1) parts.push(`r:${state.rarities[0]}`)
  else if (state.rarities.length > 1) {
    parts.push(`(${state.rarities.map((r) => `r:${r}`).join(' or ')})`)
  }

  if (state.set.trim()) parts.push(`s:${state.set.trim().toLowerCase()}`)
  if (state.format) parts.push(`legal:${state.format}`)
  if (state.priceMax) parts.push(`usd<=${state.priceMax}`)
  if (state.keyword.trim()) parts.push(`kw:${state.keyword.trim().toLowerCase()}`)
  for (const flag of state.isFlags) parts.push(`is:${flag}`)

  return parts.join(' ')
}

function Toggle({
  active, onClick, children, className = '', ...rest
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
  className?: string
} & React.HTMLAttributes<HTMLButtonElement>) {
  return (
    <button className={`pill ${className} ${active ? 'on' : ''}`} onClick={onClick} {...rest}>
      {children}
    </button>
  )
}

export function AdvancedPage() {
  const [state, setState] = useState<BuilderState>(INITIAL)
  const [sets, setSets] = useState<SetInfo[]>([])
  const navigate = useNavigate()
  const rootRef = useRef<HTMLDivElement>(null)

  const query = useMemo(() => buildQuery(state), [state])

  useEffect(() => {
    api.sets().then((r) => setSets(r.sets.filter((s) => !s.digital))).catch(() => {})
  }, [])

  useEffect(() => {
    riseIn(rootRef.current)
    return revealOnScroll('.builder-group', rootRef.current)
  }, [])

  const set = <K extends keyof BuilderState>(key: K, value: BuilderState[K]) =>
    setState((s) => ({ ...s, [key]: value }))

  const toggleIn = (key: 'colors' | 'types' | 'excludeTypes' | 'rarities' | 'isFlags', value: string) =>
    setState((s) => ({
      ...s,
      [key]: s[key].includes(value) ? s[key].filter((v) => v !== value) : [...s[key], value],
    }))

  return (
    <section className="shell" style={{ paddingTop: 'var(--gap-4)' }} ref={rootRef}>
      <div className="section-head">
        <h2>Advanced search</h2>
        <p className="muted" style={{ fontSize: 'var(--step--1)' }}>
          Every control writes query syntax. Watch the bar at the bottom.
        </p>
      </div>

      <div className="builder">
        <div className="builder-group">
          <span className="label">Colour</span>
          <div className="pill-row" style={{ marginBottom: 'var(--gap-2)' }}>
            {COLORS.map(([code, label]) => (
              <Toggle
                key={code}
                className="mana"
                data-c={code}
                active={state.colors.includes(code)}
                onClick={() => toggleIn('colors', code)}
              >
                {label}
              </Toggle>
            ))}
          </div>
          <div className="row gap-2">
            <select
              className="field"
              value={state.colorField}
              onChange={(e) => set('colorField', e.target.value as 'c' | 'id')}
            >
              <option value="c">Card colour</option>
              <option value="id">Colour identity</option>
            </select>
            <select
              className="field"
              value={state.colorMode}
              onChange={(e) => set('colorMode', e.target.value)}
            >
              {COLOR_MODES.map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
          </div>
        </div>

        <div className="builder-group">
          <span className="label">Card type</span>
          <div className="pill-row">
            {TYPES.map((type) => (
              <Toggle
                key={type}
                active={state.types.includes(type)}
                onClick={() => toggleIn('types', type)}
              >
                {type}
              </Toggle>
            ))}
          </div>
          <span className="label" style={{ display: 'block', margin: 'var(--gap-3) 0 var(--gap-1)' }}>
            Exclude type
          </span>
          <div className="pill-row">
            {TYPES.slice(0, 8).map((type) => (
              <Toggle
                key={type}
                active={state.excludeTypes.includes(type)}
                onClick={() => toggleIn('excludeTypes', type)}
              >
                {type}
              </Toggle>
            ))}
          </div>
        </div>

        <div className="builder-group">
          <span className="label">Rules text</span>
          <input
            className="field"
            placeholder="draw a card"
            value={state.oracle}
            onChange={(e) => set('oracle', e.target.value)}
          />
          <p className="faint" style={{ fontSize: 'var(--step--2)', marginTop: 'var(--gap-1)' }}>
            Use <code className="mono">_</code> as a wildcard for any run of text —{' '}
            <code className="mono">Elf_creature</code> matches “Elf Warrior creature”.
          </p>

          <span className="label" style={{ display: 'block', margin: 'var(--gap-3) 0 var(--gap-1)' }}>
            Card name
          </span>
          <input
            className="field"
            placeholder="Lightning"
            value={state.name}
            onChange={(e) => set('name', e.target.value)}
          />

          <span className="label" style={{ display: 'block', margin: 'var(--gap-3) 0 var(--gap-1)' }}>
            Keyword
          </span>
          <input
            className="field"
            placeholder="flying"
            value={state.keyword}
            onChange={(e) => set('keyword', e.target.value)}
          />
        </div>

        <div className="builder-group">
          <span className="label">Mana value</span>
          <div className="range-row">
            <input
              className="field" type="number" min="0" placeholder="min"
              value={state.mvMin} onChange={(e) => set('mvMin', e.target.value)}
            />
            <span className="faint">to</span>
            <input
              className="field" type="number" min="0" placeholder="max"
              value={state.mvMax} onChange={(e) => set('mvMax', e.target.value)}
            />
          </div>

          <span className="label" style={{ display: 'block', margin: 'var(--gap-3) 0 var(--gap-1)' }}>
            Minimum power / toughness
          </span>
          <div className="range-row">
            <input
              className="field" type="number" placeholder="power"
              value={state.powMin} onChange={(e) => set('powMin', e.target.value)}
            />
            <input
              className="field" type="number" placeholder="toughness"
              value={state.touMin} onChange={(e) => set('touMin', e.target.value)}
            />
          </div>

          <span className="label" style={{ display: 'block', margin: 'var(--gap-3) 0 var(--gap-1)' }}>
            Maximum price (USD)
          </span>
          <input
            className="field" type="number" min="0" step="0.5" placeholder="no limit"
            value={state.priceMax} onChange={(e) => set('priceMax', e.target.value)}
          />
        </div>

        <div className="builder-group">
          <span className="label">Rarity</span>
          <div className="pill-row">
            {RARITIES.map(([code, label]) => (
              <Toggle
                key={code}
                active={state.rarities.includes(code)}
                onClick={() => toggleIn('rarities', code)}
              >
                {label}
              </Toggle>
            ))}
          </div>

          <span className="label" style={{ display: 'block', margin: 'var(--gap-3) 0 var(--gap-1)' }}>
            Legal in format
          </span>
          <select
            className="field"
            value={state.format}
            onChange={(e) => set('format', e.target.value)}
          >
            <option value="">Any format</option>
            {FORMATS.map((format) => (
              <option key={format} value={format} style={{ textTransform: 'capitalize' }}>
                {format}
              </option>
            ))}
          </select>

          <span className="label" style={{ display: 'block', margin: 'var(--gap-3) 0 var(--gap-1)' }}>
            Set
          </span>
          <input
            className="field"
            list="set-codes"
            placeholder="Set code, e.g. mh3"
            value={state.set}
            onChange={(e) => set('set', e.target.value)}
          />
          <datalist id="set-codes">
            {sets.map((s) => (
              <option key={s.code} value={s.code}>{s.name}</option>
            ))}
          </datalist>
        </div>

        <div className="builder-group">
          <span className="label">Properties</span>
          <div className="pill-row">
            {IS_FLAGS.map(([code, label]) => (
              <Toggle
                key={code}
                active={state.isFlags.includes(code)}
                onClick={() => toggleIn('isFlags', code)}
              >
                {label}
              </Toggle>
            ))}
          </div>

          <span className="label" style={{ display: 'block', margin: 'var(--gap-3) 0 var(--gap-1)' }}>
            Ask the model (q:)
          </span>
          <input
            className="field"
            placeholder="cards that punish opponents for drawing"
            value={state.semantic}
            onChange={(e) => set('semantic', e.target.value)}
          />
          <p className="faint" style={{ fontSize: 'var(--step--2)', marginTop: 'var(--gap-1)' }}>
            Runs the local 70B pipeline and intersects its results with the filters above.
            Thorough, not fast.
          </p>
        </div>
      </div>

      <div className="query-preview">
        <span className="label" style={{ flex: 'none' }}>Query</span>
        <code>{query || 'Nothing selected yet'}</code>
        <div className="row gap-2" style={{ flex: 'none' }}>
          <button className="btn btn-ghost" onClick={() => setState(INITIAL)}>
            Reset
          </button>
          <button
            className="btn btn-ghost"
            disabled={!query}
            onClick={() => navigator.clipboard?.writeText(query)}
          >
            Copy
          </button>
          <button
            className="btn btn-primary"
            disabled={!query}
            onClick={() => navigate(`/?q=${encodeURIComponent(query)}`)}
          >
            Search
          </button>
        </div>
      </div>
    </section>
  )
}
