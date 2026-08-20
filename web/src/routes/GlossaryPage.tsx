import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'

import { api } from '../lib/api'
import { FIELDS } from '../lib/query'
import { dissolveIn, riseIn } from '../lib/motion'
import { Lessons } from '../components/Lessons'
import { PageHead } from '../components/PageHead'

interface Symbol_ {
  symbol: string
  english: string
  svg_uri: string
  represents_mana: boolean
}

interface Tag {
  slug: string
  label: string
  description: string
  card_count: number
}

/** Operator reference. Insight Engine-only entries are called out explicitly. */
const SYNTAX_ROWS: [string, string, boolean][] = [
  ['c:red  c<=wu  c=rg', 'Card color — and possibly more / and no others / exactly', false],
  ['id<=bg', 'Color identity, for Commander', false],
  ['t:creature  -t:artifact', 'Type line, negatable', false],
  ['o:"draw a card"', 'Rules text contains the phrase', false],
  ['o:"Elf_creature"', 'Wildcard: _ matches any run of text', true],
  ['q:"sacrifice for value"', 'Ask the local 70B model; put it first', true],
  ['otag:sacrifice-outlet-creature', 'Scryfall Tagger functional tag', true],
  ['binder:true  -binder:true', 'In your binder, or not in it', true],
  ['mv<=3  pow>=4  tou<2', 'Numeric comparisons', false],
  ['r:mythic  r>=rare', 'Rarity, orderable', false],
  ['s:mh3  a:"Rebecca Guay"', 'Set code, artist', false],
  ['legal:commander  banned:modern', 'Format status', false],
  ['is:commander  is:dfc  is:hybrid', 'Card properties', false],
  ['kw:flying  produces:g', 'Keyword ability, mana produced', false],
  ['usd<=1  eur>=20  year>=2023', 'Price and release year', false],
  ['!"Lightning Bolt"', 'Exact name match', false],
  ['(c:red or c:blue) -is:funny', 'Grouping, OR, negation', false],
]

export function GlossaryPage() {
  const [symbols, setSymbols] = useState<Symbol_[]>([])
  const [frequency, setFrequency] = useState<Record<string, number>>({})
  const [tags, setTags] = useState<Tag[]>([])
  const [tagQuery, setTagQuery] = useState('')
  const rootRef = useRef<HTMLElement>(null)
  const tagRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    api
      .glossary()
      .then((g) => {
        setSymbols(g.symbols.filter((s) => s.represents_mana))
        setFrequency(g.frequency)
      })
      .catch(() => {})
    riseIn(rootRef.current)
  }, [])

  useEffect(() => {
    const timer = setTimeout(() => {
      api.tags(tagQuery, 48).then((r) => setTags(r.tags)).catch(() => {})
    }, 200)
    return () => clearTimeout(timer)
  }, [tagQuery])

  useEffect(() => {
    if (tagRef.current) dissolveIn(tagRef.current.querySelectorAll('.kw'), { stagger: 0.006 })
  }, [tags])

  const topKeywords = Object.entries(frequency).slice(0, 60)

  return (
    <section className="shell" ref={rootRef}>
      {/* Lessons first: this is the page you already come to when you want to
          know how something works, so being taught comes before the reference
          you would otherwise have to already understand. */}
      <PageHead eyebrow="Reference" title="Lessons" />
      <Lessons />

      {/* A section heading, not a second page head. `PageHead` carries the
          back control and the eyebrow, and one page has one of each — two gave
          the Glossary a duplicate Back and a second "Reference" under the
          first. */}
      <div className="page-section">
        <h2>Syntax &amp; symbols</h2>
        <p className="muted">
          Every operator the search bar understands, the mana symbols, the keywords
          players actually use, and the tag vocabulary the semantic engine draws from.
        </p>
      </div>

      <div className="panel" style={{ marginBottom: 'var(--gap-4)' }}>
        <h3>Query syntax</h3>
        <div className="scroll-x">
          <table className="card-list">
            <thead>
              <tr>
                <th>Operator</th>
                <th>Meaning</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {SYNTAX_ROWS.map(([syntax, meaning, exclusive]) => (
                <tr key={syntax}>
                  <td className="mono" style={{ whiteSpace: 'nowrap' }}>{syntax}</td>
                  <td className="muted">{meaning}</td>
                  <td>
                    {exclusive && (
                      <span className="chip on" style={{ fontSize: 'var(--step--2)' }}>
                        Insight Engine only
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="faint" style={{ fontSize: 'var(--step--2)', marginTop: 'var(--gap-2)' }}>
          Recognised field names: {Object.keys(FIELDS).join(', ')}
        </p>
      </div>

      {symbols.length > 0 && (
        <div className="panel" style={{ marginBottom: 'var(--gap-4)' }}>
          <h3>Mana symbols</h3>
          <div className="symbol-grid">
            {symbols.map((symbol) => (
              <div className="symbol-cell" key={symbol.symbol}>
                <img src={symbol.svg_uri} alt={symbol.symbol} loading="lazy" />
                <div style={{ minWidth: 0 }}>
                  <div className="mono">{symbol.symbol}</div>
                  <div className="faint">{symbol.english}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {topKeywords.length > 0 && (
        <div className="panel" style={{ marginBottom: 'var(--gap-4)' }}>
          <h3>Keywords by frequency</h3>
          <div className="kw-cloud">
            {topKeywords.map(([keyword, count]) => (
              <Link key={keyword} to={`/?q=${encodeURIComponent(`kw:${keyword}`)}`} className="kw">
                {keyword} <b>{count}</b>
              </Link>
            ))}
          </div>
        </div>
      )}

      <div className="panel">
        <div className="row wrap gap-2" style={{ justifyContent: 'space-between', marginBottom: 'var(--gap-2)' }}>
          <h3 style={{ margin: 0 }}>Oracle tags</h3>
          <input
            className="fld"
            style={{ width: 'auto' }}
            placeholder="Search tags — e.g. sacrifice, tutor"
            value={tagQuery}
            onChange={(e) => setTagQuery(e.target.value)}
          />
        </div>
        <p className="faint" style={{ fontSize: 'var(--step--2)', marginBottom: 'var(--gap-2)' }}>
          Human-curated functional labels from Scryfall Tagger. The semantic engine picks from
          this closed vocabulary rather than guessing at rules text, which is what keeps its
          recall high and its output grounded.
        </p>
        <div className="kw-cloud" ref={tagRef}>
          {tags.map((tag) => (
            <Link
              key={tag.slug}
              to={`/?q=${encodeURIComponent(`otag:${tag.slug}`)}`}
              className="kw"
              title={tag.description}
            >
              {tag.slug} <b>{tag.card_count}</b>
            </Link>
          ))}
        </div>
      </div>
    </section>
  )
}
