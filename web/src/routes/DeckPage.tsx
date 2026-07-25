import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'

import {
  api, type DeckReport, type RecommendReport, type Resolution, type SavedDeck,
} from '../lib/api'
import { collection } from '../lib/collection'
import { countTo, dissolveIn, riseIn } from '../lib/motion'
import { ManaCost } from '../components/ManaCost'

const SAMPLE = `Commander
1 Teysa Karlov

Deck
1 Blood Artist
1 Zulaport Cutthroat
1 Viscera Seer
1 Carrion Feeder
1 Ashnod's Altar
1 Village Rites
1 Priest of Forgotten Gods
10 Swamp
8 Plains

Sideboard
2 Duress
`

const CURVE_KEYS = ['0', '1', '2', '3', '4', '5', '6', '7+']
const UNCERTAIN = new Set(['fuzzy', 'ambiguous', 'prefix', 'unresolved'])

const REC_FORMATS = [
  '', 'commander', 'standard', 'pioneer', 'modern', 'legacy', 'vintage', 'pauper', 'brawl',
]

function ResolutionRow({ entry }: { entry: Resolution }) {
  return (
    <div className="resolution">
      <span className="q mono">{entry.quantity}×</span>
      <span className="muted" style={{ flex: '0 1 auto', minWidth: 0 }}>{entry.raw_name}</span>
      <span className="arrow">→</span>
      <span className="to">
        {entry.card ? (
          <Link to={`/card/${entry.card.oracle_id}`}>{entry.card.name}</Link>
        ) : (
          <span style={{ color: 'var(--danger)' }}>no match</span>
        )}
        {entry.alternatives.length > 0 && (
          <span className="faint" style={{ fontSize: 11 }}>
            {' '}· or {entry.alternatives.slice(0, 3).join(', ')}
          </span>
        )}
      </span>
      <span className={`match-tag ${entry.match}`}>
        {entry.match}
        {entry.match !== 'exact' && entry.score > 0 && ` ${Math.round(entry.score)}`}
      </span>
    </div>
  )
}

export function DeckPage() {
  const [text, setText] = useState('')
  const [report, setReport] = useState<DeckReport | null>(null)
  const [recs, setRecs] = useState<RecommendReport | null>(null)
  const [saved, setSaved] = useState<SavedDeck[]>([])
  const [deckName, setDeckName] = useState('')
  const [deckId, setDeckId] = useState<number | null>(null)
  const [recFormat, setRecFormat] = useState('commander')
  const [busy, setBusy] = useState<'analyse' | 'recommend' | 'save' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [showAll, setShowAll] = useState(false)
  // Which result panel is showing. Recommendations used to render *below* the
  // analysis — several screens down past the curve, resolution list and 21
  // format verdicts — so pressing the button looked like it did nothing.
  const [tab, setTab] = useState<'analysis' | 'recommendations'>('analysis')

  const priceRef = useRef<HTMLSpanElement>(null)
  const countRef = useRef<HTMLSpanElement>(null)
  const resultRef = useRef<HTMLDivElement>(null)
  const recRef = useRef<HTMLDivElement>(null)

  const refreshSaved = () =>
    api.savedDecks().then((r) => setSaved(r.decks)).catch(() => {})

  useEffect(() => { refreshSaved() }, [])

  useEffect(() => {
    if (!status) return
    const timer = setTimeout(() => setStatus(null), 3000)
    return () => clearTimeout(timer)
  }, [status])

  const analyse = async () => {
    if (!text.trim()) return
    setBusy('analyse')
    setError(null)
    setTab('analysis')
    try {
      setReport(await api.analyzeDeck(text))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Analysis failed')
      setReport(null)
    } finally {
      setBusy(null)
    }
  }

  const getRecommendations = async () => {
    if (!text.trim()) return
    setBusy('recommend')
    setError(null)
    setTab('recommendations')
    try {
      setRecs(await api.recommendDeck(text, recFormat || null))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not build recommendations')
      setRecs(null)
    } finally {
      setBusy(null)
    }
  }

  const save = async () => {
    if (!text.trim()) return
    setBusy('save')
    setError(null)
    try {
      const { deck } = await api.saveDeck({
        name: deckName || 'Untitled deck',
        text,
        id: deckId ?? undefined,
        format: recFormat || null,
      })
      setDeckId(deck.id)
      setDeckName(deck.name)
      setStatus(`Saved “${deck.name}”`)
      await refreshSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save deck')
    } finally {
      setBusy(null)
    }
  }

  const load = async (id: number) => {
    try {
      const { deck } = await api.loadDeck(id)
      setText(deck.text ?? '')
      setDeckName(deck.name)
      setDeckId(deck.id)
      setReport(null)
      setRecs(null)
      setStatus(`Loaded “${deck.name}”`)
    } catch {
      setError('Could not load that deck')
    }
  }

  const remove = async (id: number) => {
    await api.deleteDeck(id).catch(() => {})
    if (deckId === id) setDeckId(null)
    await refreshSaved()
  }

  useEffect(() => {
    if (!report) return
    riseIn(resultRef.current)
    countTo(countRef.current, report.total_cards)
    countTo(priceRef.current, report.price_usd, (n) => `$${n.toFixed(2)}`)
    if (resultRef.current) {
      dissolveIn(resultRef.current.querySelectorAll('.verdict'), { stagger: 0.02 })
    }
  }, [report])

  useEffect(() => {
    if (recs && recRef.current) {
      riseIn(recRef.current)
      dissolveIn(recRef.current.querySelectorAll('.rec-row'), { stagger: 0.015 })
    }
  }, [recs])

  const maxCurve = report ? Math.max(1, ...CURVE_KEYS.map((k) => report.curve[k] ?? 0)) : 1
  const uncertain = report?.entries.filter((e) => UNCERTAIN.has(e.match)) ?? []
  const shown = showAll ? (report?.entries ?? []) : uncertain

  return (
    <section className="shell" style={{ paddingTop: 22 }}>
      <div className="section-head">
        <div>
          <span className="eyebrow">Import & analyse</span>
          <h2>Deck Lab</h2>
        </div>
        <p className="muted" style={{ fontSize: 13, maxWidth: '46ch' }}>
          Paste any list. Quantities, set codes, split cards and typos are all handled.
        </p>
      </div>

      <div className="deck">
        <div className="stack gap-3">
          <div className="cond-row">
            <input
              className="fld"
              placeholder="Deck name"
              value={deckName}
              onChange={(e) => setDeckName(e.target.value)}
              aria-label="Deck name"
            />
            <select
              className="fld" style={{ width: 'auto' }}
              value={recFormat} onChange={(e) => setRecFormat(e.target.value)}
              aria-label="Format"
            >
              {REC_FORMATS.map((f) => (
                <option key={f} value={f}>{f ? f : 'Any format'}</option>
              ))}
            </select>
          </div>

          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={SAMPLE}
            spellCheck={false}
            aria-label="Decklist"
          />

          <div className="row gap-2 wrap">
            <button className="btn btn-primary" onClick={analyse} disabled={!!busy || !text.trim()}>
              {busy === 'analyse' && <span className="spinner" />}
              {busy === 'analyse' ? 'Analysing' : 'Analyse deck'}
            </button>
            <button className="btn" onClick={getRecommendations} disabled={!!busy || !text.trim()}>
              {busy === 'recommend' && <span className="spinner" />}
              {busy === 'recommend' ? 'Thinking' : 'Recommendations'}
            </button>
            <button className="btn" onClick={save} disabled={!!busy || !text.trim()}>
              {busy === 'save' && <span className="spinner" />}
              {deckId ? 'Update saved' : 'Save deck'}
            </button>
            <button className="btn btn-ghost sm" onClick={() => setText(SAMPLE)}>Sample</button>
            {text && (
              <button
                className="btn btn-ghost sm"
                onClick={() => { setText(''); setReport(null); setRecs(null); setDeckId(null) }}
              >
                Clear
              </button>
            )}
          </div>

          {status && <p className="mono" style={{ fontSize: 12, color: 'var(--ok)' }}>{status}</p>}

          <p className="faint" style={{ fontSize: 11 }}>
            Sections come from <code className="mono">Commander</code> /{' '}
            <code className="mono">Deck</code> / <code className="mono">Sideboard</code> headers,
            or <code className="mono">*CMDR*</code> and <code className="mono">SB:</code> markers.
          </p>

          {saved.length > 0 && (
            <div className="panel">
              <h3>Saved decks</h3>
              {saved.map((deck) => (
                <div className="resolution" key={deck.id}>
                  <span className="to">
                    <button
                      className="mono"
                      style={{ color: deck.id === deckId ? 'var(--aether-hi)' : 'var(--ink)' }}
                      onClick={() => load(deck.id)}
                    >
                      {deck.name}
                    </button>
                    <span className="faint" style={{ fontSize: 11 }}>
                      {' '}· {deck.lines ?? 0} lines · {deck.updated_at.slice(0, 10)}
                    </span>
                  </span>
                  <button className="remove-row" onClick={() => remove(deck.id)} aria-label="Delete">
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        <div ref={resultRef}>
          {error && (
            <div className="notice error">
              <h3>Could not continue</h3>
              <p>{error}</p>
            </div>
          )}

          {!report && !recs && !error && (
            <div className="notice">
              <h3>Nothing analysed yet</h3>
              <p>Paste a decklist, then Analyse it or ask for Recommendations.</p>
            </div>
          )}

          {(report || recs) && (
            <div className="result-tabs">
              <button
                className={tab === 'analysis' ? 'on' : ''}
                disabled={!report}
                onClick={() => setTab('analysis')}
              >
                Analysis
                {report && <span className="faint"> {report.total_cards}</span>}
              </button>
              <button
                className={tab === 'recommendations' ? 'on' : ''}
                disabled={!recs}
                onClick={() => setTab('recommendations')}
              >
                Recommendations
                {recs && <span className="faint"> {recs.recommendations.length}</span>}
              </button>
            </div>
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
                  <span
                    className="v mono"
                    style={{ color: report.unresolved_count ? 'var(--danger)' : 'var(--ok)' }}
                  >
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

              <div className="panel">
                <div className="row" style={{ justifyContent: 'space-between', marginBottom: 10 }}>
                  <h3 style={{ margin: 0 }}>
                    Name resolution{' '}
                    {uncertain.length > 0 && (
                      <span style={{ color: 'var(--warn)' }}>· {uncertain.length} need a look</span>
                    )}
                  </h3>
                  <button className="btn btn-ghost sm" onClick={() => setShowAll(!showAll)}>
                    {showAll ? 'Only uncertain' : `All ${report.entries.length}`}
                  </button>
                </div>
                {shown.length === 0 ? (
                  <p className="muted" style={{ fontSize: 13 }}>Every name resolved exactly.</p>
                ) : (
                  shown.map((entry, i) => <ResolutionRow key={i} entry={entry} />)
                )}
              </div>

              <div className="panel">
                <h3>Format legality</h3>
                <div className="verdicts">
                  {report.formats.map((verdict) => (
                    <div className={`verdict ${verdict.legal ? 'yes' : 'no'}`} key={verdict.format}>
                      <div className="row" style={{ justifyContent: 'space-between', gap: 10 }}>
                        <span className="nm">{verdict.label}</span>
                        <span className={`st ${verdict.legal ? 'legal' : 'banned'}`}>
                          {verdict.legal ? 'legal' : 'no'}
                        </span>
                      </div>
                      {!verdict.legal && (
                        <div className="why">
                          {verdict.issues.slice(0, 2).map((issue, i) => <div key={i}>{issue}</div>)}
                          {verdict.problem_cards.slice(0, 3).map((p, i) => (
                            <div key={`p${i}`}>{p.name} — {p.reason}</div>
                          ))}
                          {verdict.problem_cards.length > 3 && (
                            <div>+{verdict.problem_cards.length - 3} more</div>
                          )}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {tab === 'recommendations' && recs && (
            <div className="panel" ref={recRef}>
              <h3>
                Recommendations
                {recs.color_identity !== undefined && (
                  <span className="faint"> · within {recs.color_identity || 'colourless'}</span>
                )}
              </h3>

              {recs.note && <p className="muted" style={{ fontSize: 13 }}>{recs.note}</p>}

              {recs.themes.length > 0 && (
                <>
                  <p className="faint" style={{ fontSize: 11, marginBottom: 8 }}>
                    Themes read from the tags your cards already carry — weighted against how
                    common each tag is overall, so generic mechanics don’t drown out the deck.
                  </p>
                  <div className="row wrap gap-1" style={{ marginBottom: 14 }}>
                    {recs.themes.map((t) => (
                      <Link
                        key={t.slug}
                        to={`/?q=${encodeURIComponent(`otag:${t.slug}`)}`}
                        className="chip on"
                        title={`${t.in_deck} in this deck, ${t.corpus} in the corpus`}
                      >
                        {t.slug} <span className="faint">×{t.in_deck}</span>
                      </Link>
                    ))}
                  </div>
                </>
              )}

              {recs.recommendations.map((rec) => (
                <div className="resolution rec-row" key={rec.card.oracle_id}>
                  <span className="to">
                    <Link to={`/card/${rec.card.oracle_id}`}>{rec.card.name}</Link>{' '}
                    <ManaCost cost={rec.card.mana_cost} />
                    <span className="faint" style={{ fontSize: 11, display: 'block' }}>
                      {rec.because.slice(0, 3).join(' · ')}
                    </span>
                  </span>
                  <span className="mono faint" style={{ fontSize: 11 }}>
                    {rec.card.usd !== null ? `$${rec.card.usd.toFixed(2)}` : '—'}
                  </span>
                  <button
                    className="btn btn-ghost sm"
                    title="Add to Cards"
                    onClick={() => collection.add(rec.card)}
                  >
                    +
                  </button>
                  <button
                    className="btn btn-ghost sm"
                    title="Append to the decklist"
                    onClick={() => setText((t) => `${t.trimEnd()}\n1 ${rec.card.name}\n`)}
                  >
                    ↓ deck
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </section>
  )
}
