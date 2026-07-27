import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'

import {
  api, streamDeckRecommendations,
  type DeckReport, type RecommendReport, type Resolution,
} from '../lib/api'
import { collection } from '../lib/collection'
import {
  addedCard, fromResolutions, serialize, type DeckCard,
} from '../lib/deckModel'
import { countTo, dissolveIn, riseIn } from '../lib/motion'
import { CardGrid } from '../components/CardGrid'
import { DeckEditor } from '../components/DeckEditor'
import { ManaCost } from '../components/ManaCost'
import { DeckCharts } from '../components/DeckCharts'
import { DeckInfo } from '../components/DeckInfo'
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

const CURVE_KEYS = ['0', '1', '2', '3', '4', '5', '6', '7+']
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

  const [tab, setTab] = useState<'analysis' | 'recommendations' | 'pipeline'>('analysis')
  const [pipeline, setPipeline] = useState<ConsoleState>(EMPTY_CONSOLE)
  const [recView, setRecView] = useState<'list' | 'grid'>('list')
  const [recSize, setRecSize] = useState(150)
  const [activeThemes, setActiveThemes] = useState<string[]>([])
  const [aiMode, setAiMode] = useState(false)
  const [aiStrategy, setAiStrategy] = useState<string | null>(null)
  const [playing, setPlaying] = useState(false)
  const [busy, setBusy] = useState<'load' | 'analyse' | 'recommend' | 'ai' | 'save' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [showAll, setShowAll] = useState(false)

  const priceRef = useRef<HTMLSpanElement>(null)
  const countRef = useRef<HTMLSpanElement>(null)
  const resultRef = useRef<HTMLDivElement>(null)
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

  const applyEdits = (next: DeckCard[]) => {
    setDeckCards(next)
    setText(serialize(next))
  }

  const addCollectedToDeck = () => {
    const present = new Set(deckCards.map((c) => c.card.oracle_id))
    const additions = collection.snapshot()
      .filter((card) => !present.has(card.oracle_id))
      .map((card) => addedCard(card))
    if (additions.length) applyEdits([...deckCards, ...additions])
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
      setRecs(await api.recommendDeck(text, format || null))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not build recommendations')
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
    countTo(countRef.current, report.total_cards)
    countTo(priceRef.current, report.price_usd, (n) => `$${n.toFixed(2)}`)
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
  const maxCurve = report ? Math.max(1, ...CURVE_KEYS.map((k) => report.curve[k] ?? 0)) : 1
  const uncertain = report?.entries.filter((e) => UNCERTAIN.has(e.match)) ?? []
  const shown = showAll ? (report?.entries ?? []) : uncertain

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
        <DeckEditor cards={deckCards} onChange={applyEdits} onAddCard={addCollectedToDeck} />
      )}
    </div>
  )

  const analysisPane = (
    <div ref={resultRef} style={{ minWidth: 0 }}>
      {error && <div className="notice error"><h3>Could not continue</h3><p>{error}</p></div>}

      {!report && !recs && !error && (
        <div className="notice">
          <h3>{busy === 'load' ? 'Loading…' : 'Nothing analysed yet'}</h3>
          <p>Build or paste a decklist, then Analyse it or ask for recommendations.</p>
        </div>
      )}

      {(report || recs || pipeline.stages.length > 0) && (
        <div className="result-tabs">
          <button className={tab === 'analysis' ? 'on' : ''} disabled={!report}
            onClick={() => setTab('analysis')}>
            Analysis{report && <span className="faint"> {report.total_cards}</span>}
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
          <div className="stat-row">
            <div className="stat">
              <span className="v mono" ref={countRef}>{report.total_cards}</span>
              <span className="label">Cards</span>
            </div>
            <div className="stat">
              <span className="v mono">{report.unique_cards}</span>
              <span className="label">Unique</span>
            </div>
            <div className="stat">
              <span className="v mono" ref={priceRef}>${report.price_usd.toFixed(2)}</span>
              <span className="label">Est. value</span>
            </div>
            <div className="stat">
              <span className="v mono" style={{ color: report.unresolved_count ? 'var(--danger)' : 'var(--ok)' }}>
                {report.unresolved_count}
              </span>
              <span className="label">Unresolved</span>
            </div>
          </div>

          <div className="panel">
            <h3>Mana curve (non-land)</h3>
            <div className="curve">
              {CURVE_KEYS.map((key) => {
                const value = report.curve[key] ?? 0
                return (
                  <div className="bar" key={key}>
                    <span className="cap">{value || ''}</span>
                    <div className="fill" style={{ height: `${(value / maxCurve) * 100}%` }} />
                    <span className="cap">{key}</span>
                  </div>
                )
              })}
            </div>
          </div>

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

          {report.stats && !report.stats.empty && <DeckCharts stats={report.stats} />}
        </div>
      )}

      {tab === 'recommendations' && recs && (
        <div className="panel" ref={recRef}>
          <div className="row wrap gap-2" style={{ justifyContent: 'space-between', marginBottom: 10 }}>
            <h3 style={{ margin: 0 }}>
              {aiMode ? 'AI recommendations' : 'Recommendations'}
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
                Solid chips are signature themes — a card must hit one to be suggested. Click to filter.
              </p>
              <div className="row wrap gap-1" style={{ marginBottom: 14 }}>
                {recs.themes.map((t) => (
                  <button key={t.slug}
                    className={`chip ${activeThemes.includes(t.slug) ? 'on' : ''} ${t.signature ? '' : 'supporting'}`}
                    title={`${t.in_deck} here, ${t.corpus} in the corpus`}
                    onClick={() => toggleTheme(t.slug)}>
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
                <button className="btn btn-ghost sm" title="Add to Cards"
                  onClick={() => collection.add(rec.card)}>+</button>
                <button className="btn btn-ghost sm" title="Add straight to the deck"
                  onClick={() => applyEdits([...deckCards, addedCard(rec.card, 'main')])}>
                  ↓ deck
                </button>
                {/* Most suggestions want considering, not committing. */}
                <button className="btn btn-ghost sm" title="Add to the maybeboard"
                  onClick={() => applyEdits([...deckCards, addedCard(rec.card, 'maybeboard')])}>
                  ↓ maybe
                </button>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  )

  return (
    <section className="shell" style={{ paddingTop: 20 }}>
      {/* Page-level actions live in the page header: they act on the whole
          deck, and anywhere lower puts the Playtest button underneath the
          panel it toggles. */}
      <div className="deck-head">
        <button className="back-link" onClick={() => navigate('/deck')}>← All decks</button>
        <input className="fld deck-name" placeholder="Untitled deck" value={deckName}
          onChange={(e) => setDeckName(e.target.value)} aria-label="Deck name" />
        <select className="fld" style={{ width: 'auto' }} value={format}
          onChange={(e) => setFormat(e.target.value)} aria-label="Format">
          {REC_FORMATS.map((f) => <option key={f} value={f}>{f || 'Any format'}</option>)}
        </select>

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

      {playing && <Playtest deck={deckCards} onClose={() => setPlaying(false)} />}

      <SplitPane storageKey="insight-enigma:deck-split" left={editorPane} right={analysisPane} />
    </section>
  )
}
