import { useEffect, useRef, useState } from 'react'

import type { DeckStats } from '../lib/api'
import { canAnimate, gsap } from '../lib/motion'

/**
 * Deck composition charts.
 *
 * Magic's five colours are semantically fixed — white must be pale, black must
 * be black, colourless must be grey, and red/green is the canonical
 * deuteranopia confusion (measured ΔE 4.8, far under the ΔE 8 floor). Those
 * hues cannot be re-picked without making the charts wrong, so colour never
 * carries meaning alone here: every segment prints its own count, segments are
 * separated by a surface-coloured gap and an outline, and a table view carries
 * the same numbers.
 */

const COLOR_ORDER = ['W', 'U', 'B', 'R', 'G', 'C', 'multi'] as const

const FILL: Record<string, string> = {
  W: 'var(--mana-w)', U: 'var(--mana-u)', B: 'var(--mana-b)',
  R: 'var(--mana-r)', G: 'var(--mana-g)', C: 'var(--mana-c)',
  multi: 'var(--accent-multi, #c9a227)',
}

const COLOR_NAME: Record<string, string> = {
  W: 'White', U: 'Blue', B: 'Black', R: 'Red', G: 'Green',
  C: 'Colourless', multi: 'Multicolour',
}

const TYPE_FILL: Record<string, string> = {
  Land: 'var(--mana-c)', Creature: 'var(--aether)', Artifact: '#9aa4b8',
  Enchantment: 'var(--ok)', Instant: '#7fb2e5', Sorcery: '#c98bd6',
  Planeswalker: 'var(--accent-warm, #e8b96a)', Other: 'var(--faint)',
}

/** An arc path for a donut segment. */
function arc(cx: number, cy: number, r: number, thickness: number, from: number, to: number) {
  const inner = r - thickness
  const large = to - from > Math.PI ? 1 : 0
  const p = (radius: number, a: number) =>
    [cx + radius * Math.cos(a - Math.PI / 2), cy + radius * Math.sin(a - Math.PI / 2)]
  const [x1, y1] = p(r, from)
  const [x2, y2] = p(r, to)
  const [x3, y3] = p(inner, to)
  const [x4, y4] = p(inner, from)
  return `M${x1} ${y1}A${r} ${r} 0 ${large} 1 ${x2} ${y2}L${x3} ${y3}A${inner} ${inner} 0 ${large} 0 ${x4} ${y4}Z`
}

interface Slice { key: string; label: string; value: number; fill: string }

function Donut({
  outer, inner, size = 190, outerLabel, innerLabel,
}: {
  outer: Slice[]
  inner: Slice[]
  size?: number
  outerLabel: string
  innerLabel: string
}) {
  const cx = size / 2
  const cy = size / 2
  const [hover, setHover] = useState<string | null>(null)

  const ring = (slices: Slice[], radius: number, thickness: number, ringKey: string) => {
    const total = slices.reduce((n, s) => n + s.value, 0) || 1
    let angle = 0
    return slices.map((slice) => {
      const sweep = (slice.value / total) * Math.PI * 2
      const from = angle
      // A 2px surface gap between fills, per the mark spec — it also does real
      // work here, separating hues that CVD readers cannot tell apart.
      const gap = slices.length > 1 ? 0.018 : 0
      angle += sweep
      const mid = from + sweep / 2
      const labelR = radius - thickness / 2
      const lx = cx + labelR * Math.cos(mid - Math.PI / 2)
      const ly = cy + labelR * Math.sin(mid - Math.PI / 2)
      const id = `${ringKey}-${slice.key}`
      const share = slice.value / total
      return (
        <g key={id}
          onMouseEnter={() => setHover(`${slice.label} · ${slice.value} (${Math.round(share * 100)}%)`)}
          onMouseLeave={() => setHover(null)}>
          <path
            className="donut-arc"
            d={arc(cx, cy, radius, thickness, from + gap, Math.max(from + gap, angle - gap))}
            fill={slice.fill}
            opacity={hover && !hover.startsWith(slice.label) ? 0.45 : 1}
          />
          {/* The count, not the colour's letter. A number is the thing you
              wanted to read, and it doubles as the non-colour encoding the
              letter used to provide. Too narrow a slice gets none: an
              overlapping label is worse than the tooltip. */}
          {share > 0.07 && (
            <text x={lx} y={ly} textAnchor="middle" dominantBaseline="central"
              className={`donut-label ${slice.key === 'B' ? 'on-dark' : ''}`}>
              {slice.value}
            </text>
          )}
        </g>
      )
    })
  }

  return (
    <div className="chart">
      <div className="chart-head">
        <span className="label">{outerLabel} <span className="faint">(outer)</span></span>
        <span className="label">{innerLabel} <span className="faint">(inner)</span></span>
      </div>
      {/* No width cap here: the viewBox scales cleanly, so how big the donut
          gets is a layout question and belongs in CSS. Capping it at the
          drawing size left it marooned in the middle of a wide panel. */}
      <svg viewBox={`0 0 ${size} ${size}`} role="img"
        aria-label={`${outerLabel} and ${innerLabel} by colour`}>
        {ring(outer, size / 2 - 4, 26, 'o')}
        {ring(inner, size / 2 - 36, 24, 'i')}
      </svg>
      <p className="chart-note mono">{hover ?? ' '}</p>
    </div>
  )
}

function TypeBars({ types }: { types: Record<string, number> }) {
  const entries = Object.entries(types).sort((a, b) => b[1] - a[1])
  const total = entries.reduce((n, [, v]) => n + v, 0) || 1
  return (
    <div className="chart">
      <div className="chart-head"><span className="label">Card types</span></div>
      <div className="type-bars">
        {entries.map(([name, value]) => (
          <div className="type-row" key={name} title={`${name}: ${value}`}>
            <span className="tb-name">{name}</span>
            <div className="tb-track">
              <div className="tb-fill" style={{
                width: `${(value / total) * 100}%`,
                background: TYPE_FILL[name] ?? 'var(--faint)',
              }} />
            </div>
            <span className="tb-val mono">{value}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

export function Curve({ curve }: { curve: Record<string, Record<string, number>> }) {
  const keys = ['0', '1', '2', '3', '4', '5', '6', '7+']
  const totals = keys.map((k) => Object.values(curve[k] ?? {}).reduce((n, v) => n + v, 0))
  const max = Math.max(1, ...totals)
  return (
    <div className="chart wide">
      <div className="chart-head"><span className="label">Mana curve</span></div>
      <div className="curve-chart">
        {keys.map((k, i) => {
          const bucket = curve[k] ?? {}
          const stack = COLOR_ORDER.filter((c) => bucket[c]).map((c) => ({
            key: c, value: bucket[c], fill: FILL[c],
          }))
          return (
            <div className="cc-col" key={k}>
              <span className="cc-total mono">{totals[i] || ''}</span>
              <div className="cc-stack" style={{ height: `${(totals[i] / max) * 100}%` }}>
                {stack.map((s) => (
                  <div key={s.key} className="cc-seg"
                    style={{ flexGrow: s.value, background: s.fill }}
                    title={`${COLOR_NAME[s.key]}: ${s.value}`}>
                    {/* Skipped on thin segments -- the label would spill past
                        the band it belongs to and read as the neighbour's. */}
                    {/* The stack is (total/max) of 150px and the segment is
                        value/total of that, so the segment is simply
                        (value/max) * 150 px tall. */}
                    {(s.value / max) * 150 > 13 && (
                      <span className={`cc-lab ${s.key === 'B' ? 'on-dark' : ''}`}>{s.value}</span>
                    )}
                  </div>
                ))}
              </div>
              <span className="cc-axis mono">{k}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

export function DeckCharts({ stats }: { stats: DeckStats }) {
  const ref = useRef<HTMLDivElement>(null)
  const [showTable, setShowTable] = useState(false)

  useEffect(() => {
    if (!ref.current || !canAnimate()) return
    gsap.fromTo(ref.current.querySelectorAll('.chart'),
      { opacity: 0, y: 16, filter: 'blur(8px)' },
      { opacity: 1, y: 0, filter: 'blur(0px)', duration: 0.6, stagger: { amount: 0.24 } })
  }, [stats])

  if (stats.empty) return null

  /* The panel exists to show where the base is weakest, so the bars are scaled
     against the best-supported colour rather than an absolute pass mark. A
     fixed threshold would be a fiction -- a healthy commander deck runs well
     under one source per pip -- and every colour failing it told the reader
     nothing about which colour to fix. */
  const best = Math.max(...stats.balance.map((b) => b.ratio), 0.0001)
  const worst = stats.balance.reduce(
    (low, b) => (low === null || b.ratio < low.ratio ? b : low),
    null as (typeof stats.balance)[number] | null,
  )
  // Only worth naming when it is actually behind the others.
  const lagging = worst && best > 0 && worst.ratio < best * 0.9 ? worst : null

  /* Restricted to the commander's colours, for the same reason the balance
     rows are: a land that taps for blue in a deck with no blue commander is
     not a blue source, and a slice for it is a slice of something the deck
     cannot cast. Decks with no commander keep every colour they use. */
  const inScope = (c: string) =>
    !stats.commander_identity || stats.commander_identity.includes(c)

  const toSlices = (src: Record<string, number>): Slice[] =>
    COLOR_ORDER.filter((c) => src[c] && inScope(c)).map((c) => ({
      key: c, label: COLOR_NAME[c], value: src[c], fill: FILL[c],
    }))

  const pips = toSlices(stats.pips)
  const sources = toSlices(stats.produced)

  return (
    <div className="deck-charts" ref={ref}>
      {/* Curve, then costs, then types: what the deck does turn by turn, then
          what it demands, then what it is made of. */}
      <div className="chart-grid">
        <Curve curve={stats.curve} />
        {(pips.length > 0 || sources.length > 0) && (
          <Donut outer={pips} inner={sources} outerLabel="Card costs" innerLabel="Land mana" />
        )}
        <TypeBars types={stats.types} />
      </div>

      {stats.balance.length > 0 && (
        <div className="panel" style={{ marginTop: 14 }}>
          <div className="row" style={{ justifyContent: 'space-between', marginBottom: 8 }}>
            <h3 style={{ margin: 0 }}>Mana base</h3>
            <button className="btn btn-ghost sm" onClick={() => setShowTable((s) => !s)}>
              {showTable ? 'Hide numbers' : 'Show numbers'}
            </button>
          </div>
          {/* What was counted, then the verdict. The old caption explained
              the method -- "against what the heaviest cost in that colour
              wants" -- which is the one thing a reader does not need in order
              to act. Where you are short is the point of the panel, so it is
              the sentence in the panel. */}
          <p className="faint" style={{ fontSize: 11, marginBottom: 2 }}>
            {stats.lands} land{stats.lands === 1 ? '' : 's'}
            {stats.mana_rocks > 0 && `, ${stats.mana_rocks} rock${stats.mana_rocks === 1 ? '' : 's'}`}
            {stats.mana_dorks > 0 && `, ${stats.mana_dorks} dork${stats.mana_dorks === 1 ? '' : 's'}`}
            {stats.other_mana_sources > 0 && `, ${stats.other_mana_sources} other`}
            {`. ${stats.coloured_sources} of them make coloured mana.`}
            {stats.commander_identity
              && ' Only the commander’s colours are counted, and each source is split'
                 + ' between the colours it makes.'}
          </p>
          <div className="balance">
            {stats.balance.map((b) => (
              <div className="bal-row" key={b.color}>
                <span className="bal-pip" style={{ background: FILL[b.color] }}>{b.color}</span>
                <span className="bal-name">{COLOR_NAME[b.color]}</span>
                {/* Sources against the number this colour's heaviest cost
                    wants. The track is the target; the fill is what you have,
                    clamped so a surplus reads as "full" rather than spilling
                    past the bar it is measured against. */}
                <div
                  className="bal-track"
                  title={`${b.weighted_sources} sources for ${b.pips} `
                    + `${COLOR_NAME[b.color].toLowerCase()} pip${b.pips === 1 ? '' : 's'}. `
                    + `${b.sources} cards can tap for it; each is split between the `
                    + 'commander colours it makes.'}
                >
                  <div
                    className={b === lagging ? 'bal-have short' : 'bal-have'}
                    style={{ width: `${(b.ratio / best) * 100}%` }}
                  />
                </div>
                <span className={b === lagging ? 'bal-gap short' : 'bal-gap'}>
                  {b.ratio.toFixed(2)}
                </span>
              </div>
            ))}
          </div>

          {/* The table is not optional decoration: with a palette this
              CVD-hostile it is the accessible path to the same numbers. */}
          {showTable && (
            <div className="scroll-x" style={{ marginTop: 12 }}>
              <table className="card-list">
                <thead>
                  <tr><th>Colour</th><th>Pips</th><th>Cards</th><th>Sources</th><th>Per pip</th></tr>
                </thead>
                <tbody>
                  {stats.balance.map((b) => (
                    <tr key={b.color}>
                      <td>{COLOR_NAME[b.color]}</td>
                      <td className="num">{b.pips}</td>
                      <td className="num">{b.sources}</td>
                      <td className="num">{b.weighted_sources}</td>
                      <td className="num">{b.ratio.toFixed(2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
