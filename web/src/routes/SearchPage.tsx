import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'

import { api, streamSemantic, type Card, type SearchResponse } from '../lib/api'
import { countTo, revealTitle, riseIn } from '../lib/motion'
import { hasSemantic } from '../lib/query'
import { CardGrid, GridSkeleton } from '../components/CardGrid'
import { SearchBar } from '../components/SearchBar'
import { SemanticConsole, type ConsoleState } from '../components/SemanticConsole'

const SORTS = [
  ['name', 'Name'],
  ['edhrec', 'Popularity'],
  ['cmc', 'Mana value'],
  ['usd', 'Price'],
  ['released', 'Release date'],
  ['rarity', 'Rarity'],
  ['color', 'Colour'],
]

const EMPTY_CONSOLE: ConsoleState = {
  running: false,
  stages: [],
  current: '',
  error: null,
  model: 'llama3.3:70b',
}

export function SearchPage() {
  const [params, setParams] = useSearchParams()
  const query = params.get('q') ?? ''

  const [draft, setDraft] = useState(query)
  const [results, setResults] = useState<SearchResponse | null>(null)
  const [semanticCards, setSemanticCards] = useState<Card[] | null>(null)
  const [console_, setConsole] = useState<ConsoleState>(EMPTY_CONSOLE)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [view, setView] = useState<'grid' | 'list'>('grid')
  const [sort, setSort] = useState('name')
  const [order, setOrder] = useState<'asc' | 'desc'>('asc')

  const heroRef = useRef<HTMLHeadingElement>(null)
  const countRef = useRef<HTMLSpanElement>(null)
  const toolbarRef = useRef<HTMLDivElement>(null)
  const closeStream = useRef<(() => void) | null>(null)

  useEffect(() => setDraft(query), [query])

  useLayoutEffect(() => {
    if (!query) revealTitle(heroRef.current)
  }, [query])

  // Fetch the model name once so the console labels itself accurately.
  useEffect(() => {
    api
      .semanticStatus()
      .then((s) => setConsole((c) => ({ ...c, model: s.model })))
      .catch(() => {})
  }, [])

  const runSemantic = useCallback((q: string) => {
    setSemanticCards(null)
    setResults(null)
    setError(null)
    setLoading(true)
    setConsole((c) => ({ ...EMPTY_CONSOLE, model: c.model, running: true }))

    closeStream.current?.()
    closeStream.current = streamSemantic(q, {
      onStage: (stage) =>
        setConsole((c) => ({
          ...c,
          stages: [...c.stages, stage],
          current: stage.stage,
        })),
      onComplete: (stage) => {
        setConsole((c) => ({
          ...c,
          stages: [...c.stages, stage],
          current: 'complete',
          running: false,
        }))
        setSemanticCards(stage.detail.cards ?? [])
        setLoading(false)
      },
      onError: (message) => {
        setConsole((c) => ({ ...c, running: false, error: message }))
        setError(message)
        setLoading(false)
      },
    })
  }, [])

  const runStandard = useCallback(
    async (q: string, nextSort: string, nextOrder: string) => {
      setLoading(true)
      setError(null)
      setSemanticCards(null)
      try {
        const response = await api.search({
          q,
          sort: nextSort,
          order: nextOrder,
          per_page: 60,
        })
        setResults(response)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Search failed')
        setResults(null)
      } finally {
        setLoading(false)
      }
    },
    [],
  )

  useEffect(() => {
    if (!query) {
      setResults(null)
      setSemanticCards(null)
      setConsole(EMPTY_CONSOLE)
      return
    }
    if (hasSemantic(query)) {
      runSemantic(query)
    } else {
      runStandard(query, sort, order)
    }
    return () => closeStream.current?.()
  }, [query, sort, order, runSemantic, runStandard])

  const cards = semanticCards ?? results?.cards ?? []
  const total = semanticCards ? semanticCards.length : (results?.total ?? 0)
  const engine = semanticCards ? 'semantic' : (results?.engine ?? 'none')

  useEffect(() => {
    if (!loading && cards.length) {
      countTo(countRef.current, total)
      riseIn(toolbarRef.current)
    }
  }, [loading, total, cards.length])

  const submit = (next: string) => {
    const trimmed = next.trim()
    if (!trimmed) {
      setParams({})
      return
    }
    setParams({ q: trimmed })
  }

  return (
    <>
      <section className="shell hero">
        {!query && (
          <>
            <h1 className="hero-title" ref={heroRef}>
              Search the <em data-nosplit>multiverse</em>.
            </h1>
            <p className="hero-sub">
              Every printed card, queryable. Full operator syntax, a wildcard the API doesn’t
              have, and a local 70B model that reads your intent without ever inventing a card.
            </p>
          </>
        )}

        <SearchBar
          value={draft}
          onChange={setDraft}
          onSubmit={submit}
          showExamples={!query}
          autoFocus={!query}
        />

        {!query && (
          <div className="row wrap gap-3" style={{ marginTop: 'var(--gap-5)' }}>
            <Link to="/advanced" className="btn">
              Build a query →
            </Link>
            <Link to="/deck" className="btn btn-ghost">
              Analyse a decklist →
            </Link>
          </div>
        )}
      </section>

      <section className="shell">
        {query && hasSemantic(query) && <SemanticConsole state={console_} />}

        {error && (
          <div className="notice error">
            <h3>Search failed</h3>
            <p>{error}</p>
          </div>
        )}

        {loading && !semanticCards && !hasSemantic(query) && <GridSkeleton />}

        {!loading && query && cards.length === 0 && !error && (
          <div className="notice">
            <h3>No cards matched</h3>
            <p>
              Nothing in the database satisfies <code className="mono">{query}</code>. Try
              loosening a filter, or check the{' '}
              <Link to="/glossary" style={{ borderBottom: '1px solid' }}>
                syntax reference
              </Link>
              .
            </p>
          </div>
        )}

        {cards.length > 0 && (
          <>
            <div className="toolbar" ref={toolbarRef}>
              <span className="count">
                <b ref={countRef}>{total.toLocaleString()}</b>{' '}
                {total === 1 ? 'card' : 'cards'}
                {results?.has_more && ' (page 1)'}
              </span>
              <span className={`engine-badge ${engine}`}>{engine}</span>

              <div className="push row gap-2">
                {!semanticCards && (
                  <>
                    <select
                      className="field"
                      style={{ width: 'auto' }}
                      value={sort}
                      onChange={(e) => setSort(e.target.value)}
                      aria-label="Sort by"
                    >
                      {SORTS.map(([value, label]) => (
                        <option key={value} value={value}>
                          {label}
                        </option>
                      ))}
                    </select>
                    <button
                      className="btn btn-ghost"
                      onClick={() => setOrder(order === 'asc' ? 'desc' : 'asc')}
                      title="Toggle sort direction"
                    >
                      {order === 'asc' ? '↑' : '↓'}
                    </button>
                  </>
                )}
                <button
                  className="btn btn-ghost"
                  onClick={() => setView(view === 'grid' ? 'list' : 'grid')}
                >
                  {view === 'grid' ? 'List' : 'Grid'}
                </button>
              </div>
            </div>

            <CardGrid cards={cards} view={view} />
          </>
        )}

        {results?.warnings && results.warnings.length > 0 && (
          <p className="faint mono" style={{ marginTop: 'var(--gap-3)', fontSize: 'var(--step--2)' }}>
            {results.warnings.join(' · ')}
          </p>
        )}
      </section>
    </>
  )
}
