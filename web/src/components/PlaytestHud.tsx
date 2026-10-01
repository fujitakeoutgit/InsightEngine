/**
 * What the rules put on the table: the turn and its steps, the mana pool, the
 * stack, the things left for you to do by hand, and the choices the game is
 * waiting on. Display only — every press is handed back up as an intent, and
 * `Playtest` turns it into an action.
 */

import { useEffect, useMemo, useRef, useState } from 'react'

import type { DeckReport } from '../game/compiler/report'
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
  { label: 'Combat', step: 'combatBegin', covers: ['combatBegin', 'combatAttackers', 'combatDamage', 'combatEnd'] },
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
  turn, step, rules, pool, landsPlayed, landDrops, opponent, poison, waiting, coverage, onCoverage,
  onPassTo, onRules, onOpponent,
}: {
  /** How much of the deck plays itself, for the button that opens the list. */
  coverage: DeckReport
  onCoverage: () => void
  turn: number
  step: Step
  rules: boolean
  pool: ManaPool
  landsPlayed: number
  /** How many lands may be played this turn. */
  landDrops: number
  /** The opponent's life, and their poison counters. */
  opponent: number
  poison: number
  /** Move the opponent's life by hand. */
  onOpponent: (by: number) => void
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
            className={`pt-phase-land${landsPlayed >= landDrops ? ' used' : ''}`}
            title={landsPlayed >= landDrops ? 'You have played your land this turn' : 'You may play a land this turn'}
          >
            Land {landsPlayed}/{landDrops}
          </span>
          {/* Theirs. A click takes one off, Shift+click puts one back: it is
              mostly damage you are counting. */}
          <button
            className="pt-opponent"
            onClick={(event) => onOpponent(event.shiftKey ? 1 : -1)}
            title="The opponent's life. Click to take one off, Shift+click to add one."
          >
            Opp <span className="mono">{opponent}</span>
            {poison > 0 && <span className="mono pt-poison" title="Poison counters: ten loses the game"> ☠{poison}</span>}
          </button>
        </>
      )}
      {rules && coverage.total > 0 && (
        <button
          className="pt-rules pt-cover"
          onClick={onCoverage}
          title={`${coverage.auto} of ${coverage.total} cards play themselves — click for the rest`}
        >
          <CoverageMeter report={coverage} />
          <span className="mono">{Math.round((coverage.auto / coverage.total) * 100)}%</span>
        </button>
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

/** The deck in three parts: plays itself, partly, by hand. */
function CoverageMeter({ report }: { report: DeckReport }) {
  return (
    <span className="pt-cover-meter" aria-hidden>
      {(['auto', 'partial', 'manual'] as const).map((grade) => (
        report[grade] > 0 && <span key={grade} className={grade} style={{ flexGrow: report[grade] }} />
      ))}
    </span>
  )
}

/**
 * What the engine does with this deck, card by card: the ones it leaves to
 * you, with the words it could not carry out, and the ways of casting a card
 * it does not offer.
 */
export function CoverageDialog({ report, onClose }: { report: DeckReport; onClose: () => void }) {
  useEffect(() => {
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', escape)
    return () => window.removeEventListener('keydown', escape)
  }, [onClose])
  const manual = report.cards.filter((c) => c.coverage === 'manual')
  const partial = report.cards.filter((c) => c.coverage === 'partial')
  const skipped = report.cards.filter((c) => c.skipped.length > 0)
  const groups: [string, string, typeof manual, 'left' | 'skipped'][] = [
    ['By hand', 'Nothing of these is carried out. Their text is posted for you when they are played.', manual, 'left'],
    ['Partly', 'What is understood happens; these lines are posted for you to finish.', partial, 'left'],
    ['Not offered', 'These cards play as printed. The other ways to cast or use them are not available here.', skipped, 'skipped'],
  ]
  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <div
        className="modal pt-cover-report"
        role="dialog"
        aria-modal
        aria-label="What plays itself"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="pt-cover-head">
          <h3>What plays itself</h3>
          <button className="btn btn-ghost sm" onClick={onClose} aria-label="Close">Close</button>
        </header>
        <CoverageMeter report={report} />
        <ul className="pt-cover-legend">
          <li className="auto"><span className="mono">{report.auto}</span> play themselves</li>
          <li className="partial"><span className="mono">{report.partial}</span> partly</li>
          <li className="manual"><span className="mono">{report.manual}</span> by hand</li>
        </ul>
        <div className="pt-cover-list">
          {groups.map(([title, blurb, cards, show]) => cards.length > 0 && (
            <section key={title}>
              <h4 className="label">{title} <span className="mono">{cards.length}</span></h4>
              <p className="faint">{blurb}</p>
              {cards.map((c) => (
                <article key={c.name} className="pt-cover-card">
                  <strong>{c.name}</strong>
                  {c[show].map((line) => <p key={line}>{line}</p>)}
                </article>
              ))}
            </section>
          ))}
          {!manual.length && !partial.length && !skipped.length && (
            <p className="faint">Every card in this deck plays itself.</p>
          )}
        </div>
      </div>
    </div>
  )
}

export interface StackEntry {
  id: string
  name: string
  image: string | null
  x: number
  /** The words of a triggered ability; null for a spell. */
  ability: string | null
}

/** The stack, top first, and the one button that resolves it. */
export function StackPanel({ items, onResolve }: { items: StackEntry[]; onResolve: () => void }) {
  if (!items.length) return null
  return (
    <section className="pt-stack" aria-label="The stack">
      <header className="label">Stack</header>
      <ol>
        {[...items].reverse().map((item, i) => (
          <li key={item.id} className={i === 0 ? 'top' : undefined} title={item.ability ?? item.name}>
            {item.image ? <img src={item.image} alt="" draggable={false} /> : <span className="pt-stack-blank" />}
            <span className="nm">
              {item.name}
              {item.x ? <span className="mono faint"> X={item.x}</span> : null}
              {item.ability && <span className="pt-stack-ability">{item.ability}</span>}
            </span>
          </li>
        ))}
      </ol>
      <button className="btn btn-primary sm" onClick={onResolve} title="Pass priority: the opponent passes too, and the top resolves (Space)">
        Resolve
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

/** The choice the game is waiting on. Centered on the mat — except a pick
 *  from the board or the hand, which sits low, out of the way of the cards
 *  it is asking about. Searches and scrying have dialogs of their own. */
export function DecisionPrompt({
  decision, chosen, damage = 0, spent = 0, name = '', firstDraw = false, onFirstDraw,
  onKeep, onMulligan, onConfirm, onAnswer, onMode, onType, onAll,
}: {
  decision: Decision
  /** What the cards picked so far add up to, where the pick has a limit. */
  spent?: number
  /** Whether turn 1 draws a card, and the switch for it on the opening
   *  hand. */
  firstDraw?: boolean
  onFirstDraw?: (on: boolean) => void
  /** The permanent a choice of creature type is for. */
  name?: string
  onType: (subtype: string) => void
  /** How many cards are picked so far. */
  chosen: number
  /** What the attackers picked so far would deal. */
  damage?: number
  /** Pick everything that can be picked — attack with the lot. */
  onAll?: () => void
  onKeep: () => void
  onMulligan: () => void
  onConfirm: () => void
  /** Yes or no, to a "you may". */
  onAnswer: (yes: boolean) => void
  onMode: (index: number) => void
}) {
  if (decision.kind === 'confirm') {
    return (
      <div className="pt-decision" role="dialog" aria-label="You may">
        <p className="pt-decision-text">{decision.prompt}</p>
        <div className="row gap-2">
          <button className="btn btn-primary sm" onClick={() => onAnswer(true)}>Yes</button>
          <button className="btn btn-ghost sm" onClick={() => onAnswer(false)}>No</button>
        </div>
      </div>
    )
  }
  if (decision.kind === 'mode') {
    return (
      <div className="pt-decision" role="dialog" aria-label="Choose">
        <h3>{decision.prompt}</h3>
        <div className="pt-modes">
          {decision.modes.map((mode, i) => {
            const taken = decision.taken.includes(i)
            return (
              <button
                key={mode}
                className={taken ? 'btn btn-primary sm' : 'btn btn-ghost sm'}
                onClick={() => onMode(i)}
                disabled={taken}
                aria-pressed={taken}
              >
                {mode}
              </button>
            )
          })}
        </div>
        {decision.canStop && (
          <button className="btn btn-ghost sm" onClick={() => onMode(-1)}>
            {decision.taken.length ? 'Done' : 'None'}
          </button>
        )}
      </div>
    )
  }
  if (decision.kind === 'type') {
    return (
      <div className="pt-decision" role="dialog" aria-label="Choose a creature type">
        <h3>{name ? `${name}: choose a creature type` : 'Choose a creature type'}</h3>
        <div className="pt-modes pt-types">
          {decision.options.map((subtype) => (
            <button key={subtype} className="btn btn-ghost sm" onClick={() => onType(subtype)}>{subtype}</button>
          ))}
        </div>
      </div>
    )
  }
  if (decision.kind === 'pick') {
    // A search or a return from the graveyard has a dialog of its own.
    if (decision.zone === 'library' || decision.zone === 'graveyard') return null
    return (
      <div className="pt-decision low" role="dialog" aria-label="Choose">
        <p className="pt-decision-text">{decision.prompt}</p>
        <div className="row gap-2">
          {decision.budget ? (
            <span className={`mono ${spent > decision.budget.max ? 'pt-over' : 'faint'}`}>
              total {decision.budget.of} {spent} of {decision.budget.max}
            </span>
          ) : (
            <span className="mono faint">{chosen} of {decision.max}</span>
          )}
          <button
            className="btn btn-primary sm"
            onClick={onConfirm}
            disabled={chosen < decision.min || chosen > decision.max || (decision.budget ? spent > decision.budget.max : false)}
          >
            {chosen === 0 && decision.min === 0 ? 'None' : 'Choose'}
          </button>
        </div>
      </div>
    )
  }
  // Scrying, ordering triggers and choosing a number have panels of their
  // own.
  if (decision.kind === 'arrange' || decision.kind === 'order' || decision.kind === 'number') return null
  if (decision.kind === 'attack') {
    return (
      <div className="pt-decision low" role="dialog" aria-label="Declare attackers">
        <p className="pt-decision-text">
          Declare attackers — click the creatures that attack.
          {chosen > 0 && <> <strong>{chosen}</strong> attacking for <strong>{damage}</strong>.</>}
        </p>
        <div className="row gap-2">
          {onAll && chosen < decision.options.length && (
            <button className="btn btn-ghost sm" onClick={onAll}>All</button>
          )}
          <button className="btn btn-primary sm" onClick={onConfirm}>
            {chosen ? 'Attack' : 'No attack'}
          </button>
        </div>
      </div>
    )
  }
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
        {onFirstDraw && (
          <button
            className={`pt-rules pt-first-draw${firstDraw ? ' on' : ''}`}
            onClick={() => onFirstDraw(!firstDraw)}
            aria-pressed={firstDraw}
            title="In a multiplayer game everyone draws on their first turn; the player who goes first in a two-player game does not."
          >
            <span className="pt-rules-dot" aria-hidden />
            Draw on turn 1
          </button>
        )}
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

/** "Choose a number between 0 and 10." */
export function NumberPrompt({
  prompt, min, max, onChoose,
}: { prompt: string; min: number; max: number; onChoose: (value: number) => void }) {
  const [value, setValue] = useState(min)
  return (
    <div className="pt-decision" role="dialog" aria-label="Choose a number">
      <h3>{prompt}</h3>
      <p className="faint">Between {min} and {max}.</p>
      <div className="row gap-2 pt-x">
        <button className="btn btn-ghost sm" onClick={() => setValue((v) => Math.max(min, v - 1))} disabled={value <= min} aria-label="Less">−</button>
        <span className="mono pt-x-value">{value}</span>
        <button className="btn btn-ghost sm" onClick={() => setValue((v) => Math.min(max, v + 1))} disabled={value >= max} aria-label="More">+</button>
      </div>
      <button className="btn btn-primary sm" onClick={() => onChoose(value)}>Choose</button>
    </div>
  )
}

/** One of several abilities that triggered together. */
export interface Triggered { id: string; name: string; text: string }

/**
 * Abilities that triggered together, in the order they will resolve. Click
 * one to have it resolve first; the rest keep their places behind it.
 */
export function OrderPrompt({ items, onOrder }: { items: Triggered[]; onOrder: (ids: string[]) => void }) {
  const [order, setOrder] = useState(() => items.map((item) => item.id))
  const byId = new Map(items.map((item) => [item.id, item]))
  return (
    <div className="pt-decision pt-order" role="dialog" aria-label="Order abilities">
      <h3>These triggered together</h3>
      <p className="faint">They resolve top to bottom. Click one to move it to the front.</p>
      <ol className="pt-order-list">
        {order.map((id, i) => (
          <li key={id}>
            <button
              className="btn btn-ghost sm"
              onClick={() => setOrder((now) => [id, ...now.filter((other) => other !== id)])}
              disabled={i === 0}
              title={i === 0 ? 'Resolves first' : 'Resolve this one first'}
            >
              <span className="mono pt-order-n">{i + 1}</span>
              <span>
                <strong>{byId.get(id)?.name}</strong>
                <span className="pt-order-text">{byId.get(id)?.text}</span>
              </span>
            </button>
          </li>
        ))}
      </ol>
      <button className="btn btn-primary sm" onClick={() => onOrder(order)}>Resolve in this order</button>
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

/** A card as a dialog shows it. */
export interface Offered {
  iid: string
  name: string
  cost: string | null
  type: string | null
  image: string | null
}

/**
 * Cards to take from somewhere you cannot see on the mat — your library, for
 * a search; your graveyard, for a return. Sorted by name, like Tutor, so the
 * library's real order is not something you read off the screen, and copies
 * of a card are one row with a count: thirteen Forests are one decision.
 */
export function PickDialog({
  prompt, cards, seen = [], min, max, budget, onChoose,
}: {
  prompt: string
  /** A limit on what the cards taken may add up to, and what each costs. */
  budget?: { max: number; cost: Record<string, number>; of: string }
  cards: Offered[]
  /** Cards looked at along with these that cannot be taken — the rest of
   *  the top five. Shown, so the choice is made knowing them. */
  seen?: Offered[]
  min: number
  max: number
  onChoose: (iids: string[]) => void
}) {
  /** The names taken, in the order they were — which matters when the first
   *  card found goes somewhere the second does not. */
  const [picks, setPicks] = useState<string[]>([])
  const groups = useMemo(() => {
    const byName = new Map<string, Offered[]>()
    for (const c of cards) byName.set(c.name, [...(byName.get(c.name) ?? []), c])
    return [...byName.values()].sort((a, b) => a[0].name.localeCompare(b[0].name))
  }, [cards])
  const total = picks.length
  const count = (name: string) => picks.filter((p) => p === name).length
  /** What the taken cards add up to, against the limit. Copies of a card
   *  cost the same, so the first of its row stands for each. */
  const spent = budget
    ? picks.reduce((sum, name) => sum + (budget.cost[groups.find((group) => group[0].name === name)?.[0].iid ?? ''] ?? 0), 0)
    : 0
  const over = Boolean(budget && spent > budget.max)

  const take = (name: string, available: number) => setPicks((now) => {
    const mine = now.filter((p) => p === name).length
    // One to pick: clicking another row moves the choice rather than
    // refusing it. Otherwise each click takes one more copy, and a click
    // past what there is, or what is allowed, puts them all back.
    if (max === 1) return mine ? [] : [name]
    return now.length >= max || mine >= available ? now.filter((p) => p !== name) : [...now, name]
  })

  const chosen = () => {
    const used = new Map<string, number>()
    return picks.map((name) => {
      const n = used.get(name) ?? 0
      used.set(name, n + 1)
      return groups.find((group) => group[0].name === name)![n].iid
    })
  }

  return (
    <div className="modal-backdrop" role="presentation">
      <div className="modal pt-tutor" role="dialog" aria-modal aria-label={prompt}>
        <h3>{prompt}</h3>
        <div className="pt-tutor-list">
          {groups.map((group) => {
            const [c] = group
            const mine = count(c.name)
            return (
              <button
                key={c.name}
                className={`pt-tutor-row${mine ? ' picked' : ''}`}
                onClick={() => take(c.name, group.length)}
                aria-pressed={mine > 0}
              >
                <span className="nm">
                  {c.name}
                  {group.length > 1 && <span className="mono faint"> ×{group.length}</span>}
                </span>
                <span className="mono faint">{budget ? `${budget.of} ${budget.cost[c.iid] ?? 0}` : c.cost ?? ''}</span>
                <span className="faint">{mine ? `taking ${mine}` : c.type}</span>
              </button>
            )
          })}
          {seen.map((c) => (
            <div key={c.iid} className="pt-tutor-row seen" aria-disabled>
              <span className="nm">{c.name}</span>
              <span className="mono faint">{c.cost ?? ''}</span>
              <span className="faint">{c.type}</span>
            </div>
          ))}
        </div>
        <div className="row gap-2" style={{ marginTop: 'var(--gap-2)' }}>
          <button
            className="btn btn-primary sm"
            onClick={() => onChoose(chosen())}
            disabled={total < min || over}
          >
            {total ? `Take ${total}` : 'Take nothing'}
          </button>
          {budget ? (
            <span className={over ? 'pt-over' : 'faint'} style={{ fontSize: 11 }}>
              total {budget.of} {spent} of {budget.max}
            </span>
          ) : (
            <span className="faint" style={{ fontSize: 11 }}>{total} of {max}</span>
          )}
        </div>
      </div>
    </div>
  )
}

/** Scry and surveil: the top cards, each kept or sent away. What is kept
 *  stays on top in the order shown. */
export function ArrangeDialog({
  mode, cards, onDone,
}: {
  mode: 'scry' | 'surveil'
  cards: Offered[]
  onDone: (keep: string[], away: string[]) => void
}) {
  const [away, setAway] = useState<string[]>([])
  const elsewhere = mode === 'scry' ? 'Bottom' : 'Graveyard'
  return (
    <div className="modal-backdrop" role="presentation">
      <div className="modal pt-arrange" role="dialog" aria-modal aria-label={mode}>
        <h3>{mode === 'scry' ? 'Scry' : 'Surveil'} {cards.length}</h3>
        <p className="faint">
          The top of your library, first card first. Click a card to send it to the {elsewhere.toLowerCase()}.
        </p>
        <div className="pt-arrange-cards">
          {cards.map((c) => {
            const gone = away.includes(c.iid)
            return (
              <button
                key={c.iid}
                className={`pt-arrange-card${gone ? ' away' : ''}`}
                onClick={() => setAway((now) => (gone ? now.filter((a) => a !== c.iid) : [...now, c.iid]))}
                aria-pressed={gone}
                title={c.name}
              >
                {c.image ? <img src={c.image} alt={c.name} draggable={false} /> : <span className="pt-fallback">{c.name}</span>}
                <span className="pt-arrange-where mono">{gone ? elsewhere : 'Top'}</span>
              </button>
            )
          })}
        </div>
        <button
          className="btn btn-primary sm"
          onClick={() => onDone(cards.filter((c) => !away.includes(c.iid)).map((c) => c.iid), away)}
        >
          Done
        </button>
      </div>
    </div>
  )
}

/** One ability, as the menu offers it. */
export interface Offer {
  index: number
  cost: string
  text: string
  /** Why it cannot be activated now; null when it can. */
  problem: string | null
}

/** A permanent's activated abilities: what each costs, what it does, and —
 *  for the ones that cannot be used right now — why not. */
export function AbilityMenu({
  name, offers, onActivate, onCancel,
}: {
  name: string
  offers: Offer[]
  onActivate: (index: number) => void
  onCancel: () => void
}) {
  useEffect(() => {
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') onCancel() }
    window.addEventListener('keydown', escape)
    return () => window.removeEventListener('keydown', escape)
  }, [onCancel])
  return (
    <div className="pt-decision pt-abilities" role="dialog" aria-label={`Abilities of ${name}`}>
      <h3>{name}</h3>
      <div className="pt-modes">
        {offers.map((offer) => (
          <button
            key={offer.index}
            className="btn btn-ghost sm"
            onClick={() => onActivate(offer.index)}
            disabled={Boolean(offer.problem)}
            title={offer.problem ?? 'Activate'}
          >
            <span className="mono pt-ability-cost">{offer.cost}</span>
            <span>{offer.text}</span>
            {offer.problem && <span className="pt-ability-problem">{offer.problem}</span>}
          </button>
        ))}
      </div>
      <button className="btn btn-ghost sm" onClick={onCancel}>Cancel</button>
    </div>
  )
}
