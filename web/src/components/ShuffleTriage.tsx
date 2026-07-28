import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import type { Card } from '../lib/api'
import { canAnimate, gsap } from '../lib/motion'

/** How far a card must travel before releasing it counts as a decision. */
const COMMIT_PX = 110
/** How many cards are drawn behind the active one. */
const DEPTH = 3

type Verdict = 'yes' | 'no'

/**
 * Triage a result set one card at a time.
 *
 * A long result list is hard to act on: you scan it, mean to come back to six
 * cards, and remember two. This deals the results as a stack and asks a single
 * question about the card in front of you. Right keeps it, left discards it,
 * and nothing is committed until you submit -- a card sent to either pile can
 * be pulled back by clicking that pile.
 *
 * Deliberately modal and deliberately dark: it is a mode you are *in*, and the
 * results underneath would only invite you to go back to scanning them.
 */
export function ShuffleTriage({
  cards, onClose, onSubmit, keepLabel = "Keep", dropLabel = "Discard",
}: {
  cards: Card[]
  onClose: () => void
  /** Right-hand pile first, then left. */
  onSubmit: (kept: Card[], dropped: Card[]) => void
  keepLabel?: string
  dropLabel?: string
}) {
  const [pending, setPending] = useState<Card[]>(cards)
  const [yes, setYes] = useState<Card[]>([])
  const [no, setNo] = useState<Card[]>([])
  const [busy, setBusy] = useState(false)

  const cardRef = useRef<HTMLDivElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  /** Live pointer drag on the top card. */
  const drag = useRef<{ id: number; startX: number; startY: number } | null>(null)

  const active = pending[0] ?? null
  const done = pending.length === 0

  /* --- deciding ---------------------------------------------------------- */

  const decide = useCallback((verdict: Verdict) => {
    const card = pending[0]
    if (!card || busy) return
    const el = cardRef.current

    const commit = () => {
      setPending((p) => p.slice(1))
      if (verdict === 'yes') setYes((y) => [card, ...y])
      else setNo((n) => [card, ...n])
      setBusy(false)
      // The next card inherits the element, so its transform must be cleared
      // or it would appear already flung aside.
      if (el) gsap.set(el, { x: 0, y: 0, rotate: 0, opacity: 1 })
    }

    if (!canAnimate() || !el) { commit(); return }
    setBusy(true)
    gsap.to(el, {
      x: verdict === 'yes' ? 620 : -620,
      y: -40,
      rotate: verdict === 'yes' ? 22 : -22,
      opacity: 0,
      duration: 0.34,
      ease: 'power2.in',
      onComplete: commit,
    })
  }, [pending, busy])

  /** Take the most recent card back out of a pile and make it active again. */
  const undoPile = (verdict: Verdict) => {
    if (busy) return
    const pile = verdict === 'yes' ? yes : no
    const card = pile[0]
    if (!card) return
    if (verdict === 'yes') setYes((y) => y.slice(1))
    else setNo((n) => n.slice(1))
    setPending((p) => [card, ...p])

    // Fly it back in from the side it left on.
    const el = cardRef.current
    if (el && canAnimate()) {
      gsap.fromTo(el,
        { x: verdict === 'yes' ? 620 : -620, y: -40, rotate: verdict === 'yes' ? 22 : -22, opacity: 0 },
        { x: 0, y: 0, rotate: 0, opacity: 1, duration: 0.4, ease: 'power3.out' })
    }
  }

  /* --- pointer dragging -------------------------------------------------- */

  const onPointerDown = (event: React.PointerEvent) => {
    if (busy || !active) return
    drag.current = { id: event.pointerId, startX: event.clientX, startY: event.clientY }
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const onPointerMove = (event: React.PointerEvent) => {
    const held = drag.current
    if (!held || held.id !== event.pointerId || !cardRef.current) return
    const dx = event.clientX - held.startX
    const dy = event.clientY - held.startY
    // Rotation tied to travel, so the card leans the way it is going.
    gsap.set(cardRef.current, { x: dx, y: dy, rotate: dx / 22 })
  }

  const endDrag = (event: React.PointerEvent) => {
    const held = drag.current
    if (!held || held.id !== event.pointerId) return
    drag.current = null
    const dx = event.clientX - held.startX
    if (Math.abs(dx) >= COMMIT_PX) {
      decide(dx > 0 ? 'yes' : 'no')
      return
    }
    // Not far enough: spring back.
    if (cardRef.current && canAnimate()) {
      gsap.to(cardRef.current, { x: 0, y: 0, rotate: 0, duration: 0.34, ease: 'back.out(2)' })
    } else if (cardRef.current) {
      gsap.set(cardRef.current, { x: 0, y: 0, rotate: 0 })
    }
  }

  /* --- keyboard ---------------------------------------------------------- */

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'ArrowRight') { event.preventDefault(); decide('yes') }
      else if (event.key === 'ArrowLeft') { event.preventDefault(); decide('no') }
      else if (event.key === 'Escape') { event.preventDefault(); onClose() }
    }
    window.addEventListener('keydown', onKey)
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = previous
    }
  }, [decide, onClose])

  /* --- entrance ---------------------------------------------------------- */

  useEffect(() => {
    if (!rootRef.current || !canAnimate()) return
    gsap.fromTo(rootRef.current, { opacity: 0 }, { opacity: 1, duration: 0.3, ease: 'power2.out' })
    const stack = rootRef.current.querySelectorAll('.shuffle-card')
    gsap.fromTo(stack,
      { y: 60, opacity: 0, scale: 0.9 },
      { y: 0, opacity: 1, scale: 1, duration: 0.5, ease: 'power3.out', stagger: 0.05 })
  }, [])

  const submit = () => {
    const finish = () => onSubmit(yes, no)
    if (!rootRef.current || !canAnimate()) { finish(); return }
    gsap.to(rootRef.current, { opacity: 0, duration: 0.28, ease: 'power2.in', onComplete: finish })
  }

  return createPortal(
    <div className="shuffle" ref={rootRef} role="dialog" aria-modal="true" aria-label="Triage results">
      <div className="shuffle-head">
        <button className="back-link" onClick={onClose}>← Cancel</button>
        <span className="mono faint">
          {pending.length} left · {yes.length} kept · {no.length} discarded
        </span>
      </div>

      <div className="shuffle-stage">
        <Pile
          side="no" label={dropLabel} cards={no} onUndo={() => undoPile("no")}
        />

        <div className="shuffle-stack">
          {done ? (
            <p className="shuffle-empty">
              Every card decided. Submit to {keepLabel.toLowerCase()} {yes.length} and {dropLabel.toLowerCase()} {no.length}.
            </p>
          ) : (
            // Reverse order so the active card is painted last, on top.
            pending.slice(0, DEPTH).map((card, i) => (
              <div
                key={card.oracle_id}
                ref={i === 0 ? cardRef : undefined}
                className={`shuffle-card ${i === 0 ? 'active' : ''}`}
                style={{
                  zIndex: DEPTH - i,
                  // The ones behind peek out, so the stack reads as a stack.
                  transform: i === 0 ? undefined : `translateY(${i * 10}px) scale(${1 - i * 0.04})`,
                  opacity: i === 0 ? 1 : 0.55,
                }}
                onPointerDown={i === 0 ? onPointerDown : undefined}
                onPointerMove={i === 0 ? onPointerMove : undefined}
                onPointerUp={i === 0 ? endDrag : undefined}
                onPointerCancel={i === 0 ? endDrag : undefined}
              >
                {card.image_normal ?? card.image_small ? (
                  <img src={(card.image_normal ?? card.image_small)!} alt={card.name} draggable={false} />
                ) : (
                  <div className="shuffle-fallback">{card.name}</div>
                )}
              </div>
            ))
          )}
        </div>

        <Pile
          side="yes" label={keepLabel} cards={yes} onUndo={() => undoPile("yes")}
        />
      </div>

      <div className="shuffle-foot">
        <span className="faint">Drag, or use ← and →. Click a pile to take the last one back.</span>
        <button className="btn btn-primary" onClick={submit} disabled={!yes.length && !no.length}>
          Submit — {keepLabel.toLowerCase()} {yes.length}, {dropLabel.toLowerCase()} {no.length}
        </button>
      </div>
    </div>,
    document.body,
  )
}

function Pile({
  side, label, cards, onUndo,
}: {
  side: Verdict
  label: string
  cards: Card[]
  onUndo: () => void
}) {
  const top = cards[0]
  return (
    <div className={`shuffle-pile ${side}`}>
      <span className="label">{label} · {cards.length}</span>
      <button
        className="shuffle-pile-top"
        onClick={onUndo}
        disabled={!top}
        title={top ? `Put ${top.name} back` : 'Nothing here yet'}
      >
        {top && (top.image_normal ?? top.image_small) ? (
          <img src={(top.image_normal ?? top.image_small)!} alt={top.name} />
        ) : (
          <span className="faint">{side === "yes" ? "→" : "←"}</span>
        )}
      </button>
    </div>
  )
}
