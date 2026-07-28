import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'

import { api, streamSemantic, type Card } from '../lib/api'
import { history, useHistory } from '../lib/history'
import { countTo, riseIn } from '../lib/motion'
import { hasSemantic, withCommanderDefault } from '../lib/query'
import {
  cacheKey, forgetQuery, fromResponse, readCache, rememberScroll, writeCache,
} from '../lib/searchCache'
import { SIZE_KEY, usePersisted, VIEW_KEY } from '../lib/usePersisted'
import { collection } from '../lib/collection'
import { CardGrid, GridSkeleton } from '../components/CardGrid'
import { ShuffleTriage } from '../components/ShuffleTriage'
import { BackLink } from '../components/PageHead'
import { SearchBar } from '../components/SearchBar'
import { ScrollTop } from '../components/ScrollTop'
import { EMPTY_CONSOLE, SemanticConsole, type ConsoleState } from '../components/SemanticConsole'

/** Server page size. The API caps a page at 175; 60 keeps a page quick to
 *  render and quick to scan. */
const PER_PAGE = 60

const SORTS = [
  ['name', 'Name'],
  ['edhrec', 'Popularity'],
  ['cmc', 'Mana value'],
  ['usd', 'Price'],
  ['released', 'Release date'],
  ['rarity', 'Rarity'],
  ['color', 'Colour'],
]

/** Sort an already-fetched list. Used for `q:` results, which arrive whole and
 *  must not be re-run just to reorder them. */
function sortCards(cards: Card[], key: string, direction: 'asc' | 'desc'): Card[] {
  const sign = direction === 'desc' ? -1 : 1
  const value = (card: Card): number | string => {
    switch (key) {
      case 'cmc': return card.cmc ?? 0
      case 'usd': return card.usd ?? Number.POSITIVE_INFINITY
      case 'edhrec': return card.edhrec_rank ?? Number.POSITIVE_INFINITY
      case 'released': return card.released_at ?? ''
      case 'rarity': return ['common', 'uncommon', 'rare', 'special', 'mythic', 'bonus']
        .indexOf(card.rarity ?? 'common')
      case 'color': return card.color_identity || 'ZZZ'
      default: return card.name.toLowerCase()
    }
  }
  return [...cards].sort((a, b) => {
    const av = value(a)
    const bv = value(b)
    if (av === bv) return a.name.localeCompare(b.name)
    return (av < bv ? -1 : 1) * sign
  })
}

export function SearchPage() {
  const [params, setParams] = useSearchParams()
  const query = params.get('q') ?? ''

  const [draft, setDraft] = useState(query)
  const [cards, setCards] = useState<Card[]>([])
  const [total, setTotal] = useState(0)
  const [engine, setEngine] = useState<string>('none')
  const [console_, setConsole] = useState<ConsoleState>(EMPTY_CONSOLE)
  const [collapsed, setCollapsed] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [view, setView] = usePersisted<'grid' | 'list'>(VIEW_KEY, 'grid')
  const [sort, setSort] = useState('name')
  const [order, setOrder] = useState<'asc' | 'desc'>('asc')
  const [cardSize, setCardSize] = usePersisted(SIZE_KEY, 190)
  const [paperCards, setPaperCards] = useState(0)
  const [shuffling, setShuffling] = useState(false)
  /** 1-based. Lives in the URL so a page is linkable and survives a reload. */
  const page = Math.max(1, Number(params.get("page") ?? 1))

  const countRef = useRef<HTMLSpanElement>(null)
  const heroCountRef = useRef<HTMLSpanElement>(null)
  const toolbarRef = useRef<HTMLDivElement>(null)
  const stream = useRef<{ stop: () => void } | null>(null)
  const recent = useHistory()

  // Semantic results arrive as one batch and are sorted here; everything else
  // is sorted by the server, so the cache key includes sort/order.
  const isSemanticQuery = hasSemantic(query)
  const totalPages = Math.max(1, Math.ceil(total / PER_PAGE))
  const key = cacheKey(query, isSemanticQuery ? "" : sort, isSemanticQuery ? "" : order, page)

  useEffect(() => setDraft(query), [query])

  // Hero count: the number of paper cards actually in the mirror.
  useEffect(() => {
    api.health().then((h) => setPaperCards(h.paper_cards)).catch(() => {})
    api
      .semanticStatus()
      .then((s) => setConsole((c) => ({ ...c, model: s.model })))
      .catch(() => {})
  }, [])

  useEffect(() => {
    if (!query && paperCards) countTo(heroCountRef.current, paperCards)
  }, [paperCards, query])

  // Remember where the user was so returning from a card lands in place.
  useEffect(() => {
    const remember = () => rememberScroll(key, window.scrollY)
    window.addEventListener('scroll', remember, { passive: true })
    return () => {
      remember()
      window.removeEventListener('scroll', remember)
    }
  }, [key])

  const runSemantic = useCallback((q: string) => {
    setCards([])
    setError(null)
    setLoading(true)
    setCollapsed(false)
    setConsole((c) => ({ ...EMPTY_CONSOLE, model: c.model, running: true }))

    stream.current?.stop()
    stream.current = streamSemantic(q, {
      onStage: (stage) =>
        setConsole((c) => ({ ...c, stages: [...c.stages, stage], current: stage.stage })),
      onComplete: (stage) => {
        setConsole((c) => {
          const stages = [...c.stages, stage]
          writeCache(cacheKey(q, sort, order), {
            cards: stage.detail.cards ?? [],
            total: stage.detail.cards?.length ?? 0,
            engine: 'semantic',
            hasMore: false,
            warnings: [],
            stages,
            scrollY: 0,
          })
          return { ...c, stages, current: 'complete', running: false }
        })
        const found = stage.detail.cards ?? []
        setCards(found)
        setTotal(found.length)
        setEngine('semantic')
        setLoading(false)
        history.record(q, found.length, 'semantic')
        // The log has served its purpose once cards are on screen.
        setCollapsed(true)
      },
      onCancelled: () => {
        setConsole((c) => ({ ...c, running: false, cancelled: true }))
        setLoading(false)
      },
      onError: (message) => {
        setConsole((c) => ({ ...c, running: false, error: message }))
        setError(message)
        setLoading(false)
      },
    })
  }, [sort, order])

  const runStandard = useCallback(async (q: string, s: string, o: string, p: number) => {
    setLoading(true)
    setError(null)
    try {
      const response = await api.search({ q, sort: s, order: o, page: p, per_page: PER_PAGE })
      setCards(response.cards)
      setTotal(response.total)
      setEngine(response.engine)
      writeCache(cacheKey(q, s, o, p), fromResponse(response))
      history.record(q, response.total, response.engine)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Search failed')
      setCards([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!query) {
      setCards([])
      setTotal(0)
      setEngine('none')
      setConsole(EMPTY_CONSOLE)
      return
    }

    // Restore rather than re-run. This is the difference between returning
    // from a card instantly and waiting minutes for a q: run all over again.
    const cached = readCache(key)
    if (cached) {
      setCards(cached.cards)
      setTotal(cached.total)
      setEngine(cached.engine)
      if (cached.stages) {
        setConsole((c) => ({
          ...EMPTY_CONSOLE, model: c.model, stages: cached.stages!, current: 'complete',
        }))
        setCollapsed(true)
      }
      setLoading(false)
      requestAnimationFrame(() => window.scrollTo(0, cached.scrollY))
      return
    }

    if (isSemanticQuery) runSemantic(query)
    else runStandard(query, sort, order, page)

    return () => stream.current?.stop()
  }, [query, sort, order, page, key, isSemanticQuery, runSemantic, runStandard])

  useEffect(() => {
    if (!loading && cards.length) {
      countTo(countRef.current, total)
      riseIn(toolbarRef.current)
    }
  }, [loading, total, cards.length])

  const submit = (next: string) => {
    const trimmed = withCommanderDefault(next.trim())
    // A new search always starts at page 1; keeping the old page would show
    // results from the middle of a list you have not seen the start of.
    setParams(trimmed ? { q: trimmed } : {})
  }

  const goToPage = (next: number) => {
    const params_ = new URLSearchParams(params)
    if (next <= 1) params_.delete("page")
    else params_.set("page", String(next))
    setParams(params_)
    window.scrollTo({ top: 0 })
  }

  const stopRun = () => {
    stream.current?.stop()
    setConsole((c) => ({ ...c, running: false, cancelled: true }))
    setLoading(false)
  }

  const isSemantic = hasSemantic(query)
  const showConsole = Boolean(query) && isSemantic && console_.stages.length > 0
  const consoleEl = showConsole && (
    <SemanticConsole
      state={console_}
      collapsed={collapsed}
      onToggle={() => setCollapsed((c) => !c)}
      onStop={stopRun}
      below={collapsed && cards.length > 0}
    />
  )

  return (
    <>
      {/* Only once there is a query. The splash state is the top of the app --
          there is nowhere for Back to go from there. */}
      {query && (
        <div className="shell page-back">
          <BackLink />
        </div>
      )}
      <section className="shell hero">
        {!query && (
          <>
            <h1 className="hero-title">
              Scry{' '}
              <span className="hero-count">
                <span ref={heroCountRef}>{paperCards || '—'}</span>
              </span>
            </h1>
            <hr className="manaline" style={{ maxWidth: 420, marginTop: 10 }} />
            <p className="lede hero-sub">
              Every paper card in print, queryable. Full operator syntax, a wildcard the API
              doesn’t have, and a local 70B model that reads your intent without ever inventing
              a card.
            </p>
          </>
        )}

        <SearchBar
          value={draft}
          onChange={setDraft}
          onSubmit={submit}
          autoFocus={!query}
        />

        {!query && (
          <>
            <div className="row wrap gap-2" style={{ marginTop: 34 }}>
              <Link to="/advanced" className="btn">Build a query</Link>
              <Link to="/deck" className="btn btn-ghost">Analyse a decklist</Link>
            </div>

            {recent.length > 0 && (
              <div className="history">
                <div className="row" style={{ justifyContent: 'space-between', marginBottom: 6 }}>
                  <span className="label">Recent searches</span>
                  <button className="btn btn-ghost sm" onClick={() => history.clear()}>
                    Clear
                  </button>
                </div>
                <table>
                  <thead>
                    <tr>
                      <th>Query</th>
                      <th style={{ textAlign: 'right' }}>Results</th>
                      <th style={{ textAlign: 'right' }}>Engine</th>
                    </tr>
                  </thead>
                  <tbody>
                    {recent.map((entry) => (
                      <tr
                        key={entry.query}
                        onClick={() => { setDraft(entry.query); submit(entry.query) }}
                        title="Run this search again"
                      >
                        <td className="q">{entry.query}</td>
                        <td className="n">{entry.total.toLocaleString()}</td>
                        <td className="n">
                          <span className={`engine-badge ${entry.engine}`}>{entry.engine}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </section>

      <section className="shell">
        {/* Expanded: above the results. Collapsed: tucked below them. */}
        {!collapsed && consoleEl}

        {error && (
          <div className="notice error">
            <h3>Search failed</h3>
            <p>{error}</p>
          </div>
        )}

        {loading && !isSemantic && <GridSkeleton size={cardSize} />}

        {!loading && query && cards.length === 0 && !error && !console_.running && (
          <div className="notice">
            <h3>No cards matched</h3>
            <p>
              Nothing satisfies <code className="mono">{query}</code>. Try loosening a filter, or
              check the <Link to="/glossary" style={{ borderBottom: '1px solid' }}>syntax
              reference</Link>.
            </p>
          </div>
        )}

        {cards.length > 0 && (
          <>
            <div className="toolbar" ref={toolbarRef}>
              <span className="count">
                <b ref={countRef}>{total.toLocaleString()}</b> {total === 1 ? 'card' : 'cards'}
                {totalPages > 1 && ` · page ${page} of ${totalPages}`}
              </span>
              <span className={`engine-badge ${engine}`}>{engine}</span>

              <div className="push row gap-2 wrap">
                {view === 'grid' && (
                  <label className="size-slider" title="Card size">
                    <span className="label">Size</span>
                    <input
                      type="range"
                      min={110}
                      max={340}
                      step={10}
                      value={cardSize}
                      onChange={(e) => setCardSize(Number(e.target.value))}
                      aria-label="Card image size"
                    />
                  </label>
                )}
                <select
                  className="fld"
                  style={{ width: 'auto' }}
                  value={sort}
                  onChange={(e) => setSort(e.target.value)}
                  aria-label="Sort by"
                >
                  {SORTS.map(([value, label]) => (
                    <option key={value} value={value}>Sort: {label}</option>
                  ))}
                </select>
                <button
                  className="btn btn-ghost sm"
                  onClick={() => setOrder(order === 'asc' ? 'desc' : 'asc')}
                  title="Toggle sort direction"
                >
                  {order === 'asc' ? '↑' : '↓'}
                </button>
                <button
                  className="btn btn-ghost sm"
                  onClick={() => setView(view === 'grid' ? 'list' : 'grid')}
                >
                  {view === 'grid' ? 'List' : 'Grid'}
                </button>
                <button
                  className="btn sm"
                  onClick={() => setShuffling(true)}
                  title="Go through these one at a time, keeping or discarding each"
                >
                  Shuffle
                </button>
              </div>
            </div>

            <CardGrid
              cards={isSemanticQuery ? sortCards(cards, sort, order) : cards}
              view={view}
              size={cardSize}
            />

            {/* Semantic runs return every match in one batch, so they have no
                pages to turn. */}
            {!isSemanticQuery && totalPages > 1 && (
              <div className="pager">
                <button
                  className="btn btn-ghost sm"
                  onClick={() => goToPage(page - 1)}
                  disabled={page <= 1 || loading}
                >
                  ← Previous
                </button>
                <span className="mono faint">
                  {((page - 1) * PER_PAGE + 1).toLocaleString()}–
                  {Math.min(page * PER_PAGE, total).toLocaleString()} of {total.toLocaleString()}
                </span>
                <button
                  className="btn btn-ghost sm"
                  onClick={() => goToPage(page + 1)}
                  disabled={page >= totalPages || loading}
                >
                  Next →
                </button>
              </div>
            )}
          </>
        )}

        {shuffling && (
          <ShuffleTriage
            cards={cards}
            onClose={() => setShuffling(false)}
            onSubmit={(kept, discarded) => {
              kept.forEach((card) => collection.add(card))
              const dropped = new Set(discarded.map((c) => c.oracle_id))
              setCards((current) => current.filter((c) => !dropped.has(c.oracle_id)))
              // Every cached page of this query still holds the discarded
              // cards, and turning a page would bring them straight back.
              // A new search repopulates the cache, which is the reset.
              forgetQuery(query)
              setShuffling(false)
            }}
          />
        )}

        {collapsed && consoleEl}

        <ScrollTop watch={toolbarRef} ready={cards.length > 0} />
      </section>
    </>
  )
}
