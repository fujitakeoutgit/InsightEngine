import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'

import { api, streamSemantic, type Card } from '../lib/api'
import { history, useHistory } from '../lib/history'
import { attachMagnet, canAnimate, countTo, gsap, riseIn, splitChars } from '../lib/motion'
import { hasSemantic, withCommanderDefault } from '../lib/query'
import {
  cacheKey, forgetQuery, fromResponse, readCache, rememberScroll, writeCache,
} from '../lib/searchCache'
import {
  OVERLAY_KEY, SIZE_KEY, SORT_DIR_KEY, SORT_KEY, usePersisted, useSortDir, VIEW_KEY,
} from '../lib/usePersisted'
import { useBinderIds } from '../lib/binderIds'
import { collection } from '../lib/collection'
import { CardGrid, GridSkeleton } from '../components/CardGrid'
import { CardMenu } from '../components/CardMenu'
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
  ['color', 'Color'],
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
  const [sort, setSort] = usePersisted<string>(SORT_KEY, 'name')
  const [order, setOrder] = useSortDir(SORT_DIR_KEY, sort)
  const [cardSize, setCardSize] = usePersisted(SIZE_KEY, 190)
  /* Marking what you already own, off by default. It costs a fetch of the
   * binder and, more to the point, a gold edge on half the grid is noise
   * unless you asked the question. */
  const [markOwned, setMarkOwned] = usePersisted('insight-enigma:mark-owned', false)
  const binderIds = useBinderIds(markOwned)
  const [paperCards, setPaperCards] = useState(0)
  const [shuffling, setShuffling] = useState(false)
  const [picked, setPicked] = useState<{ card: Card; at: { x: number; y: number } } | null>(null)
  /** 1-based. Lives in the URL so a page is linkable and survives a reload. */
  const page = Math.max(1, Number(params.get("page") ?? 1))

  const countRef = useRef<HTMLSpanElement>(null)
  const [pinOverlay, setPinOverlay] = usePersisted<boolean>(OVERLAY_KEY, false)
  const [updateReady, setUpdateReady] = useState(false)
  const heroCountRef = useRef<HTMLSpanElement>(null)
  const heroRef = useRef<HTMLHeadingElement>(null)
  const heroRuleRef = useRef<HTMLHRElement>(null)
  const heroLedeRef = useRef<HTMLParagraphElement>(null)
  const ctaRef = useRef<HTMLDivElement>(null)
  const toolbarRef = useRef<HTMLDivElement>(null)
  const stream = useRef<{ stop: () => void } | null>(null)
  const restoreTimer = useRef<number | undefined>(undefined)
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
    /* Whether Scryfall has cards this mirror does not. Read from what the last
     * startup check recorded, so it costs no network here. */
    api.syncStatus().then((s) => setUpdateReady(Boolean(s.update_available))).catch(() => {})
    api
      .semanticStatus()
      .then((s) => setConsole((c) => ({ ...c, model: s.model })))
      .catch(() => {})
  }, [])

  useEffect(() => {
    if (!query && paperCards) countTo(heroCountRef.current, paperCards)
  }, [paperCards, query])

  /* The splash choreography: title characters resolve out of blur, the
   * manaline draws itself underneath while they land, then the lede and the
   * two calls to action rise in. One timeline, so the parts arrive as a
   * sequence rather than four things that happen to start together.
   *
   * The count keeps its text nodes intact (data-nosplit): it is painted with
   * background-clip gradient text, which stops painting if a descendant
   * becomes inline-block — and countTo rewrites its textContent anyway. */
  useLayoutEffect(() => {
    if (query || !heroRef.current) return
    const chars = splitChars(heroRef.current)
    const rest = [heroRuleRef.current, heroLedeRef.current, ctaRef.current].filter(Boolean)
    if (!canAnimate()) {
      gsap.set(chars, { opacity: 1, yPercent: 0, scale: 1, filter: 'none' })
      gsap.set(rest, { opacity: 1, y: 0, scaleX: 1 })
      return
    }
    const tl = gsap.timeline()
    tl.fromTo(chars,
      { opacity: 0, yPercent: 55, filter: 'blur(14px)', scale: 1.15 },
      { opacity: 1, yPercent: 0, filter: 'blur(0px)', scale: 1,
        duration: 1.1, ease: 'expo.out', stagger: { each: 0.03, from: 'start' } },
    )
    if (heroRuleRef.current) {
      tl.fromTo(heroRuleRef.current,
        { scaleX: 0, transformOrigin: 'left center' },
        { scaleX: 1, duration: 0.9, ease: 'power3.inOut' }, 0.4)
    }
    tl.fromTo([heroLedeRef.current, ctaRef.current].filter(Boolean),
      { opacity: 0, y: 16 },
      { opacity: 1, y: 0, duration: 0.7, ease: 'power2.out', stagger: 0.12 }, 0.62)
    return () => { tl.kill() }
  }, [query])

  // The two splash CTAs lean toward the pointer. Only these two: magnetism is
  // an accent for the page's primary intents, not a general button behaviour.
  useEffect(() => {
    if (query || !ctaRef.current) return
    const cleanups = Array.from(
      ctaRef.current.querySelectorAll<HTMLElement>('a'),
    ).map((el) => attachMagnet(el, 0.22))
    return () => cleanups.forEach((fn) => fn())
  }, [query])

  // Remember where the user was so returning from a card lands in place.
  //
  // Captured on scroll *and* on any click, then written once on the way out. A
  // click is what precedes leaving, and at that instant the position is still
  // right; reading it during teardown does not work, because opening a card
  // scrolls to the top first and that reset lands before the write. The
  // `captured` guard exists because StrictMode tears the effect down and
  // rebuilds it immediately on mount, and an unconditional write there would
  // put this page's initial zero over the position saved on the way out.
  useEffect(() => {
    let live = true
    let last = 0
    let captured = false
    const capture = () => {
      if (!live) return
      last = window.scrollY
      captured = true
    }
    window.addEventListener('scroll', capture, { passive: true })
    document.addEventListener('click', capture, { capture: true })
    return () => {
      live = false
      window.removeEventListener('scroll', capture)
      document.removeEventListener('click', capture, { capture: true })
      if (captured) rememberScroll(key, last)
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
      // Re-asserted for a short while rather than once. The grid has not
      // rendered when this first runs so the page is too short to scroll that
      // far, and coming back restores focus to the card you clicked, which
      // scrolls it into view a beat after the restore succeeded. Timers rather
      // than rAF, which does not run while the document is not compositing.
      if ('scrollRestoration' in history) history.scrollRestoration = 'manual'
      const target = cached.scrollY
      let elapsed = 0
      const settle = () => {
        window.scrollTo(0, target)
        elapsed += 30
        if (elapsed < 700) restoreTimer.current = window.setTimeout(settle, 30)
      }
      restoreTimer.current = window.setTimeout(settle, 0)
      return
    }

    if (isSemanticQuery) runSemantic(query)
    else runStandard(query, sort, order, page)

    return () => {
      stream.current?.stop()
      window.clearTimeout(restoreTimer.current)
    }
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
            {/* "Scry" is wrapped so the split characters stay inside one flex
                item — as direct children of the flex title, each letter would
                pick up the title's word gap. */}
            <h1 className="hero-title" ref={heroRef}>
              <span>Scry</span>
              <span className="hero-count" data-nosplit>
                <span ref={heroCountRef}>{paperCards || '—'}</span>
                {/* A gold plus when Scryfall has cards this mirror has not.
                    The number is the one place the count is stated, so it is
                    the honest place to say the count is behind — and small,
                    because it is a note rather than a warning. */}
                {updateReady && (
                  <Link
                    to="/settings"
                    className="hero-more"
                    title="Scryfall has newer card data — refresh in Settings"
                    aria-label="Card data update available"
                  >
                    +
                  </Link>
                )}
              </span>
            </h1>
            <hr className="manaline" ref={heroRuleRef} style={{ maxWidth: 420, marginTop: 10 }} />
            <p className="lede hero-sub" ref={heroLedeRef}>
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
            <div className="row wrap gap-2" style={{ marginTop: 34 }} ref={ctaRef}>
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
                      <th />
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {recent.map((entry) => (
                      <tr
                        key={entry.query}
                        className={entry.locked ? 'locked' : ''}
                        onClick={() => { setDraft(entry.query); submit(entry.query) }}
                        title="Run this search again"
                      >
                        <td className="q">{entry.query}</td>
                        <td className="n">{entry.total.toLocaleString()}</td>
                        <td className="n">
                          <span className={`engine-badge ${entry.engine}`}>{entry.engine}</span>
                        </td>
                        {/* A query you keep coming back to should not be
                            pushed out by five casual ones. Locked searches sit
                            at the top, survive Clear, and are never evicted. */}
                        <td className="n">
                          <button
                            className={`history-lock ${entry.locked ? 'on' : ''}`}
                            title={entry.locked ? 'Unpin this search' : 'Pin this search'}
                            aria-label={`${entry.locked ? 'Unpin' : 'Pin'} ${entry.query}`}
                            aria-pressed={Boolean(entry.locked)}
                            onClick={(event) => {
                              event.stopPropagation()
                              history.toggleLock(entry.query)
                            }}
                          >
                            {entry.locked ? '★' : '☆'}
                          </button>
                        </td>
                        {/* The list is five long and evicts from the bottom, so
                            one typo otherwise sits here through four more
                            searches and the only cure was discarding the lot. */}
                        <td className="n">
                          <button
                            className="history-drop"
                            title={`Forget “${entry.query}”`}
                            aria-label={`Forget ${entry.query}`}
                            onClick={(event) => {
                              event.stopPropagation()
                              history.remove(entry.query)
                            }}
                          >
                            ✕
                          </button>
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
                <button
                  className={markOwned ? 'owned-toggle on' : 'owned-toggle'}
                  aria-pressed={markOwned}
                  onClick={() => setMarkOwned(!markOwned)}
                  title={markOwned
                    ? 'Stop marking cards that are in your binder'
                    : 'Outline cards that are already in your binder'}
                >
                  In binder
                </button>
                {/* No quantity out here -- a search result is a card that
                    exists, not a card you have any number of. */}
                <button
                  className={pinOverlay ? 'owned-toggle on' : 'owned-toggle'}
                  aria-pressed={pinOverlay}
                  onClick={() => setPinOverlay(!pinOverlay)}
                  title={pinOverlay
                    ? 'Show prices only on hover'
                    : 'Always show prices, without hovering'}
                >
                  Toggle Overlay
                </button>
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

            {/* The pin is a container class, so one flag covers every tile
                in the grid and the hover rules stay untouched underneath. */}
            <div className={pinOverlay ? 'overlay-pinned' : undefined}>
            <CardGrid
              cards={isSemanticQuery ? sortCards(cards, sort, order) : cards}
              view={view}
              size={cardSize}
              ownedIds={binderIds}
              // The corner `⋯`, not the tile's click: opening a card is what
              // clicking a result is for, and getting a card into a deck used
              // to mean collecting it, walking to the Cards page and adding it
              // from there.
              onMenu={(card, at) => setPicked({ card, at })}
            />
            </div>

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

        {picked && (
          <CardMenu
            card={picked.card}
            at={picked.at}
            onClose={() => setPicked(null)}
          />
        )}

        {collapsed && consoleEl}

        <ScrollTop watch={toolbarRef} ready={cards.length > 0} />
      </section>
    </>
  )
}
