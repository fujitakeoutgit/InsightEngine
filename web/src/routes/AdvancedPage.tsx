import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'

import { copyText } from '../lib/clipboard'
import { quoteIfNeeded } from '../lib/query'
import { useTransient } from '../lib/usePersisted'
import { ManaPip } from '../components/ManaSprite'
import { TypeAhead } from '../components/TypeAhead'

/* --------------------------------------------------------------------------
   Vocabulary
   -------------------------------------------------------------------------- */

const COLORS: [string, string][] = [
  ['W', 'White'], ['U', 'Blue'], ['B', 'Black'], ['R', 'Red'], ['G', 'Green'], ['C', 'Colorless'],
]

/* Worded so the difference is unmissable. ":" is a superset match -- it is
   Scryfall's meaning and this app keeps it -- so `c:wgu` returns Atogatog and
   every other five-color card, because a five-color card *is* white, green and
   blue. Reading it as "only these colors" is the easiest mistake in the whole
   form, which is why the label says "at least" rather than naming the colors
   and stopping.

   Three, not four. `>=` was listed as a fourth mode with the same label as
   `:`, because it *is* the same operator -- Scryfall treats them as synonyms
   -- so the menu offered the same behaviour twice under one description and
   left you wondering what you had missed. */
const COLOR_MODES: [string, string][] = [
  [':', 'At least these colors'],
  ['<=', 'These colors and no others'],
  ['=', 'Exactly these colors'],
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
  ['usd', 'Price'], ['released', 'Release date'], ['rarity', 'Rarity'], ['color', 'Color'],
]

/* --------------------------------------------------------------------------
   State
   -------------------------------------------------------------------------- */

interface Condition { a: string; op: string; value: string }

interface Builder {
  name: string
  oracle: OracleTerm[]
  /** One entry per type, each either required or excluded. */
  types: TypeTerm[]
  colors: string[]
  colorMode: string
  identity: string[]
  mana: string
  stats: Condition[]
  formats: { status: string; format: string }[]
  sets: string
  rarities: string[]
  criteria: string[]
  /** Oracle tag slugs, each emitted as `otag:<slug>`. */
  tags: string[]
  /** '' | 'true' | 'false' — cards you own, cards you do not, or no filter. */
  binder: string
  prices: Condition[]
  artist: string
  lore: string
  keyword: string
  semantic: string
  sort: string
  order: string
}

/** One rules-text row: the phrase, and whether it is excluded. */
interface OracleTerm {
  not: boolean
  text: string
}

/** One type on the type line, and whether the card must or must not have it. */
interface TypeTerm {
  not: boolean
  value: string
}

/* The dropdown's headings.
 *
 * The catalog is one flat frequency-ordered list of every word that appears in
 * any type line, which runs to hundreds and puts Merfolk next to Legendary
 * next to Saga. These two lists are closed and short, so naming them costs
 * nothing and turns the list into something you can scan: the handful of
 * things a card *is*, the handful of words in front of that, and the several
 * hundred subtypes after. */
const SUPERTYPES = ['Basic', 'Legendary', 'Snow', 'World', 'Ongoing', 'Elite', 'Host']

const CARD_TYPES = [
  'Artifact', 'Battle', 'Conspiracy', 'Creature', 'Dungeon', 'Emblem',
  'Enchantment', 'Hero', 'Instant', 'Kindred', 'Land', 'Phenomenon', 'Plane',
  'Planeswalker', 'Scheme', 'Sorcery', 'Sticker', 'Tribal', 'Vanguard',
  'Attraction', 'Token',
]

const INITIAL: Builder = {
  name: '', oracle: [{ not: false, text: '' }], types: [],
  colors: [], colorMode: ':', identity: [], mana: '',
  stats: [{ a: 'mv', op: '<=', value: '' }],
  // Commander by default, matching withCommanderDefault() on the splash page.
  // Nearly every query here is for a Commander deck, and the row was starting
  // on "Choose a format" — which quietly meant no legality filter at all.
  formats: [{ status: 'legal', format: 'commander' }],
  sets: '', rarities: [], criteria: [], tags: [], binder: '',
  prices: [{ a: 'usd', op: '<=', value: '' }],
  artist: '', lore: '', keyword: '', semantic: '', sort: '', order: 'asc',
}

/** Assemble the query. The generated text is the real interface — users learn
 *  the syntax by watching this line update as they click. */
/** Keep one trailing empty row, drop any others. */
function trimTrailing(rows: OracleTerm[]): OracleTerm[] {
  const filled = rows.filter((r) => r.text.trim() || r.not)
  return [...filled, { not: false, text: '' }]
}

function buildQuery(b: Builder): string {
  const parts: string[] = []

  // q: must lead so the planner sees the prose before structured filters.
  if (b.semantic.trim()) parts.push(`q:"${b.semantic.trim().replace(/"/g, '')}"`)
  if (b.name.trim()) parts.push(quoteIfNeeded(b.name.trim()))
  // Always quoted, so a phrase with spaces needs no thought from the reader,
  // and a leading `-` when the row is negated.
  for (const term of b.oracle) {
    const text = term.text.trim().replace(/"/g, '')
    if (text) parts.push(`${term.not ? '-' : ''}o:"${text}"`)
  }
  if (b.lore.trim()) parts.push(`fo:"${b.lore.trim().replace(/"/g, '')}"`)

  for (const term of b.types) {
    const word = term.value.trim().toLowerCase()
    if (word) parts.push(`${term.not ? '-' : ''}t:${word}`)
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
  for (const tag of b.tags) parts.push(`otag:${tag}`)

  // Written as the negation rather than binder:false. Both work, but -binder:
  // is the form the rest of the syntax uses to exclude, so the generated line
  // stays a thing you could have typed.
  if (b.binder === 'true') parts.push('binder:true')
  else if (b.binder === 'false') parts.push('-binder:true')
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

/**
 * The type line, as a list of chosen types rather than two boxes of words.
 *
 * It used to be an include field and an exclude field, both space-separated,
 * which made `t:creature -t:token` two edits in two places and made a mistake
 * invisible: a type in the wrong box reads exactly like a type in the right
 * one. Each type is now its own row carrying its own answer, and changing your
 * mind about one is a click on that row rather than moving a word between
 * fields.
 *
 * Adding is shift-aware — shift-click, or shift-Enter, adds a type as NOT —
 * because half the time you already know you are excluding it, and arriving at
 * that through "add it, then toggle it" is two steps for one decision.
 */
function TypeLinePicker({
  terms, onChange,
}: { terms: TypeTerm[]; onChange: (next: TypeTerm[]) => void }) {
  const [draft, setDraft] = useState('')
  const [options, setOptions] = useState<string[]>([])
  const [open, setOpen] = useState(false)
  const [highlight, setHighlight] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    let cancelled = false
    const timer = window.setTimeout(() => {
      fetch(`/api/catalog/types?q=${encodeURIComponent(draft.trim())}&limit=50`)
        .then((r) => r.json())
        .then((data) => { if (!cancelled) { setOptions(data.values ?? []); setHighlight(0) } })
        .catch(() => { /* offline: typing a type by hand still works */ })
    }, draft ? 140 : 0)
    return () => { cancelled = true; window.clearTimeout(timer) }
  }, [draft])

  const has = (value: string) =>
    terms.some((t) => t.value.toLowerCase() === value.toLowerCase())

  const add = (value: string, not: boolean) => {
    const word = value.trim()
    if (!word || has(word)) return
    onChange([...terms, { not, value: word }])
    setDraft('')
    inputRef.current?.focus()
  }

  const toggle = (index: number) =>
    onChange(terms.map((t, i) => (i === index ? { ...t, not: !t.not } : t)))

  const remove = (index: number) => onChange(terms.filter((_, i) => i !== index))

  /* The catalog is one flat list; these are the headings it is shown under.
   * Anything that is not a known card type or supertype is a subtype, which
   * is the overwhelming majority and so goes last. */
  const grouped = useMemo(() => {
    const pool = options.filter((value) => !has(value))
    const pick = (names: string[]) =>
      pool.filter((v) => names.some((n) => n.toLowerCase() === v.toLowerCase()))
    const known = new Set([...SUPERTYPES, ...CARD_TYPES].map((n) => n.toLowerCase()))
    return [
      ['Types', pick(CARD_TYPES)],
      ['Supertypes', pick(SUPERTYPES)],
      ['Subtypes', pool.filter((v) => !known.has(v.toLowerCase()))],
    ].filter(([, list]) => (list as string[]).length) as [string, string[]][]
  }, [options, terms])

  /** The dropdown in one sequence, so the arrow keys cross the headings. */
  const flat = useMemo(() => grouped.flatMap(([, list]) => list), [grouped])

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (!flat.length) return
      event.preventDefault()
      setHighlight((h) => (h + (event.key === 'ArrowDown' ? 1 : -1) + flat.length) % flat.length)
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      // The highlighted suggestion, or what was typed if there is none: a type
      // the catalog has never heard of is still a legal thing to ask for.
      add(flat[highlight] ?? draft, event.shiftKey)
      return
    }
    // Backspace on an empty box takes the last one off, the way every token
    // field does.
    if (event.key === 'Backspace' && !draft && terms.length) {
      event.preventDefault()
      remove(terms.length - 1)
      return
    }
    if (event.key === 'Escape') setOpen(false)
  }

  return (
    <div className="type-line">
      <div className="type-field" onClick={() => inputRef.current?.focus()} role="presentation">
        {terms.map((term, i) => (
          <span className={`type-token${term.not ? ' not' : ''}`} key={`${term.value}-${i}`}>
            {/* `preventDefault` on mousedown, like the dropdown's own
                options: without it the press blurs the input, the blur
                schedules the list to close, and refocusing on the click that
                follows does not cancel the timer that is already running. So
                editing a token you can see closes the list you were reading
                it from. The press never moves focus now. */}
            <button
              type="button" className="tt-drop"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => remove(i)}
              title={`Remove ${term.value}`}
              aria-label={`Remove ${term.value}`}
            >
              ×
            </button>
            <button
              type="button" className="tt-mode"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => toggle(i)}
              title={term.not
                ? `Cards without ${term.value} — click for “is”`
                : `Cards with ${term.value} — click for “not”`}
              aria-label={`${term.value} is ${term.not ? 'excluded' : 'required'}`}
            >
              {term.not ? 'NOT' : 'IS'}
            </button>
            <span className="tt-name">{term.value}</span>
          </span>
        ))}
        <input
          ref={inputRef}
          className="tt-input"
          value={draft}
          placeholder={terms.length ? '' : 'Add a type, e.g. creature'}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => { setDraft(e.target.value); setOpen(true) }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 140)}
          onKeyDown={onKeyDown}
          aria-label="Add a type"
        />
      </div>

      {open && grouped.length > 0 && (
        <div className="ta-options type-options">
          {grouped.map(([heading, list]) => (
            <div key={heading}>
              <div className="tt-heading mono">{heading}</div>
              {list.map((value) => (
                <button
                  key={value}
                  type="button"
                  className={flat[highlight] === value ? 'active' : ''}
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseEnter={() => setHighlight(flat.indexOf(value))}
                  onClick={(e) => add(value, e.shiftKey)}
                >
                  {value}
                </button>
              ))}
            </div>
          ))}
          <div className="ta-hint mono">Enter adds · Shift adds as NOT</div>
        </div>
      )}
    </div>
  )
}

/**
 * Browse the Oracle Tagger vocabulary and toggle tags into the query.
 *
 * There are around 4,400 of these and they are slugs, not prose — nobody is
 * going to guess `repeatable-creature-tokens` from a blank field, which is why
 * this is a list you read rather than a box you complete. Unfiltered it shows
 * the ones covering the most cards, because those are the ones worth knowing.
 *
 * The chosen tags are pinned above the list and stay there whatever the filter
 * says. A tag you selected and then filtered out of view would otherwise be
 * stuck in the query with no way to click it off.
 */
function TagPicker({
  chosen, onToggle,
}: { chosen: string[]; onToggle: (slug: string) => void }) {
  const [filter, setFilter] = useState('')
  const [tags, setTags] = useState<string[]>([])
  const [total, setTotal] = useState(0)

  useEffect(() => {
    let cancelled = false
    // A beat behind the keystrokes, like the type-aheads: this is a query
    // against 4,400 rows, not a local array.
    const timer = window.setTimeout(() => {
      const ask = async (limit: number) => {
        const resp = await fetch(
          `/api/catalog/tags?q=${encodeURIComponent(filter.trim())}&limit=${limit}`,
        )
        if (!resp.ok) throw new Error(String(resp.status))
        return resp.json()
      }
      /* 120 if the server will give it, 50 if it will not.
       *
       * The catalog endpoint capped `limit` at 50 while every caller was a
       * ten-item type-ahead. This browser wants a page to read, so the cap was
       * raised — but a server built before that change answers 422, and an
       * installed copy is only rebuilt when someone gets round to it. Asking
       * for the better answer and accepting the older one costs one failed
       * request on old builds and nothing at all on new ones. */
      ask(120)
        .catch(() => ask(50))
        .then((data) => {
          if (cancelled) return
          setTags(data.values ?? [])
          setTotal(data.total ?? 0)
        })
        .catch(() => { /* the list stays as it was */ })
    }, filter ? 180 : 0)
    return () => { cancelled = true; window.clearTimeout(timer) }
  }, [filter])

  const shown = tags.filter((slug) => !chosen.includes(slug))

  return (
    <div className="tag-picker">
      <input
        className="fld"
        value={filter}
        placeholder="Search tags, e.g. “token”, “removal”, “ramp”"
        onChange={(e) => setFilter(e.target.value)}
        aria-label="Search oracle tags"
      />

      {chosen.length > 0 && (
        <div className="checks chosen-tags">
          {chosen.map((slug) => (
            <Check key={slug} on onClick={() => onToggle(slug)}>{slug}</Check>
          ))}
        </div>
      )}

      <div className="checks tag-list">
        {shown.map((slug) => (
          <Check key={slug} on={false} onClick={() => onToggle(slug)}>{slug}</Check>
        ))}
        {shown.length === 0 && (
          <span className="faint" style={{ fontSize: 12 }}>
            {filter.trim() ? 'No tag matches that.' : 'Tags are still loading.'}
          </span>
        )}
      </div>

      <p className="faint" style={{ fontSize: 11.5, margin: '6px 0 0' }}>
        {filter.trim()
          ? `${total} matching ${total === 1 ? 'tag' : 'tags'}${total > shown.length + chosen.length ? ', showing the first ' + shown.length : ''}.`
          : `${total} tags, most-used first. Type to find the rest.`}
      </p>
    </div>
  )
}

function Check({
  on, onClick, children, color,
}: { on: boolean; onClick: () => void; children: React.ReactNode; color?: string }) {
  return (
    <button
      type="button"
      className={`check ${on ? 'on' : ''}`}
      data-c={color}
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

  /* Always exactly one empty row at the end, and never two. Growing the list
   * on change rather than on blur means the next box is already there when the
   * reader looks for it. */
  const oracleRows = b.oracle.length ? b.oracle : [{ not: false, text: '' }]

  const query = useMemo(() => buildQuery(b), [b])

  const set = <K extends keyof Builder>(key: K, value: Builder[K]) =>
    setB((s) => ({ ...s, [key]: value }))

  const toggle = (key: 'colors' | 'identity' | 'rarities' | 'criteria' | 'tags', value: string) =>
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

      <div className="adv-form">
        <Row label="Card Name" hint="Any words in the name, e.g. “Fire”">
          <input
            className="fld" value={b.name} placeholder="Any words in the name"
            onChange={(e) => set('name', e.target.value)}
          />
        </Row>

        {/* A stack rather than one field. Rules text is the one thing people
            genuinely want several of -- "draws a card" and "sacrifice", one of
            them excluded -- and a single box makes that impossible without
            knowing the syntax. A new empty row appears as soon as the last one
            has anything in it, so the form grows by being used. */}
        <Row
          label="Text"
          hint={'Any text, e.g. “draw a card”. Use _ for any run of text, '
            + '# for any creature type. NOT excludes a row.'}
        >
          <div className="stack gap-1">
            {oracleRows.map((term, i) => (
              <div className="cond-row" key={i}>
                <button
                  className={term.not ? 'btn btn-danger sm' : 'btn btn-ghost sm'}
                  aria-pressed={term.not}
                  title={term.not ? 'Excluding this text' : 'Require this text'}
                  onClick={() => {
                    const next = [...oracleRows]
                    next[i] = { ...next[i], not: !next[i].not }
                    set('oracle', trimTrailing(next))
                  }}
                  style={{ flex: 'none', minWidth: 46 }}
                >
                  NOT
                </button>
                <input
                  className="fld"
                  value={term.text}
                  placeholder={i === 0 ? 'Rules text contains…' : 'and also…'}
                  onChange={(e) => {
                    const next = [...oracleRows]
                    next[i] = { ...next[i], text: e.target.value }
                    set('oracle', trimTrailing(next))
                  }}
                />
                {oracleRows.length > 1 && (
                  <button
                    className="btn btn-ghost sm"
                    aria-label="Remove this text"
                    onClick={() => set('oracle', trimTrailing(
                      oracleRows.filter((_, j) => j !== i),
                    ))}
                    style={{ flex: 'none' }}
                  >
                    ✕
                  </button>
                )}
              </div>
            ))}
          </div>
        </Row>

        <Row
          label="Type Line"
          hint="Each type is required or excluded on its own. Click IS to flip it."
        >
          <TypeLinePicker terms={b.types} onChange={(next) => set('types', next)} />
        </Row>

        <Row label="Colors" hint="The colors in the card’s mana cost">
          <div className="checks">
            {COLORS.map(([code, label]) => (
              <Check
                key={code} color={code} on={b.colors.includes(code)}
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
            aria-label="Color comparison"
          >
            {COLOR_MODES.map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
        </Row>

        <Row label="Commander" hint="Color identity, for Commander decks">
          <div className="checks">
            {COLORS.filter(([c]) => c !== 'C').map(([code, label]) => (
              <Check
                key={code} color={code} on={b.identity.includes(code)}
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

        <Row label="Sets" hint="The newest sets to start with; narrows as you type.">
          <TypeAhead
            kind="sets" value={b.sets} onChange={(v) => set('sets', v)}
            placeholder="Enter a set name or code"
            // Nobody remembers set codes, and the set you want is usually a
            // recent one, so the list opens on the newest rather than empty.
            suggestWhenEmpty
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

        {/* A fact about this install rather than about the card, which is why
            it sits in its own row rather than among the `is:` criteria. */}
        <Row label="Collection" hint="Restrict to what your binder does or does not hold.">
          <div className="checks">
            <Check
              on={b.binder === 'true'}
              onClick={() => set('binder', b.binder === 'true' ? '' : 'true')}
            >
              Only Binder
            </Check>
            <Check
              on={b.binder === 'false'}
              onClick={() => set('binder', b.binder === 'false' ? '' : 'false')}
            >
              Not in Binder
            </Check>
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

        {/* Last, and deliberately so. Everything above is a property of the
            card as printed; a tag is somebody's judgement about what the card
            *does*, which is the most powerful filter here and the one you
            reach for once the obvious ones have not narrowed it enough. */}
        <Row
          label="Oracle tags"
          hint="What a card does, from Scryfall's Tagger. Click to add; all selected tags must match."
        >
          <TagPicker chosen={b.tags} onToggle={(slug) => toggle('tags', slug)} />
        </Row>
      </div>

    </section>
  )
}
