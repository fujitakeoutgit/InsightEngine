import { useEffect, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'

import { api, type SimulationReport } from '../lib/api'
import { PageHead } from '../components/PageHead'

const PRESETS = [100, 1000, 5000, 20000]

/** Mana symbol colours, matching the charts. */
const FILL: Record<string, string> = {
  W: 'var(--mana-w)', U: 'var(--mana-u)', B: 'var(--mana-b)',
  R: 'var(--mana-r)', G: 'var(--mana-g)',
}

function pct(value: number) {
  return `${Math.round(value * 100)}%`
}

/**
 * Shuffle the deck a few thousand times and see what actually happens.
 *
 * The mana base panel answers "what is in the list". This answers "what did I
 * have on turn three", which is a different question and the one that decides
 * whether a deck feels good to play. A list can be perfectly balanced on paper
 * and still miss half its land drops.
 */
export function SimulationPage() {
  const { deckId } = useParams()
  const [deckName, setDeckName] = useState<string>('')
  const [text, setText] = useState<string>('')
  const [iterations, setIterations] = useState(1000)
  const [turns, setTurns] = useState(10)
  const [report, setReport] = useState<SimulationReport | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const ran = useRef(false)

  useEffect(() => {
    if (!deckId) return
    api.loadDeck(Number(deckId))
      .then(({ deck }) => { setDeckName(deck.name); setText(deck.text ?? '') })
      .catch(() => setError('Could not load that deck.'))
  }, [deckId])

  const run = async () => {
    if (!text.trim()) return
    setBusy(true)
    setError(null)
    try {
      setReport(await api.simulateDeck({ text, iterations, turns }))
    } catch {
      setError('The simulation could not finish.')
    } finally {
      setBusy(false)
    }
  }

  // One run on arrival, so the page opens with something to read rather than
  // an empty frame and a button.
  useEffect(() => {
    if (text && !ran.current) { ran.current = true; void run() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text])

  const rows = report && !report.empty ? report.by_turn : []
  const peakMana = Math.max(1, ...rows.map((r) => r.mana))
  const colourKeys = Object.keys(rows[rows.length - 1]?.sources ?? {})

  return (
    <section className="stack gap-4">
      <PageHead
        back={{ fallback: '/deck' }}
        title="Simulation"
        subtitle={deckName
          ? `Shuffling ${deckName} and playing the opening turns, over and over.`
          : 'Shuffling a deck and playing the opening turns, over and over.'}
      />

      <div className="panel">
        <div className="row gap-3 wrap" style={{ alignItems: 'flex-end' }}>
          <label className="stack gap-1">
            <span className="label">Games</span>
            <div className="row gap-1">
              {PRESETS.map((n) => (
                <button
                  key={n}
                  className={iterations === n ? 'btn btn-primary sm' : 'btn btn-ghost sm'}
                  onClick={() => setIterations(n)}
                >
                  {n.toLocaleString()}
                </button>
              ))}
            </div>
          </label>

          <label className="stack gap-1">
            <span className="label">Turns</span>
            <input
              className="fld"
              type="number"
              min={1}
              max={20}
              value={turns}
              style={{ width: 84 }}
              onChange={(e) => setTurns(Math.max(1, Math.min(20, Number(e.target.value) || 1)))}
            />
          </label>

          <button className="btn btn-primary" onClick={run} disabled={busy || !text.trim()}>
            {busy && <span className="spinner" />}Run simulation
          </button>
        </div>

        {error && <p style={{ color: 'var(--danger)', fontSize: 13 }}>{error}</p>}
      </div>

      {report?.empty && (
        <div className="panel"><p className="muted">{report.reason}</p></div>
      )}

      {report && !report.empty && (
        <>
          <div className="panel">
            <h3>Land drops</h3>
            <p className="faint" style={{ fontSize: 11, marginBottom: 10 }}>
              {report.iterations.toLocaleString()} games · {report.library_size} cards in
              the library · the commander is not shuffled in.
            </p>
            <div className="deck-stats">
              <Stat label="Missed a drop" value={pct(report.games_missing_a_drop)} />
              <Stat
                label="First miss, on average"
                value={report.avg_first_missed_turn
                  ? `turn ${report.avg_first_missed_turn}`
                  : 'never'}
              />
            </div>
          </div>

          <div className="panel">
            <h3>By turn</h3>
            <div className="scroll-x">
              <table className="card-list sim-table">
                <thead>
                  <tr>
                    <th>Turn</th>
                    <th>Mana</th>
                    {/* These head right-aligned numbers, so they are right
                        aligned too. A heading at the left of a column whose
                        values are at the right is not a heading for them. */}
                    <th className="num">Lands</th>
                    <th className="num">Rocks &amp; dorks</th>
                    <th className="num">Colours</th>
                    <th className="num">Missed drop</th>
                    <th className="num">Avg. cost in hand</th>
                    <th className="num">Hand</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.turn}>
                      <td className="mono">{r.turn}</td>
                      <td>
                        {/* The bar carries the shape; the number carries the
                            value. Reading a curve out of eight rows of digits
                            is work the chart can do instead. */}
                        <div className="sim-bar">
                          <span style={{ width: `${(r.mana / peakMana) * 100}%` }} />
                          <b className="mono">{r.mana.toFixed(2)}</b>
                        </div>
                      </td>
                      <td className="num mono">{r.lands.toFixed(2)}</td>
                      <td className="num mono">{r.accelerants.toFixed(2)}</td>
                      <td className="num mono">{r.colours.toFixed(2)}</td>
                      <td
                        className="num mono"
                        style={{ color: r.missed_land_drop > 0.3 ? 'var(--warn)' : undefined }}
                      >
                        {pct(r.missed_land_drop)}
                      </td>
                      <td className="num mono">{r.avg_cmc_in_hand.toFixed(2)}</td>
                      <td className="num mono">{r.hand_size.toFixed(1)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="panel">
            <h3>Sources by colour</h3>
            <p className="faint" style={{ fontSize: 11, marginBottom: 10 }}>
              Weighted: a land making two of the commander&rsquo;s colours counts a half
              to each, three counts a third, and so on.
            </p>
            <div className="scroll-x">
              <table className="card-list sim-colours">
                <thead>
                  <tr>
                    <th>Turn</th>
                    {colourKeys.map((c) => (
                      <th key={c}>
                        {/* The pip is display:grid, so it is block-level and
                            text-align on the cell does nothing to it -- it sat
                            at the far left of a 307px column while its numbers
                            sat at the right. A flex wrapper is what actually
                            moves it. */}
                        <span className="sim-pip-head">
                          <span className="bal-pip" style={{ background: FILL[c] }}>{c}</span>
                        </span>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.turn}>
                      <td className="mono">{r.turn}</td>
                      {colourKeys.map((c) => (
                        <td key={c} className="num mono">{(r.sources[c] ?? 0).toFixed(2)}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <p className="faint" style={{ fontSize: 11 }}>
            A mana simulation, not a game. No spell is cast except a rock or a dork,
            one land is played per turn whenever the hand holds one, and anything
            entering tapped or summoning-sick pays nothing until the following turn.
          </p>
        </>
      )}
    </section>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="stat">
      <span className="v mono">{value}</span>
      <span className="label">{label}</span>
    </div>
  )
}
