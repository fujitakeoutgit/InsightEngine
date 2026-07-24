import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'

import { api, type DeckReport, type Resolution } from '../lib/api'
import { countTo, dissolveIn, riseIn } from '../lib/motion'

const SAMPLE = `Commander
1 Atraxa, Praetors' Voice

Deck
1 Sol Ring
1 Arcane Signet
4x Llanowar Elfs
1 fire/ice
1 swords to plowshares
10 Forest
8 Plains

Sideboard
2 Duress
`

const CURVE_KEYS = ['0', '1', '2', '3', '4', '5', '6', '7+']

/** Match kinds worth surfacing: anything the resolver was not certain about. */
const UNCERTAIN = new Set(['fuzzy', 'ambiguous', 'prefix', 'unresolved'])

function ResolutionRow({ entry }: { entry: Resolution }) {
  return (
    <div className="resolution">
      <span className="q mono">{entry.quantity}×</span>
      <span className="muted" style={{ flex: '0 1 auto', minWidth: 0 }}>
        {entry.raw_name}
      </span>
      <span className="arrow">→</span>
      <span className="to">
        {entry.card ? (
          <Link to={`/card/${entry.card.oracle_id}`}>{entry.card.name}</Link>
        ) : (
          <span style={{ color: 'var(--bad)' }}>no match</span>
        )}
        {entry.alternatives.length > 0 && (
          <span className="faint" style={{ fontSize: 'var(--step--2)' }}>
            {' '}
            · or {entry.alternatives.slice(0, 3).join(', ')}
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
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showAll, setShowAll] = useState(false)

  const priceRef = useRef<HTMLSpanElement>(null)
  const countRef = useRef<HTMLSpanElement>(null)
  const resultRef = useRef<HTMLDivElement>(null)

  const analyse = async () => {
    if (!text.trim()) return
    setLoading(true)
    setError(null)
    try {
      setReport(await api.analyzeDeck(text))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Analysis failed')
      setReport(null)
    } finally {
      setLoading(false)
    }
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

  const maxCurve = report
    ? Math.max(1, ...CURVE_KEYS.map((k) => report.curve[k] ?? 0))
    : 1

  const uncertain = report?.entries.filter((e) => UNCERTAIN.has(e.match)) ?? []
  const shown = showAll ? (report?.entries ?? []) : uncertain

  return (
    <section className="shell" style={{ paddingTop: 'var(--gap-4)' }}>
      <div className="section-head">
        <h2>Deck Lab</h2>
        <p className="muted" style={{ fontSize: 'var(--step--1)' }}>
          Paste any list. Quantities, set codes, split cards and typos are all handled.
        </p>
      </div>

      <div className="deck">
        <div className="stack gap-3">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={SAMPLE}
            spellCheck={false}
            aria-label="Decklist"
          />
          <div className="row gap-2 wrap">
            <button className="btn btn-primary" onClick={analyse} disabled={loading || !text.trim()}>
              {loading ? <span className="spinner" /> : null}
              {loading ? 'Analysing…' : 'Analyse deck'}
            </button>
            <button className="btn btn-ghost" onClick={() => setText(SAMPLE)}>
              Load sample
            </button>
            {text && (
              <button className="btn btn-ghost" onClick={() => { setText(''); setReport(null) }}>
                Clear
              </button>
            )}
          </div>
          <p className="faint" style={{ fontSize: 'var(--step--2)' }}>
            Sections are detected from <code className="mono">Commander</code>,{' '}
            <code className="mono">Deck</code>, <code className="mono">Sideboard</code> headers,
            or <code className="mono">*CMDR*</code> / <code className="mono">SB:</code> markers.
          </p>
        </div>

        <div ref={resultRef}>
          {error && (
            <div className="notice error">
              <h3>Could not analyse</h3>
              <p>{error}</p>
            </div>
          )}

          {!report && !error && (
            <div className="notice">
              <h3>Nothing analysed yet</h3>
              <p>Paste a decklist and press Analyse.</p>
            </div>
          )}

          {report && (
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
                    style={{ color: report.unresolved_count ? 'var(--bad)' : 'var(--ok)' }}
                  >
                    {report.unresolved_count}
                  </span>
                  <span className="label">Unresolved</span>
                </div>
              </div>

              {report.cards_missing_price > 0 && (
                <p className="faint" style={{ fontSize: 'var(--step--2)', marginTop: 'calc(var(--gap-3) * -1)' }}>
                  {report.cards_missing_price} card(s) have no USD price; the estimate excludes them.
                </p>
              )}

              <div className="panel">
                <h3>Mana curve (non-land)</h3>
                <div className="curve">
                  {CURVE_KEYS.map((key) => {
                    const value = report.curve[key] ?? 0
                    return (
                      <div className="bar" key={key}>
                        <span className="cap">{value || ''}</span>
                        <div
                          className="fill"
                          style={{ height: `${(value / maxCurve) * 100}%` }}
                        />
                        <span className="cap">{key}</span>
                      </div>
                    )
                  })}
                </div>
              </div>

              <div className="panel">
                <div className="row" style={{ justifyContent: 'space-between', marginBottom: 'var(--gap-2)' }}>
                  <h3 style={{ margin: 0 }}>
                    Name resolution{' '}
                    {uncertain.length > 0 && (
                      <span style={{ color: 'var(--warn)' }}>· {uncertain.length} need a look</span>
                    )}
                  </h3>
                  <button className="btn btn-ghost" onClick={() => setShowAll(!showAll)}>
                    {showAll ? 'Only uncertain' : `Show all ${report.entries.length}`}
                  </button>
                </div>
                {shown.length === 0 ? (
                  <p className="muted" style={{ fontSize: 'var(--step--1)' }}>
                    Every name resolved exactly.
                  </p>
                ) : (
                  shown.map((entry, i) => <ResolutionRow key={i} entry={entry} />)
                )}
                {report.ignored_lines.length > 0 && (
                  <p className="faint" style={{ fontSize: 'var(--step--2)', marginTop: 'var(--gap-2)' }}>
                    Ignored {report.ignored_lines.length} line(s) that held no card.
                  </p>
                )}
              </div>

              <div className="panel">
                <h3>Format legality</h3>
                <div className="verdicts">
                  {report.formats.map((verdict) => (
                    <div className={`verdict ${verdict.legal ? 'yes' : 'no'}`} key={verdict.format}>
                      <div className="row" style={{ justifyContent: 'space-between', gap: 'var(--gap-2)' }}>
                        <span className="nm">{verdict.label}</span>
                        <span className={`st ${verdict.legal ? 'legal' : 'banned'}`}>
                          {verdict.legal ? 'legal' : 'no'}
                        </span>
                      </div>
                      {!verdict.legal && (
                        <div className="why">
                          {verdict.issues.slice(0, 2).map((issue, i) => (
                            <div key={i}>{issue}</div>
                          ))}
                          {verdict.problem_cards.slice(0, 3).map((problem, i) => (
                            <div key={`p${i}`}>
                              {problem.name} — {problem.reason}
                            </div>
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
        </div>
      </div>
    </section>
  )
}
