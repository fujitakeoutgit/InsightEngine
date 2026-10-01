/**
 * What the rules put on the table: the turn and its steps, the mana pool, the
 * stack, the things left for you to do by hand, and the choices the game is
 * waiting on. Display only — every press is handed back up as an intent, and
 * `Playtest` turns it into an action.
 */

import { useEffect, useRef, useState } from 'react'

import { MANA_TYPES, type ManaPool, type ManaType } from '../game/mana'
import type { Decision, Reminder, Step } from '../game/types'
import { ManaPip } from './ManaSprite'

/** The steps worth showing, and worth passing to. Nobody gets priority in
 *  untap or cleanup, so neither has a button: cleanup lights End, and untap
 *  lights nothing — the game only waits there before turn one, on the
 *  opening hand. */
const PHASES: { label: string; step: Step; covers: Step[] }[] = [
  { label: 'Upkeep', step: 'upkeep', covers: ['upkeep'] },
  { label: 'Draw', step: 'draw', covers: ['draw'] },
  { label: 'Main 1', step: 'main1', covers: ['main1'] },
  { label: 'Combat', step: 'combatBegin', covers: ['combatBegin', 'combatAttackers', 'combatEnd'] },
  { label: 'Main 2', step: 'main2', covers: ['main2'] },
  { label: 'End', step: 'end', covers: ['end', 'cleanup'] },
]

function Pool({ pool }: { pool: ManaPool }) {
  const floating = MANA_TYPES.filter((kind) => pool[kind] > 0)
  if (!floating.length) return null
  return (
    <span className="pt-pool" title="Mana in your pool. It empties as the step ends.">
      {floating.map((kind) => (
        <span key={kind} className="pt-pool-mana">
          <ManaPip code={kind} size={15} />
          {pool[kind] > 1 && <span className="mono">{pool[kind]}</span>}
        </span>
      ))}
    </span>
  )
}

export function PhaseBar({
  turn, step, rules, pool, landsPlayed, waiting, onPassTo, onRules,
}: {
  turn: number
  step: Step
  rules: boolean
  pool: ManaPool
  landsPlayed: number
  /** A choice is open, and nothing moves until it is made. */
  waiting: boolean
  onPassTo: (step: Step) => void
  onRules: (on: boolean) => void
}) {
  const now = PHASES.findIndex((p) => p.covers.includes(step))
  return (
    <div className="pt-phases" role="toolbar" aria-label="Turn">
      <span className="pt-phase-turn mono">Turn {turn}</span>
      {rules && (
        <>
          <span className="pt-phase-steps">
            {PHASES.map((phase, i) => (
              <button
                key={phase.step}
                className={`pt-phase${i === now ? ' now' : ''}`}
                onClick={() => onPassTo(phase.step)}
                disabled={i === now || waiting}
                aria-current={i === now ? 'step' : undefined}
                title={i === now
                  ? `${phase.label} — now`
                  : `Pass until ${phase.label}${i < now ? ' next turn' : ''}`}
              >
                {phase.label}
              </button>
            ))}
          </span>
          <Pool pool={pool} />
          <span
            className={`pt-phase-land${landsPlayed ? ' used' : ''}`}
            title={landsPlayed ? 'You have played your land this turn' : 'You may play a land this turn'}
          >
            Land {landsPlayed}/1
          </span>
        </>
      )}
      <button
        className={`pt-rules${rules ? ' on' : ''}`}
        onClick={() => onRules(!rules)}
        aria-pressed={rules}
        title={rules
          ? 'Rules on: turns, costs and the stack are enforced. Turn off for a free table.'
          : 'Rules off: nothing is checked. Turn on to play by the rules.'}
      >
        <span className="pt-rules-dot" aria-hidden />
        Rules
      </button>
    </div>
  )
}

export interface StackEntry {
  id: string
  name: string
  image: string | null
  x: number
}

/** The stack, top first, and the one button that resolves it. */
export function StackPanel({ items, onResolve }: { items: StackEntry[]; onResolve: () => void }) {
  if (!items.length) return null
  const top = items[items.length - 1]
  return (
    <section className="pt-stack" aria-label="The stack">
      <header className="label">Stack</header>
      <ol>
        {[...items].reverse().map((item, i) => (
          <li key={item.id} className={i === 0 ? 'top' : undefined}>
            {item.image ? <img src={item.image} alt="" draggable={false} /> : <span className="pt-stack-blank" />}
            <span className="nm">{item.name}{item.x ? <span className="mono faint"> X={item.x}</span> : null}</span>
          </li>
        ))}
      </ol>
      <button className="btn btn-primary sm" onClick={onResolve} title="Pass priority: the opponent passes too, and the top resolves (Space)">
        Resolve {top.name}
      </button>
    </section>
  )
}

/** What a spell or an arrival says to do, which the engine does not do for
 *  you yet. Stays until you say it is done. */
export function Reminders({ items, onDone }: { items: Reminder[]; onDone: (id: string) => void }) {
  if (!items.length) return null
  return (
    <section className="pt-reminders" aria-label="To do by hand">
      {items.map((item) => (
        <article key={item.id} className="pt-reminder">
          <header>
            <span className="label">By hand</span>
            <strong>{item.name}</strong>
          </header>
          <p>{item.text}</p>
          <button className="btn btn-ghost sm" onClick={() => onDone(item.id)}>Done</button>
        </article>
      ))}
    </section>
  )
}

/** The choice the game is waiting on, centered on the mat. */
export function DecisionPrompt({
  decision, chosen, onKeep, onMulligan, onConfirm,
}: {
  decision: Decision
  /** How many cards are picked so far, for bottom and discard. */
  chosen: number
  onKeep: () => void
  onMulligan: () => void
  onConfirm: () => void
}) {
  if (decision.kind === 'mulligan') {
    // What keeping costs now, and what one more mulligan would make it.
    const owed = Math.max(0, decision.taken - 1)
    const cards = (n: number) => `${n} card${n === 1 ? '' : 's'}`
    return (
      <div className="pt-decision" role="dialog" aria-label="Opening hand">
        <h3>{decision.taken ? `Mulligan ${decision.taken}` : 'Opening hand'}</h3>
        <p className="faint">
          {decision.taken === 0
            ? 'Keep these seven, or shuffle them away for seven more. Your first mulligan is free.'
            : owed === 0
              ? `That one was free — keeping costs nothing. Another, and you put ${cards(1)} on the bottom.`
              : `Keeping puts ${cards(owed)} on the bottom. Another mulligan makes it ${owed + 1}.`}
        </p>
        <div className="row gap-2">
          <button className="btn btn-primary sm" onClick={onKeep}>Keep</button>
          <button className="btn btn-ghost sm" onClick={onMulligan}>Mulligan</button>
        </div>
      </div>
    )
  }
  const verb = decision.kind === 'bottom' ? 'Put on the bottom' : 'Discard'
  return (
    <div className="pt-decision" role="dialog" aria-label={verb}>
      <h3>{decision.kind === 'bottom' ? 'Bottom of the library' : 'Discard to seven'}</h3>
      <p className="faint">
        Choose {decision.count} card{decision.count === 1 ? '' : 's'} in your hand — {chosen} of {decision.count}.
      </p>
      <button className="btn btn-primary sm" onClick={onConfirm} disabled={chosen !== decision.count}>
        {verb}
      </button>
    </div>
  )
}

/** X, chosen before the spell is cast — no more than you can pay for. */
export function XPrompt({
  name, max, onCast, onCancel,
}: { name: string; max: number; onCast: (x: number) => void; onCancel: () => void }) {
  const [x, setX] = useState(max)
  const castRef = useRef<HTMLButtonElement>(null)
  useEffect(() => { castRef.current?.focus() }, [])
  return (
    <div className="pt-decision" role="dialog" aria-label={`Choose X for ${name}`}>
      <h3>{name}</h3>
      <p className="faint">Choose X. You can pay for up to {max}.</p>
      <div className="row gap-2 pt-x">
        <button className="btn btn-ghost sm" onClick={() => setX((v) => Math.max(0, v - 1))} disabled={x <= 0} aria-label="Less">−</button>
        <span className="mono pt-x-value">X = {x}</span>
        <button className="btn btn-ghost sm" onClick={() => setX((v) => Math.min(max, v + 1))} disabled={x >= max} aria-label="More">+</button>
      </div>
      <div className="row gap-2">
        <button ref={castRef} className="btn btn-primary sm" onClick={() => onCast(x)}>Cast</button>
        <button className="btn btn-ghost sm" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  )
}

/** Which mana a source makes, when it could make more than one kind. Sits on
 *  the card that was clicked. A land that can also go looking for another —
 *  Myriad Landscape, Krosan Verge — offers that here too. */
export function ManaPicker({
  options, at, onPick, onSearch, onCancel,
}: {
  options: { ability: number; kinds: ManaType[] }[]
  at: { x: number; y: number }
  onPick: (option: { ability: number; kinds: ManaType[] }) => void
  onSearch?: () => void
  onCancel: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    // Anywhere else closes it — it is a question about one click.
    const away = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) onCancel()
    }
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') onCancel() }
    document.addEventListener('pointerdown', away, true)
    document.addEventListener('keydown', escape, true)
    return () => {
      document.removeEventListener('pointerdown', away, true)
      document.removeEventListener('keydown', escape, true)
    }
  }, [onCancel])
  return (
    <div
      ref={ref}
      className="pt-mana-picker"
      style={{ left: `${at.x * 100}%`, top: `${at.y * 100}%` }}
      role="menu"
      aria-label="Tap for which mana"
    >
      {options.map((option) => (
        <button
          key={`${option.ability}-${option.kinds.join('')}`}
          role="menuitem"
          onClick={() => onPick(option)}
          title={`Add ${option.kinds.map((k) => `{${k}}`).join('')}`}
        >
          {option.kinds.map((kind, i) => <ManaPip key={i} code={kind} size={20} />)}
        </button>
      ))}
      {onSearch && (
        <button role="menuitem" className="pt-mana-search" onClick={onSearch} title="Sacrifice it to search your library">
          Search
        </button>
      )}
    </div>
  )
}
