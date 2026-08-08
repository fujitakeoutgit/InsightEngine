import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'

import { copyText } from '../lib/clipboard'
import { quoteIfNeeded } from '../lib/query'
import { useTransient } from '../lib/usePersisted'
import { ManaPip } from '../components/ManaSprite'
import { PageHead } from '../components/PageHead'
import { TypeAhead } from '../components/TypeAhead'

/* --------------------------------------------------------------------------
   Vocabulary
   -------------------------------------------------------------------------- */

const COLORS: [string, string][] = [
  ['W', 'White'], ['U', 'Blue'], ['B', 'Black'], ['R', 'Red'], ['G', 'Green'], ['C', 'Colourless'],
]

const COLOR_MODES: [string, string][] = [
  [':', 'Including these colours'],
  ['=', 'Exactly these colours'],
  ['<=', 'At most these colours'],
  ['>=', 'Including all of these'],
]

const RARITIES: [string, string][] = [
  ['common', 'Common'], ['uncommon', 'Uncommon'], ['rare', 'Rare'], ['mythic', 'Mythic'],
]

const STATS: [string, string][] = [
  ['mv', 'Mana value'], ['pow', 'Power'], ['tou', 'Toughness'],
  ['loy', 'Loyalty'], ['year', 'Year'], ['edhrec', 'EDHREC rank'],
]

const OPS: [string, string][] = [
  ['=', 'equal to'], ['>=', 'at least'], ['<=', 'at most'],
  ['>', 'greater than'], ['<', 'less than'], ['!=', 'not equal to'],
]

const FORMATS = [
  'standard', 'pioneer', 'modern', 'legacy', 'vintage', 'commander', 'pauper',
  'brawl', 'historic', 'timeless', 'alchemy', 'explorer', 'penny', 'oathbreaker',
  'duel', 'predh', 'premodern', 'oldschool', 'gladiator',
]

const STATUSES: [string, string][] = [
  ['legal', 'Legal in'], ['banned', 'Banned in'], ['restricted', 'Restricted in'],
]

const CRITERIA: [string, string][] = [
  ['commander', 'Can be a commander'], ['permanent', 'Is a permanent'],
  ['spell', 'Is a spell'], ['vanilla', 'Is vanilla (no rules text)'],
  ['dfc', 'Is double-faced'], ['modal', 'Is a modal DFC'],
  ['transform', 'Transforms'], ['split', 'Is a split card'],
  ['adventure', 'Has an adventure'], ['saga', 'Is a Saga'],
  ['hybrid', 'Has hybrid mana'], ['phyrexian', 'Has Phyrexian mana'],
  ['reserved', 'Is on the Reserved List'], ['gamechanger', 'Is a Game Changer'],
  ['funny', 'Is from an Un-set'], ['digital', 'Is digital only'],
  ['rebalanced', 'Is an Alchemy rebalance'],
]

const CURRENCIES: [string, string][] = [['usd', 'USD'], ['eur', 'EUR'], ['tix', 'MTGO tix']]

const SORTS: [string, string][] = [
  ['', 'Default'], ['name', 'Name'], ['edhrec', 'Popularity'], ['cmc', 'Mana value'],
  ['usd', 'Price'], ['released', 'Release date'], ['rarity', 'Rarity'], ['color', 'Colour'],
]

/* --------------------------------------------------------------------------
   State
   -------------------------------------------------------------------------- */

interface Condition { a: string; op: string; value: string }

interface Builder {
  name: string
  oracle: string
  typeLine: string
  typeExclude: string
  colors: string[]
  colorMode: string
  identity: string[]
  mana: string
  stats: Condition[]
  formats: { status: string; format: string }[]
  sets: string
  rarities: string[]
  criteria: string[]
  prices: Condition[]
  artist: string
  lore: string
  keyword: string
  semantic: string
  sort: string
  order: string
}

const INITIAL: Builder = {
  name: '', oracle: '', typeLine: '', typeExclude: '',
  colors: [], colorMode: ':', identity: [], mana: '',
  stats: [{ a: 'mv', op: '<=', value: '' }],
  // Commander by default, matching withCommanderDefault() on the splash page.
  // Nearly every query here is for a Commander deck, and the row was starting
  // on "Choose a format" — which quietly meant no legality filter at all.
  formats: [{ status: 'legal', format: 'commander' }],
  sets: '', rarities: [], criteria: [],
  prices: [{ a: 'usd', op: '<=', value: '' }],
  artist: '', lore: '', keyword: '', semantic: '', sort: '', order: 'asc',
}

/** Assemble the query. The generated text is the real interface — users learn
 *  the syntax by watching this line update as they click. */
function buildQuery(b: Builder): string {
  const parts: string[] = []

  // q: must lead so the planner sees the prose before structured filters.
  if (b.semantic.trim()) parts.push(`q:"${b.semantic.trim().replace(/"/g, '')}"`)
  if (b.name.trim()) parts.push(quoteIfNeeded(b.name.trim()))
  if (b.oracle.trim()) parts.push(`o:"${b.oracle.trim().replace(/"/g, '')}"`)
  if (b.lore.trim()) parts.push(`fo:"${b.lore.trim().replace(/"/g, '')}"`)

  for (const word of b.typeLine.trim().split(/\s+/).filter(Boolean)) {
    parts.push(`t:${word.toLowerCase()}`)
  }
  for (const word of b.typeExclude.trim().split(/\s+/).filter(Boolean)) {
    parts.push(`-t:${word.toLowerCase()}`)
  }

  if (b.colors.length) {
    const letters = b.colors.join('').toLowerCase()
    parts.push(`c${b.colorMode}${letters}`)
  }
  if (b.identity.length) parts.push(`id<=${b.identity.join('').toLowerCase()}`)
  if (b.mana.trim()) parts.push(`m:${b.mana.trim()}`)

  for (const stat of b.stats) {
    if (stat.value.trim()) parts.push(`${stat.a}${stat.op}${stat.value.trim()}`)
  }
  for (const entry of b.formats) {
    if (entry.format) parts.push(`${entry.status}:${entry.format}`)
  }
  for (const price of b.prices) {
    if (price.value.trim()) parts.push(`${price.a}${price.op}${price.value.trim()}`)
  }

  for (const code of b.sets.trim().split(/[\s,]+/).filter(Boolean)) {
    parts.push(`s:${code.toLowerCase()}`)
  }

  if (b.rarities.length === 1) parts.push(`r:${b.rarities[0]}`)
  else if (b.rarities.length > 1) {
    parts.push(`(${b.rarities.map((r) => `r:${r}`).join(' or ')})`)
  }

  for (const flag of b.criteria) parts.push(`is:${flag}`)
  if (b.keyword.trim()) parts.push(`kw:${b.keyword.trim().toLowerCase()}`)
  if (b.artist.trim()) parts.push(`a:"${b.artist.trim().replace(/"/g, '')}"`)

  return parts.join(' ')
}

/* --------------------------------------------------------------------------
   Pieces
   -------------------------------------------------------------------------- */

function Row({
  label, hint, children,
}: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="form-row">
      <div className="form-row-label">
        {label}
        {hint && <span className="hint">{hint}</span>}
      </div>
      <div className="form-row-content">{children}</div>
    </div>
  )
}

function Check({
  on, onClick, children, colour,
}: { on: boolean; onClick: () => void; children: React.ReactNode; colour?: string }) {
  return (
    <button
      type="button"
      className={`check ${on ? 'on' : ''}`}
      data-c={colour}
      aria-pressed={on}
      onClick={onClick}
    >
      {children}
    </button>
  )
}

/* --------------------------------------------------------------------------
   Page
   -------------------------------------------------------------------------- */

export function AdvancedPage() {
  const [b, setB] = useState<Builder>(INITIAL)
  const [copied, flashCopied] = useTransient()
  const navigate = useNavigate()

  const query = useMemo(() => buildQuery(b), [b])

  const set = <K extends keyof Builder>(key: K, value: Builder[K]) =>
    setB((s) => ({ ...s, [key]: value }))

  const toggle = (key: 'colors' | 'identity' | 'rarities' | 'criteria', value: string) =>
    setB((s) => ({
      ...s,
      [key]: s[key].includes(value) ? s[key].filter((v) => v !== value) : [...s[key], value],
    }))

  const patchList = <K extends 'stats' | 'prices' | 'formats'>(
    key: K, index: number, patch: Partial<Builder[K][number]>,
  ) => setB((s) => ({
    ...s,
    [key]: s[key].map((row, i) => (i === index ? { ...row, ...patch } : row)),
  }))

  const addRow = (key: 'stats' | 'prices' | 'formats') =>
    setB((s) => ({
      ...s,
      [key]: [
        ...s[key],
        key === 'formats'
          ? { status: 'legal', format: '' }
          : { a: key === 'stats' ? 'mv' : 'usd', op: '<=', value: '' },
      ] as never,
    }))

  const removeRow = (key: 'stats' | 'prices' | 'formats', index: number) =>
    setB((s) => ({ ...s, [key]: s[key].filter((_, i) => i !== index) as never }))

  const run = () => {
    const suffix = b.sort ? ` sort:${b.sort}` : ''
    navigate(`/?q=${encodeURIComponent(query)}${suffix ? `&sort=${b.sort}&order=${b.order}` : ''}`)
  }

  return (
    <section className="shell">
      {/* First thing under the nav, above even the page title: it is the thing
          being built, so it belongs where the eye already is rather than at the
          bottom of a long form. It is the one page whose back control sits
          lower than everywhere else, which is the cost of that. */}
      <div className="query-dock">
      <div className="query-preview">
        <span className="label preview-tag">Query</span>
        <code>{query || 'Nothing selected yet'}</code>
        <div className="row gap-2 wrap preview-actions">
          <button className="btn btn-ghost sm" onClick={() => setB(INITIAL)}>Reset</button>
          {/* Reports back. This used to fire and forget, so a browser that
              refused the write left the button looking merely decorative. */}
          <button
            className={copied ? 'btn btn-primary sm' : 'btn btn-ghost sm'}
            disabled={!query}
            onClick={async () => { if (await copyText(query)) flashCopied() }}
          >
            {copied ? '✓ Copied' : 'Copy'}
          </button>
          <button className="btn btn-primary" disabled={!query} onClick={run}>
            Search with these options
          </button>
        </div>
      </div>
      </div>

      <PageHead
        eyebrow="Query builder"
        title="Advanced search"
        subtitle="Every control writes query syntax. Watch the bar above to learn it."
      />

      <div className="adv-form">
        <Row label="Card Name" hint="Any words in the name, e.g. “Fire”">
          <input
            className="fld" value={b.name} placeholder="Any words in the name"
            onChange={(e) => set('name', e.target.value)}
          />
        </Row>

        <Row label="Text" hint="Any text, e.g. “draw a card”. Use _ as a wildcard for any run of text.">
          <input
            className="fld" value={b.oracle} placeholder="Rules text contains…"
            onChange={(e) => set('oracle', e.target.value)}
          />
        </Row>

        <Row label="Type Line" hint="Matches as you type. Enter adds it and starts the next.">
          <TypeAhead
            kind="types" value={b.typeLine} onChange={(v) => set('typeLine', v)}
            placeholder="Enter a type, e.g. legendary creature"
          />
          <TypeAhead
            kind="types" value={b.typeExclude} onChange={(v) => set('typeExclude', v)}
            placeholder="Exclude types, e.g. token"
          />
        </Row>

        <Row label="Colors" hint="The colours in the card’s mana cost">
          <div className="checks">
            {COLORS.map(([code, label]) => (
              <Check
                key={code} colour={code} on={b.colors.includes(code)}
                onClick={() => toggle('colors', code)}
              >
                <ManaPip code={code} size={17} />
                {label}
              </Check>
            ))}
          </div>
          <select
            className="fld" style={{ width: 'auto' }} value={b.colorMode}
            onChange={(e) => set('colorMode', e.target.value)}
            aria-label="Colour comparison"
          >
            {COLOR_MODES.map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
        </Row>

        <Row label="Commander" hint="Colour identity, for Commander decks">
          <div className="checks">
            {COLORS.filter(([c]) => c !== 'C').map(([code, label]) => (
              <Check
                key={code} colour={code} on={b.identity.includes(code)}
                onClick={() => toggle('identity', code)}
              >
                <ManaPip code={code} size={17} />
                {label}
              </Check>
            ))}
          </div>
        </Row>

        <Row label="Mana Cost" hint="Any mana symbols, e.g. “{W}{W}”">
          <input
            className="fld" value={b.mana} placeholder="{2}{W}{U}"
            onChange={(e) => set('mana', e.target.value)}
          />
        </Row>

        <Row label="Stats" hint="Numeric properties. Add as many conditions as you need.">
          {b.stats.map((stat, i) => (
            <div className="cond-row" key={i}>
              <select
                className="fld" value={stat.a}
                onChange={(e) => patchList('stats', i, { a: e.target.value })}
                aria-label="Stat"
              >
                {STATS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
              <select
                className="fld" value={stat.op}
                onChange={(e) => patchList('stats', i, { op: e.target.value })}
                aria-label="Comparison"
              >
                {OPS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
              <input
                className="fld" value={stat.value} placeholder="Any value, e.g. “2”"
                onChange={(e) => patchList('stats', i, { value: e.target.value })}
                aria-label="Value"
              />
              {b.stats.length > 1 && (
                <button className="remove-row" onClick={() => removeRow('stats', i)} aria-label="Remove">
                  ✕
                </button>
              )}
            </div>
          ))}
          <button className="add-row" onClick={() => addRow('stats')}>+ Add another stat</button>
        </Row>

        <Row label="Formats" hint="Legality in a constructed format">
          {b.formats.map((entry, i) => (
            <div className="cond-row" key={i}>
              <select
                className="fld" value={entry.status}
                onChange={(e) => patchList('formats', i, { status: e.target.value })}
                aria-label="Status"
              >
                {STATUSES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
              <select
                className="fld" value={entry.format}
                onChange={(e) => patchList('formats', i, { format: e.target.value })}
                aria-label="Format"
              >
                <option value="">Choose a format</option>
                {FORMATS.map((f) => (
                  <option key={f} value={f} style={{ textTransform: 'capitalize' }}>{f}</option>
                ))}
              </select>
              {b.formats.length > 1 && (
                <button className="remove-row" onClick={() => removeRow('formats', i)} aria-label="Remove">
                  ✕
                </button>
              )}
            </div>
          ))}
          <button className="add-row" onClick={() => addRow('formats')}>+ Add another format</button>
        </Row>

        <Row label="Sets" hint="Matches as you type. Enter adds it and starts the next.">
          <TypeAhead
            kind="sets" value={b.sets} onChange={(v) => set('sets', v)}
            placeholder="Enter a set name or code"
            // The catalog reads "mh3 — Modern Horizons 3"; the query wants the code.
            transform={(entry) => entry.split(' — ')[0]}
          />
        </Row>

        <Row label="Rarity" hint="Any of the selected rarities">
          <div className="checks">
            {RARITIES.map(([code, label]) => (
              <Check key={code} on={b.rarities.includes(code)} onClick={() => toggle('rarities', code)}>
                {label}
              </Check>
            ))}
          </div>
        </Row>

        <Row label="Criteria" hint="Card properties. All selected criteria must match.">
          <div className="checks">
            {CRITERIA.map(([code, label]) => (
              <Check key={code} on={b.criteria.includes(code)} onClick={() => toggle('criteria', code)}>
                {label}
              </Check>
            ))}
          </div>
        </Row>

        <Row label="Prices" hint="Current market price">
          {b.prices.map((price, i) => (
            <div className="cond-row" key={i}>
              <select
                className="fld" value={price.a}
                onChange={(e) => patchList('prices', i, { a: e.target.value })}
                aria-label="Currency"
              >
                {CURRENCIES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
              <select
                className="fld" value={price.op}
                onChange={(e) => patchList('prices', i, { op: e.target.value })}
                aria-label="Comparison"
              >
                {OPS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
              <input
                className="fld" value={price.value} placeholder="Any value, e.g. “15.00”"
                onChange={(e) => patchList('prices', i, { value: e.target.value })}
                aria-label="Value"
              />
              {b.prices.length > 1 && (
                <button className="remove-row" onClick={() => removeRow('prices', i)} aria-label="Remove">
                  ✕
                </button>
              )}
            </div>
          ))}
          <button className="add-row" onClick={() => addRow('prices')}>+ Add another price</button>
        </Row>

        <Row label="Keyword" hint="Matches as you type. Enter adds it.">
          <TypeAhead
            kind="keywords" value={b.keyword} onChange={(v) => set('keyword', v)}
            placeholder="flying" multi={false}
          />
        </Row>

        <Row label="Artist" hint="Matches as you type. Enter adds it.">
          <TypeAhead
            kind="artists" value={b.artist} onChange={(v) => set('artist', v)}
            placeholder="Any artist name" multi={false}
          />
        </Row>

        <Row label="Lore Finder" hint="Searches name, type line and rules text together">
          <input
            className="fld" value={b.lore} placeholder="Any text, especially names. e.g. “Jhoira”"
            onChange={(e) => set('lore', e.target.value)}
          />
        </Row>

        <Row
          label="Ask the model"
          hint="Runs the local 70B pipeline and intersects its results with everything above. Thorough, not fast."
        >
          <input
            className="fld" value={b.semantic}
            placeholder="cards that punish opponents for drawing"
            onChange={(e) => set('semantic', e.target.value)}
          />
        </Row>

        <Row label="Preferences" hint="How results are displayed">
          <div className="cond-row">
            <select
              className="fld" value={b.sort} onChange={(e) => set('sort', e.target.value)}
              aria-label="Sort order"
            >
              {SORTS.map(([v, l]) => <option key={v} value={v}>Sort by: {l}</option>)}
            </select>
            <select
              className="fld" value={b.order} onChange={(e) => set('order', e.target.value)}
              aria-label="Direction"
            >
              <option value="asc">Ascending</option>
              <option value="desc">Descending</option>
            </select>
          </div>
        </Row>
      </div>

    </section>
  )
}
