import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'

import {
  api, streamDeckRecommendations, type Category,
  type Card, type DeckReport, type RecommendReport, type Resolution,
} from '../lib/api'
import { collection } from '../lib/collection'
import {
  addedCard, fromResolutions, serialize, type DeckCard, type Section,
} from '../lib/deckModel'
import { recallDeckView, rememberDeckScroll, rememberDeckView } from '../lib/deckViewCache'
import { attachTilt, dissolveIn, riseIn } from '../lib/motion'
import { CardGrid } from '../components/CardGrid'
import { DeckEditor } from '../components/DeckEditor'
import { ManaCost } from '../components/ManaCost'
import { DeckCharts } from '../components/DeckCharts'
import { DeckInfo } from '../components/DeckInfo'
import { DeckSearch } from '../components/DeckSearch'
import { usePersisted } from '../lib/usePersisted'
import { Playtest } from '../components/Playtest'
import {
  DECK_RAIL, EMPTY_CONSOLE, SemanticConsole, type ConsoleState,
} from '../components/SemanticConsole'
import { SplitPane } from '../components/SplitPane'

const SAMPLE = `Commander
1 Teysa Karlov

Deck
1 Blood Artist
1 Zulaport Cutthroat
1 Viscera Seer
1 Carrion Feeder
1 Ashnod's Altar
1 Village Rites
10 Swamp
8 Plains

Sideboard
2 Duress
`

/** Deep enough to cover a run of edits without holding a session's worth. */
const UNDO_LIMIT = 60

/** The four jobs every deck does, asked for by name. */
const CATEGORIES: [Category, string][] = [
  ['ramp', 'Ramp'], ['removal', 'Removal'],
  ['counterspell', 'Counters'], ['draw', 'Draw'],
]

const UNCERTAIN = new Set(['fuzzy', 'ambiguous', 'prefix', 'unresolved'])
const REC_FORMATS = ['', 'commander', 'standard', 'pioneer', 'modern', 'legacy', 'vintage', 'pauper', 'brawl']

function ResolutionRow({ entry }: { entry: Resolution }) {
  return (
    <div className="resolution">
      <span className="q mono">{entry.quantity}×</span>
      <span className="muted" style={{ flex: '0 1 auto', minWidth: 0 }}>{entry.raw_name}</span>
      <span className="arrow">→</span>
      <span className="to">
        {entry.card
          ? <Link to={`/card/${entry.card.oracle_id}`}>{entry.card.name}</Link>
          : <span style={{ color: 'var(--danger)' }}>no match</span>}
        {entry.alternatives.length > 0 && (
          <span className="faint" style={{ fontSize: 11 }}>
            {' '}· or {entry.alternatives.slice(0, 3).join(', ')}
          </span>
        )}
      </span>
      <span className={`match-tag ${entry.match}`}>
        {entry.match}{entry.match !== 'exact' && entry.score > 0 && ` ${Math.round(entry.score)}`}
      </span>
    </div>
  )
}

export function DeckPage() {
  const { deckId } = useParams()
  const navigate = useNavigate()
  const isNew = !deckId || deckId === 'new'

  const [text, setText] = useState('')
  const [deckName, setDeckName] = useState('')
  const [savedId, setSavedId] = useState<number | null>(null)
  const [savedAt, setSavedAt] = useState<{ created: string; updated: string } | null>(null)
  const [format, setFormat] = useState('commander')
  const [description, setDescription] = useState("")

  const [mode, setMode] = useState<'text' | 'build'>('build')
  const [deckCards, setDeckCards] = useState<DeckCard[]>([])
  const [report, setReport] = useState<DeckReport | null>(null)
  const [recs, setRecs] = useState<RecommendReport | null>(null)

  const [tab, setTab] = useState<'analysis' | 'search' | 'recommendations' | 'pipeline'>('analysis')
  const [pipeline, setPipeline] = useState<ConsoleState>(EMPTY_CONSOLE)
  const [recView, setRecView] = usePersisted<'list' | 'grid'>('insight-enigma:rec-view', 'list')
  const [recSize, setRecSize] = usePersisted('insight-enigma:rec-size', 150)
  const [activeThemes, setActiveThemes] = useState<string[]>([])
  const [aiMode, setAiMode] = useState(false)
  const [aiStrategy, setAiStrategy] = useState<string | null>(null)
  const [playing, setPlaying] = useState(false)
  const [busy, setBusy] = useState<
    'load' | 'analyse' | 'recommend' | 'ai' | 'save' | Category | null
  >(null)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [showAll, setShowAll] = useState(false)

  const resultRef = useRef<HTMLDivElement>(null)
  const commanderTilt = useRef<HTMLAnchorElement>(null)
  const recRef = useRef<HTMLDivElement>(null)
  const aiStream = useRef<{ stop: () => void } | null>(null)

  const analyseText = useCallback(async (source: string) => {
    if (!source.trim()) { setReport(null); return null }
    try {
      const next = await api.analyzeDeck(source)
      setReport(next)
      return next
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Analysis failed')
      return null
    }
  }, [])

  // Opening a saved deck lands in Build with the analysis already on screen —
  // both are what you want to see, and neither should need a second click.
  useEffect(() => {
    let cancelled = false
    // A different deck is a different history. Without this, undoing on deck B
    // would restore deck A's cards into it.
    past.current = []
    future.current = []
    if (isNew) { setBusy(null); return }
    setBusy('load')
    api.loadDeck(Number(deckId))
      .then(async ({ deck }) => {
        if (cancelled) return
        setText(deck.text ?? '')
        setDeckName(deck.name)
        setSavedId(deck.id)
        setSavedAt({ created: deck.created_at, updated: deck.updated_at })
        setDescription(deck.description ?? "")
        if (deck.format) setFormat(deck.format)
        const analysed = await analyseText(deck.text ?? '')
        if (!cancelled && analysed) setDeckCards(fromResolutions(analysed.entries))
        setMode('build')
      })
      .catch(() => !cancelled && setError('Could not load that deck.'))
      .finally(() => !cancelled && setBusy(null))
    return () => { cancelled = true }
  }, [deckId, isNew, analyseText])

  useEffect(() => {
    if (!status) return
    const timer = setTimeout(() => setStatus(null), 3000)
    return () => clearTimeout(timer)
  }, [status])

  /* Returning from a card must not discard the recommendations.
   *
   * They take real work to produce -- the AI pipeline takes minutes -- so
   * clicking a suggestion to read it and pressing Back has to come back to the
   * same list, the same tab and the same place in it. */
  const viewKey = deckId ?? 'new'
  /** Set by the restore, cleared by the save it must not be undone by. */
  const restoring = useRef<string | null>(null)

  useEffect(() => {
    const saved = recallDeckView(viewKey)
    if (!saved) return
    restoring.current = viewKey
    setTab(saved.tab)
    setRecs(saved.recs)
    setAiMode(saved.aiMode)
    setAiStrategy(saved.aiStrategy)
    setActiveThemes(saved.activeThemes)
    // Set here rather than only at startup: the router resets it, and the
    // browser's own guess otherwise wins the race against the restore below.
    if ('scrollRestoration' in history) history.scrollRestoration = 'manual'

    // The panel is not on screen yet, so the page is still too short to scroll
    // this far. Keep asking until the content has rendered tall enough to
    // honour it, then stop.
    //
    // Timers rather than requestAnimationFrame: rAF does not run while the
    // document is not compositing, which would leave the restore silently
    // undone in a background tab.
    // Re-asserted for a short while after it first lands, not just until then.
    // Coming back restores focus to the link you clicked, and focusing scrolls
    // it into view -- undoing the restore a beat after it succeeded.
    let elapsed = 0
    const settle = () => {
      window.scrollTo(0, saved.scrollY)
      elapsed += 30
      if (elapsed < 700) timer = window.setTimeout(settle, 30)
    }
    let timer = window.setTimeout(settle, 0)
    return () => window.clearTimeout(timer)
  }, [viewKey])

  useEffect(() => {
    // The save that fires in the same commit as a restore still sees the
    // pre-restore state, and writing it back would erase what was just read.
    // Under StrictMode that is fatal rather than merely wasteful: effects are
    // invoked twice on mount, so the second restore would read the blank view
    // this had just written and faithfully restore *that*.
    if (restoring.current === viewKey) {
      restoring.current = null
      return
    }
    rememberDeckView(viewKey, {
      tab, recs, aiMode, aiStrategy, activeThemes, scrollY: window.scrollY,
    })
  }, [viewKey, tab, recs, aiMode, aiStrategy, activeThemes])

  useEffect(() => {
    // Recorded on scroll *and* on any click, then written once on the way out.
    //
    // The click matters: a click is what precedes leaving, and at that instant
    // the position is still correct. Reading window.scrollY during teardown
    // does not work -- navigating to a card scrolls to the top first, so the
    // teardown read records zero. Capture phase, so it runs before the handler
    // that navigates.
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
      // Only if something was actually observed. StrictMode tears every effect
      // down and rebuilds it immediately on mount, and an unconditional write
      // there would put this page's initial scroll of zero over the position
      // saved on the way out -- which the restore has not read yet.
      if (captured) rememberDeckScroll(viewKey, last)
    }
  }, [viewKey])

  /* Undo history.
   *
   * Every deck mutation goes through applyEdits, so the whole editor gets undo
   * from one place. Snapshots are whole card lists rather than diffs: a deck is
   * a few hundred small objects, so the memory is irrelevant next to the
   * complexity of inverting each kind of edit. */
  const past = useRef<DeckCard[][]>([])
  const future = useRef<DeckCard[][]>([])

  const applyEdits = (next: DeckCard[]) => {
    past.current = [...past.current, deckCards].slice(-UNDO_LIMIT)
    future.current = []
    setDeckCards(next)
    setText(serialize(next))
  }

  const undo = useCallback(() => {
    const previous = past.current[past.current.length - 1]
    if (previous === undefined) return false
    past.current = past.current.slice(0, -1)
    setDeckCards((current) => {
      future.current = [...future.current, current].slice(-UNDO_LIMIT)
      return previous
    })
    setText(serialize(previous))
    return true
  }, [])

  const redo = useCallback(() => {
    const next = future.current[future.current.length - 1]
    if (next === undefined) return false
    future.current = future.current.slice(0, -1)
    setDeckCards((current) => {
      past.current = [...past.current, current].slice(-UNDO_LIMIT)
      return next
    })
    setText(serialize(next))
    return true
  }, [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'z') return
      // Inside a text field the browser's own undo is the right one — the
      // decklist textarea in particular has its own edit history.
      const el = event.target as HTMLElement | null
      const tag = el?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || el?.isContentEditable) return

      const didSomething = event.shiftKey ? redo() : undo()
      if (!didSomething) return
      event.preventDefault()
      setStatus(event.shiftKey ? 'Redid the last change' : 'Undid the last change')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [undo, redo])

  /** A suggestion you want to think about. Already-present cards gain a copy
   *  rather than a second row, matching how the search tab adds. */
  const addToMaybe = (card: Card) => {
    const existing = deckCards.find(
      (c) => c.card.oracle_id === card.oracle_id && c.section === 'maybeboard',
    )
    applyEdits(
      existing
        ? deckCards.map((c) => (c.uid === existing.uid ? { ...c, quantity: c.quantity + 1 } : c))
        : [...deckCards, addedCard(card, 'maybeboard')],
    )
    setStatus(`Added ${card.name} to the maybeboard`)
  }

  const addCollectedToDeck = () => {
    const present = new Set(deckCards.map((c) => c.card.oracle_id))
    const additions = collection.snapshot()
      .filter((card) => !present.has(card.oracle_id))
      .map((card) => addedCard(card))
    if (additions.length) applyEdits([...deckCards, ...additions])
  }

  /** A card dragged from the Search tab onto one of the deck's sections. An
   *  existing copy gains a quantity rather than a second row. */
  const addSearchedCard = (card: Card, section: Section) => {
    const existing = deckCards.find(
      (c) => c.card.oracle_id === card.oracle_id && c.section === section,
    )
    applyEdits(
      existing
        ? deckCards.map((c) =>
            c.uid === existing.uid ? { ...c, quantity: c.quantity + 1 } : c)
        : [...deckCards, addedCard(card, section)],
    )
    setStatus(`Added ${card.name} to ${section}`)
  }

  const enterBuildMode = async () => {
    if (!text.trim()) { setMode('build'); setDeckCards([]); return }
    setBusy('analyse')
    const analysed = await analyseText(text)
    if (analysed) setDeckCards(fromResolutions(analysed.entries))
    setMode('build')
    setBusy(null)
  }

  const analyse = async () => {
    if (!text.trim()) return
    setBusy('analyse')
    setTab('analysis')
    setError(null)
    await analyseText(text)
    setBusy(null)
  }

  const getRecommendations = async () => {
    if (!text.trim()) return
    setBusy('recommend'); setError(null); setTab('recommendations')
    setAiMode(false); setAiStrategy(null); setActiveThemes([])
    try {
      setRecs(await api.recommendDeck(text, format || null, description))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not build recommendations')
      setRecs(null)
    } finally { setBusy(null) }
  }

  const getCategory = async (category: Category) => {
    if (!text.trim()) return
    setBusy(category); setError(null); setTab('recommendations')
    setAiMode(false); setAiStrategy(null); setActiveThemes([])
    try {
      setRecs(await api.recommendCategory(text, category, format || null))
    } catch (err) {
      setError(err instanceof Error ? err.message : `Could not load ${category}`)
      setRecs(null)
    } finally { setBusy(null) }
  }

  const getAiRecommendations = async () => {
    if (!text.trim()) return
    // Opens on the pipeline tab: for a multi-minute run, watching the stages
    // is the useful view until there is something to show.
    setBusy('ai'); setError(null); setTab('pipeline')
    setAiMode(true); setAiStrategy(null); setActiveThemes([]); setRecs(null)
    setPipeline((p) => ({ ...EMPTY_CONSOLE, model: p.model, running: true }))
    try {
      const { run_id } = await api.prepareAiRecommendations(text, format || null, description)
      aiStream.current?.stop()
      aiStream.current = streamDeckRecommendations(run_id, {
        onStage: (stage) => {
          setPipeline((p) => ({ ...p, stages: [...p.stages, stage], current: stage.stage }))
          const strategy = (stage.detail as { strategy?: string }).strategy
          if (strategy) setAiStrategy(strategy)
        },
        onComplete: (stage) => {
          const detail = stage.detail as unknown as RecommendReport & { strategy?: string }
          setPipeline((p) => ({
            ...p, stages: [...p.stages, stage], current: 'complete', running: false,
          }))
          setRecs({
            themes: [], color_identity: undefined, format: format || null,
            recommendations: detail.recommendations ?? [],
            note: (detail.recommendations ?? []).length ? null : 'The model found nothing worth adding.',
          })
          if (detail.strategy) setAiStrategy(detail.strategy)
          setBusy(null)
          setTab('recommendations')
        },
        onCancelled: () => {
          setPipeline((p) => ({ ...p, running: false, cancelled: true }))
          setBusy(null)
        },
        onError: (message) => {
          setPipeline((p) => ({ ...p, running: false, error: message }))
          setError(message); setBusy(null)
        },
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start the AI run')
      setPipeline((p) => ({ ...p, running: false }))
      setBusy(null)
    }
  }

  const save = async () => {
    if (!text.trim()) return
    setBusy('save'); setError(null)
    try {
      const { deck } = await api.saveDeck({
        name: deckName || 'Untitled deck', text,
        id: savedId ?? undefined, format: format || null, description,
      })
      setSavedId(deck.id)
      setDeckName(deck.name)
      setStatus(`Saved “${deck.name}”`)
      if (isNew) navigate(`/deck/${deck.id}`, { replace: true })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save deck')
    } finally { setBusy(null) }
  }

  useEffect(() => {
    if (!report) return
    riseIn(resultRef.current)
    if (resultRef.current) dissolveIn(resultRef.current.querySelectorAll('.verdict'), { stagger: 0.02 })
  }, [report])

  useEffect(() => {
    if (recs && recRef.current) {
      riseIn(recRef.current)
      dissolveIn(recRef.current.querySelectorAll('.rec-row'), { stagger: 0.015 })
    }
  }, [recs])

  const toggleTheme = (slug: string) =>
    setActiveThemes((c) => (c.includes(slug) ? c.filter((s) => s !== slug) : [...c, slug]))

  const visibleRecs = (recs?.recommendations ?? []).filter(
    (rec) => !activeThemes.length || rec.because.some((b) => activeThemes.includes(b)),
  )
  const reasonFor = new Map((recs?.recommendations ?? []).map((r) => [r.card.oracle_id, r.because]))
  const commanderCard =
    report?.entries.find((e) => e.section === 'commander' && e.card)?.card ?? null
  const commanderCardId = commanderCard?.oracle_id ?? null
  const uncertain = report?.entries.filter((e) => UNCERTAIN.has(e.match)) ?? []
  const shown = showAll ? (report?.entries ?? []) : uncertain

  // Declared after commanderCardId so the dependency is in scope; re-attached
  // whenever the commander changes, and torn down with it.
  useEffect(() => {
    if (tab !== 'analysis' || !commanderTilt.current) return
    return attachTilt(commanderTilt.current, 6)
  }, [tab, commanderCardId])

  // Playtesting takes the whole screen. Goldfishing is its own activity, and
  // the decklist beside the board is exactly what you are trying to stop
  // reading: the point is to see what the deck does, not what is in it.
  //
  // Below every hook. Returning earlier skips the ones declared after it, and
  // React counts hooks per render -- which is precisely the crash this caused.
  if (playing) {
    return <Playtest deck={deckCards} onClose={() => setPlaying(false)} />
  }

  const editorPane = (
    <div className="stack gap-3" style={{ minWidth: 0 }}>
      <div className="result-tabs">
        <button className={mode === 'text' ? 'on' : ''} onClick={() => setMode('text')}>Text</button>
        <button className={mode === 'build' ? 'on' : ''} onClick={enterBuildMode}>
          Build{deckCards.length > 0 && <span className="faint"> {deckCards.length}</span>}
        </button>
      </div>

      {/* Directly under the tabs and above the editor's own toolbar, so the
          actions are reachable without scrolling past the whole deck. */}
      <div className="deck-actions">
        <button className="btn btn-primary sm" onClick={analyse} disabled={!!busy || !text.trim()}>
          {busy === 'analyse' && <span className="spinner" />}
          {busy === 'analyse' ? 'Analysing' : 'Analyse'}
        </button>
        <button className="btn sm" onClick={getRecommendations} disabled={!!busy || !text.trim()}>
          {busy === 'recommend' && <span className="spinner" />}
          {busy === 'recommend' ? 'Thinking' : 'Recommend'}
        </button>
        {/* Ramp, removal, counterspells and draw never qualify on theme alone,
            which makes them invisible rather than unwanted. This is how you ask
            for them. */}
        <span className="cat-buttons">
          {CATEGORIES.map(([key, label]) => (
            <button
              key={key}
              className="btn btn-ghost sm"
              onClick={() => getCategory(key)}
              disabled={!!busy || !text.trim()}
              title={`Most-played ${label.toLowerCase()} in this deck's colours`}
            >
              {busy === key && <span className="spinner" />}
              {label}
            </button>
          ))}
        </span>
        {busy === 'ai' ? (
          <button className="btn btn-danger sm" onClick={() => { aiStream.current?.stop(); setBusy(null) }}>
            Stop AI
          </button>
        ) : (
          <button className="btn sm" onClick={getAiRecommendations} disabled={!!busy || !text.trim()}>
            AI recommend
          </button>
        )}
        {!text && (
          <button className="btn btn-ghost sm push" onClick={() => setText(SAMPLE)}>Sample</button>
        )}
      </div>

      {mode === 'text' && (
        <div className="row gap-2 wrap">
          <label className="stack gap-1" style={{ flex: '1 1 240px', minWidth: 0 }}>
            <span className="label">Deck name</span>
            <input
              className="fld" placeholder="Untitled deck" value={deckName}
              onChange={(e) => setDeckName(e.target.value)} aria-label="Deck name"
            />
          </label>
          <label className="stack gap-1">
            <span className="label">Format</span>
            <select
              className="fld" style={{ width: 'auto' }} value={format}
              onChange={(e) => setFormat(e.target.value)} aria-label="Format"
            >
              {REC_FORMATS.map((f) => <option key={f} value={f}>{f || 'Any format'}</option>)}
            </select>
          </label>
        </div>
      )}

      {mode === 'text' && (
        <label className="stack gap-1">
          <span className="label">How this deck works</span>
          <textarea
            className="deck-desc"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Sacrifice creatures for value and drain the table. Teysa doubles the death triggers."
            spellCheck={false}
            aria-label="Deck description"
          />
          <span className="faint" style={{ fontSize: 10.5 }}>
            Saved with the deck, and given to the AI recommender before it reads the cards —
            it states intent the card list can only imply.
          </span>
        </label>
      )}

      {mode === 'text' ? (
        <textarea
          className="decklist-input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={SAMPLE}
          spellCheck={false}
          aria-label="Decklist"
        />
      ) : (
        <DeckEditor
          cards={deckCards}
          onChange={applyEdits}
          onAddCard={addCollectedToDeck}
          onAddSearched={addSearchedCard}
        />
      )}
    </div>
  )

  const analysisPane = (
    <div ref={resultRef} style={{ minWidth: 0 }}>
      {error && <div className="notice error"><h3>Could not continue</h3><p>{error}</p></div>}

      {/* Always rendered: Search works before there is anything to analyse,
          which is exactly when you are looking cards up. */}
      <div className="result-tabs">
        <button className={tab === 'analysis' ? 'on' : ''} disabled={!report}
          onClick={() => setTab('analysis')}>
          Analysis{report && <span className="faint"> {report.total_cards}</span>}
        </button>
        <button className={tab === 'search' ? 'on' : ''} onClick={() => setTab('search')}>
          Search
        </button>
        <button className={tab === 'recommendations' ? 'on' : ''} disabled={!recs}
          onClick={() => setTab('recommendations')}>
          Recommendations{recs && <span className="faint"> {recs.recommendations.length}</span>}
        </button>
        <button className={tab === 'pipeline' ? 'on' : ''} disabled={!pipeline.stages.length}
          onClick={() => setTab('pipeline')}>
          Pipeline
          {pipeline.running && <span className="spinner" style={{ marginLeft: 6 }} />}
        </button>
      </div>

      {tab === 'search' && <DeckSearch />}

      {tab === 'analysis' && !report && !error && (
        <div className="notice">
          <h3>{busy === 'load' ? 'Loading…' : 'Nothing analysed yet'}</h3>
          <p>Build or paste a decklist, then Analyse it or ask for recommendations.</p>
        </div>
      )}

      {tab === 'pipeline' && pipeline.stages.length > 0 && (
        <SemanticConsole
          state={pipeline}
          rail={DECK_RAIL}
          title="Recommendation pipeline"
          collapsed={false}
          onToggle={() => {}}
          onStop={() => { aiStream.current?.stop(); setBusy(null) }}
        />
      )}

      {tab === 'analysis' && report && (
        <div className="stack gap-4">
          {/* The counts that used to sit here are in Deck info below, so this
              space goes to the card the deck is actually built around. */}
          {commanderCard?.image_normal && (
            <div className="chart commander-card">
              <div className="chart-head"><span className="label">Commander</span></div>
              {/* The same pointer tilt the card grids use, but nothing overlaid
                  on hover — everything those badges would say is printed on the
                  card, and this one is a portrait, not a row in a list. */}
              <Link
                to={`/card/${commanderCard.oracle_id}`}
                title={commanderCard.name}
                ref={commanderTilt}
              >
                <img src={commanderCard.image_normal} alt={commanderCard.name} />
              </Link>
            </div>
          )}

          {/* Only shown when it is a problem. A green zero reports that
              nothing went wrong, which is not worth a tile. */}
          {report.unresolved_count > 0 && (
            <div className="stat-row">
              <div className="stat">
                <span className="v mono" style={{ color: 'var(--danger)' }}>
                  {report.unresolved_count}
                </span>
                <span className="label">Unresolved</span>
              </div>
            </div>
          )}

          {/* Charts first: the shape of the deck is what you opened this tab
              for. DeckInfo is reference material and goes last. */}
          {report.stats && !report.stats.empty && <DeckCharts stats={report.stats} />}

          {/* Only worth a panel when there is something to resolve. A panel
              whose entire content is "nothing went wrong" is noise. */}
          {uncertain.length > 0 && (
            <div className="panel">
              <div className="row" style={{ justifyContent: 'space-between', marginBottom: 10 }}>
                <h3 style={{ margin: 0 }}>
                  Name resolution
                  <span style={{ color: 'var(--warn)' }}> · {uncertain.length} to check</span>
                </h3>
                <button className="btn btn-ghost sm" onClick={() => setShowAll(!showAll)}>
                  {showAll ? 'Only uncertain' : `All ${report.entries.length}`}
                </button>
              </div>
              {shown.map((entry, i) => <ResolutionRow key={i} entry={entry} />)}
            </div>
          )}

          {report.stats && !report.stats.empty && (
            <DeckInfo
              report={report}
              stats={report.stats}
              createdAt={savedAt?.created}
              updatedAt={savedAt?.updated}
            />
          )}
        </div>
      )}

      {tab === 'recommendations' && recs && (
        <div className="panel" ref={recRef}>
          <div className="row wrap gap-2" style={{ justifyContent: 'space-between', marginBottom: 10 }}>
            <h3 style={{ margin: 0 }}>
              {recs.category
                ? CATEGORIES.find(([k]) => k === recs.category)?.[1] ?? 'Recommendations'
                : aiMode ? 'AI recommendations' : 'Recommendations'}
              <span className="faint">
                {' · '}{visibleRecs.length} of {recs.recommendations.length}
                {recs.color_identity ? ` · within ${recs.color_identity}` : ''}
              </span>
            </h3>
            <div className="row gap-2">
              {recView === 'grid' && (
                <label className="size-slider" title="Card size">
                  <input type="range" min={110} max={300} step={10} value={recSize}
                    onChange={(e) => setRecSize(Number(e.target.value))} aria-label="Card image size" />
                </label>
              )}
              <button className="btn btn-ghost sm" onClick={() => setRecView(recView === 'list' ? 'grid' : 'list')}>
                {recView === 'list' ? 'Images' : 'List'}
              </button>
            </div>
          </div>

          {recs.note && <p className="muted" style={{ fontSize: 13 }}>{recs.note}</p>}

          {aiStrategy && <p className="muted" style={{ fontSize: 13, marginBottom: 10 }}>{aiStrategy}</p>}

          {recs.themes.length > 0 && (
            <>
              <p className="faint" style={{ fontSize: 11, marginBottom: 8 }}>
                Themes from the tags your cards carry, weighted against how common each tag is.
                Solid chips are signature themes — a card must hit one to be suggested. ✦ marks
                themes your description named, which are ranked up. Click to filter.
              </p>
              <div className="row wrap gap-1" style={{ marginBottom: 14 }}>
                {recs.themes.map((t) => (
                  <button key={t.slug}
                    className={`chip ${activeThemes.includes(t.slug) ? 'on' : ''} ${t.signature ? '' : 'supporting'}`}
                    title={
                      `${t.in_deck} here, ${t.corpus} in the corpus`
                      + (t.described ? ' · named in your description, so ranked up' : '')
                    }
                    onClick={() => toggleTheme(t.slug)}>
                    {t.described && <span className="described" aria-hidden>✦ </span>}
                    {t.slug} <span className="faint">×{t.in_deck}</span>
                  </button>
                ))}
                {activeThemes.length > 0 && (
                  <button className="btn btn-ghost sm" onClick={() => setActiveThemes([])}>Clear</button>
                )}
              </div>
            </>
          )}

          {recView === 'grid' ? (
            <CardGrid cards={visibleRecs.map((r) => r.card)} size={recSize}
              onAdd={addToMaybe}
              addLabel="Add to maybeboard"
              captionFor={(card) => reasonFor.get(card.oracle_id)?.join(' · ')} />
          ) : (
            visibleRecs.map((rec) => (
              <div className="resolution rec-row" key={rec.card.oracle_id}>
                <span className="to">
                  <Link to={`/card/${rec.card.oracle_id}`}>{rec.card.name}</Link>{' '}
                  <ManaCost cost={rec.card.mana_cost} />
                  {rec.because.length > 0 && (
                    <span className="faint" style={{ fontSize: 11, display: 'block' }}>
                      {rec.because.slice(0, 3).join(' · ')}
                    </span>
                  )}
                </span>
                <span className="mono faint" style={{ fontSize: 11 }}>
                  {rec.card.usd !== null ? `$${rec.card.usd.toFixed(2)}` : '—'}
                </span>
                {/* Most suggestions want considering, not committing, so the
                    plain add goes to the maybeboard of this deck. It used to
                    go to the Cards collection, which meant a suggestion landed
                    in a queue on another page and had to be imported back. */}
                <button className="btn btn-ghost sm" title="Add to the maybeboard"
                  onClick={() => addToMaybe(rec.card)}>+ maybe</button>
                <button className="btn btn-ghost sm" title="Add straight to the deck"
                  onClick={() => applyEdits([...deckCards, addedCard(rec.card, 'main')])}>
                  ↓ deck
                </button>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  )

  return (
    <section className="shell">
      <div className="page-back">
        <button className="back-link" onClick={() => navigate('/deck')}>← All decks</button>
      </div>

      {/* Page-level actions live in the page header: they act on the whole
          deck, and anywhere lower puts the Playtest button underneath the
          panel it toggles. */}
      <div className="deck-head">
        {/* Read-only here. The title bar is the deck's identity, not a form:
            the field and the dropdown live under Text, where you are already
            editing what the deck is. */}
        <h2 className="deck-title">{deckName.trim() || 'Untitled deck'}</h2>
        <span className="chip">{format || 'Any format'}</span>

        {/* Save and Playtest act on the deck as a whole, not on whichever tab
            is open, so they sit with the deck's name rather than beside the
            per-tab actions. */}
        <div className="row gap-2 push">
          <button className="btn btn-primary sm" onClick={save} disabled={!!busy || !text.trim()}>
            {busy === 'save' && <span className="spinner" />}Save
          </button>
          <button
            className="btn sm"
            onClick={() => setPlaying((p) => !p)}
            disabled={!deckCards.length}
            title={deckCards.length ? 'Goldfish this deck' : 'Build or load a deck first'}
          >
            {playing ? 'Close playtest' : 'Playtest'}
          </button>
        </div>
      </div>

      {status && (
        <p className="mono" style={{ fontSize: 12, color: 'var(--ok)', marginBottom: 12 }}>
          {status}
        </p>
      )}


      <SplitPane storageKey="insight-enigma:deck-split" left={editorPane} right={analysisPane} />
    </section>
  )
}
