import { useEffect, useRef } from 'react'
import type { GuardReport, SemanticStage } from '../lib/api'
import { riseIn } from '../lib/motion'

/** Pipeline stages in execution order, with the labels shown on the rail. */
const RAIL = [
  { key: 'concepts', label: 'Interpret' },
  { key: 'vocabulary', label: 'Vocabulary' },
  { key: 'plans', label: 'Plan' },
  { key: 'execute', label: 'Query' },
  { key: 'evaluate', label: 'Evaluate' },
  { key: 'summarise', label: 'Analyse' },
] as const

export interface ConsoleState {
  running: boolean
  stages: SemanticStage[]
  current: string
  error: string | null
  model: string
}

function Guard({ guard }: { guard: GuardReport }) {
  if (guard.clean) {
    return (
      <div className="guard clean">
        <span>✓</span>
        <span>
          Hallucination guard passed — every card below was returned by the database, and the
          model named none of them in prose.
        </span>
      </div>
    )
  }
  return (
    <div className="guard dirty">
      <span>⚠</span>
      <span>
        Guard intervened.
        {guard.invalid_indices.length > 0 &&
          ` ${guard.invalid_indices.length} invalid selection(s) discarded.`}
        {guard.leaked_names.length > 0 &&
          ` Model named ${guard.leaked_names.length} card(s) in prose (${guard.leaked_names
            .slice(0, 3)
            .join(', ')}); analysis replaced with a summary computed from the data.`}
      </span>
    </div>
  )
}

export function SemanticConsole({ state }: { state: ConsoleState }) {
  const ref = useRef<HTMLDivElement>(null)
  const logRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    riseIn(ref.current)
  }, [])

  // Keep the newest line in view as events stream in.
  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight
    }
  }, [state.stages.length])

  const seen = new Set(state.stages.map((s) => s.stage))
  const activeIndex = RAIL.findIndex((r) => r.key === state.current)
  const complete = seen.has('complete')

  const final = state.stages.find((s) => s.stage === 'complete')
  const executeStage = [...state.stages].reverse().find((s) => s.stage === 'execute')
  const conceptStage = state.stages.find(
    (s) => s.stage === 'concepts' && s.detail.concepts?.length,
  )
  const vocabStage = state.stages.find((s) => s.stage === 'vocabulary' && s.detail.tags)

  return (
    <div className="console" ref={ref}>
      <div className="console-head">
        <span className="label">Semantic pipeline</span>
        <span className="model mono">{state.model}</span>
        {state.running && <span className="spinner" />}
        {complete && <span className="chip on">done</span>}
      </div>

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
        <div style={{ marginBottom: 'var(--gap-3)' }}>
          <span className="label">Concepts</span>
          <div className="row wrap gap-1" style={{ marginTop: 'var(--gap-1)' }}>
            {conceptStage.detail.concepts.map((c) => (
              <span key={c} className="chip">
                {c}
              </span>
            ))}
          </div>
        </div>
      )}

      {vocabStage?.detail.tags && (
        <div style={{ marginBottom: 'var(--gap-3)' }}>
          <span className="label">
            Oracle tags retrieved — a closed vocabulary the model must choose from
          </span>
          <div className="row wrap gap-1" style={{ marginTop: 'var(--gap-1)' }}>
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
        <div style={{ marginBottom: 'var(--gap-3)' }}>
          <span className="label">
            Query plans — results are unioned, so breadth raises recall
          </span>
          <div className="stack gap-1" style={{ marginTop: 'var(--gap-1)' }}>
            {executeStage.detail.plans.map((plan, i) => (
              <div className="plan-card" key={i}>
                <span className="n">{String(plan.matched).padStart(4, ' ')} ✳</span>{' '}
                {plan.rationale}
                {plan.error && <span style={{ color: 'var(--warn)' }}> — {plan.error}</span>}
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="console-log mono" ref={logRef}>
        {state.stages.map((stage, i) => (
          <div
            className={`line ${stage.detail.warnings?.length ? 'warn' : ''}`}
            key={`${stage.stage}-${i}`}
          >
            <span className="t">{stage.stage.padEnd(11, ' ')}</span>
            <span>{stage.message}</span>
          </div>
        ))}
        {state.error && (
          <div className="line" style={{ color: 'var(--bad)' }}>
            <span className="t">error</span>
            <span>{state.error}</span>
          </div>
        )}
      </div>

      {final?.detail.guard && <Guard guard={final.detail.guard} />}

      {final?.detail.analysis && <div className="analysis">{final.detail.analysis}</div>}

      {final && (
        <div className="row wrap gap-2" style={{ marginTop: 'var(--gap-3)' }}>
          <span className="chip">
            {final.detail.candidate_count ?? 0} candidates examined
          </span>
          <span className="chip">{final.detail.cards?.length ?? 0} selected</span>
        </div>
      )}
    </div>
  )
}
