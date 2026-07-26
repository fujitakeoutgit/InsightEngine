import { useEffect, useRef } from 'react'
import type { GuardReport, SemanticStage } from '../lib/api'

/** Search pipeline stages in execution order. Summarisation was removed. */
export const SEARCH_RAIL = [
  { key: 'concepts', label: 'Interpret' },
  { key: 'vocabulary', label: 'Vocabulary' },
  { key: 'plans', label: 'Plan' },
  { key: 'execute', label: 'Query' },
  { key: 'evaluate', label: 'Evaluate' },
]

/** The deck recommender asks a different question, so it has its own stages. */
export const DECK_RAIL = [
  { key: 'read', label: 'Read deck' },
  { key: 'vocabulary', label: 'Vocabulary' },
  { key: 'plans', label: 'Plan' },
  { key: 'execute', label: 'Query' },
  { key: 'judge', label: 'Judge' },
]

export interface ConsoleState {
  running: boolean
  stages: SemanticStage[]
  current: string
  error: string | null
  cancelled: boolean
  model: string
}

export const EMPTY_CONSOLE: ConsoleState = {
  running: false,
  stages: [],
  current: '',
  error: null,
  cancelled: false,
  model: 'llama3.3:70b',
}

function Guard({ guard }: { guard: GuardReport }) {
  if (guard.clean) {
    return (
      <div className="guard clean">
        <span>✓</span>
        <span>
          Hallucination guard passed — every card below came from the database, and the model
          emitted only index numbers.
        </span>
      </div>
    )
  }
  return (
    <div className="guard dirty">
      <span>⚠</span>
      <span>
        Guard intervened: {guard.invalid_indices.length} invalid selection(s) discarded.
      </span>
    </div>
  )
}

export function SemanticConsole({
  state,
  collapsed,
  onToggle,
  onStop,
  below = false,
  rail = SEARCH_RAIL,
  title = 'Semantic pipeline',
}: {
  state: ConsoleState
  collapsed: boolean
  onToggle: () => void
  onStop: () => void
  below?: boolean
  rail?: { key: string; label: string }[]
  title?: string
}) {
  const RAIL = rail
  const logRef = useRef<HTMLDivElement>(null)

  // Keep the newest line in view as events stream in.
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [state.stages.length])

  const seen = new Set(state.stages.map((s) => s.stage))
  const activeIndex = RAIL.findIndex((r) => r.key === state.current)
  const complete = seen.has('complete')

  const final = state.stages.find((s) => s.stage === 'complete')
  const executeStage = [...state.stages].reverse().find((s) => s.stage === 'execute')
  const conceptStage = state.stages.find((s) => s.stage === 'concepts' && s.detail.concepts?.length)
  const vocabStage = state.stages.find((s) => s.stage === 'vocabulary' && s.detail.tags)

  const headline = state.cancelled
    ? 'Stopped'
    : state.error
      ? 'Failed'
      : complete
        ? `${final?.detail.cards?.length ?? 0} selected of ${final?.detail.candidate_count ?? 0}`
        : (state.stages.at(-1)?.message ?? 'Starting')

  return (
    <div className={`console ${collapsed ? 'collapsed' : ''} ${below ? 'below' : ''}`}>
      <div
        className="console-head"
        onClick={onToggle}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && onToggle()}
      >
        <span className="caret">▾</span>
        <span className="label">{title}</span>
        <span className="model mono">{state.model}</span>
        {state.running && <span className="spinner" />}
        <span className="mono faint" style={{ fontSize: 11 }}>
          {headline}
        </span>
        {state.running && (
          <button
            className="btn btn-danger sm push"
            onClick={(e) => {
              e.stopPropagation()
              onStop()
            }}
          >
            Stop
          </button>
        )}
      </div>

      {!collapsed && (
        <div className="console-body">
          <div className="stages">
            {RAIL.map((stage, i) => {
              const isDone = complete || (activeIndex >= 0 && i < activeIndex)
              const isActive = !complete && stage.key === state.current
              return (
                <div
                  key={stage.key}
                  className={`stage ${isActive ? 'active' : ''} ${isDone ? 'done' : ''}`}
                >
                  <span className="dot" />
                  {stage.label}
                </div>
              )
            })}
          </div>

          {conceptStage?.detail.concepts && (
            <div style={{ marginBottom: 16 }}>
              <span className="label">Concepts</span>
              <div className="row wrap gap-1" style={{ marginTop: 6 }}>
                {conceptStage.detail.concepts.map((c) => (
                  <span key={c} className="chip">{c}</span>
                ))}
              </div>
            </div>
          )}

          {vocabStage?.detail.tags && (
            <div style={{ marginBottom: 16 }}>
              <span className="label">
                Oracle tags — a closed vocabulary the model must choose from
              </span>
              <div className="row wrap gap-1" style={{ marginTop: 6 }}>
                {(vocabStage.detail.tags as { slug: string; count: number }[])
                  .slice(0, 14)
                  .map((t) => (
                    <span key={t.slug} className="chip on">
                      {t.slug} <span className="faint">{t.count}</span>
                    </span>
                  ))}
              </div>
            </div>
          )}

          {executeStage?.detail.plans && executeStage.detail.plans.length > 0 && (
            <div style={{ marginBottom: 16 }}>
              <span className="label">Query plans — results are unioned, so breadth wins</span>
              <div className="stack gap-1" style={{ marginTop: 6 }}>
                {executeStage.detail.plans.map((plan, i) => (
                  <div className="plan-card" key={i}>
                    <span className="n">{String(plan.matched).padStart(4, ' ')} ✳</span>{' '}
                    {plan.rationale}
                    {plan.error && <span className="err"> — discarded: {plan.error}</span>}
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="console-log" ref={logRef}>
            {state.stages.map((stage, i) => (
              <div
                className={`line ${stage.detail.warnings?.length ? 'warn' : ''}`}
                key={`${stage.stage}-${i}`}
              >
                <span className="t">{stage.stage.padEnd(11, ' ')}</span>
                <span>{stage.message}</span>
              </div>
            ))}
            {state.cancelled && (
              <div className="line warn">
                <span className="t">stopped</span>
                <span>Run cancelled; model released.</span>
              </div>
            )}
            {state.error && (
              <div className="line bad">
                <span className="t">error</span>
                <span>{state.error}</span>
              </div>
            )}
          </div>

          {final?.detail.guard && <Guard guard={final.detail.guard} />}
        </div>
      )}
    </div>
  )
}
