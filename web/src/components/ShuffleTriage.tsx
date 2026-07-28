import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import type { Card } from '../lib/api'
import { canAnimate, gsap } from '../lib/motion'

/** How far a card must travel before releasing it counts as a decision. */
const COMMIT_PX = 110
/** Cards deeper than this in the stack are parked; drawing 600 is pointless. */
const VISIBLE_DEPTH = 14

type Verdict = 'yes' | 'no'

/** Deterministic 0..1 from a string. Jitter has to be stable per card: rolling
 *  it per render is what makes a stack visibly twitch. */
function hash(text: string, salt: number): number {
  let h = 2166136261 ^ salt
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return ((h >>> 0) % 10000) / 10000
}

/**
 * Triage a result set one card at a time.
 *
 * A long result list is hard to act on: you scan it, mean to come back to six
 * cards, and remember two. This deals the results as a stack and asks a single
 * question about the card in front of you. Right keeps it, left discards it,
 * and nothing is committed until you submit -- a card sent to either pile can
 * be pulled back by clicking that pile.
 *
 * Every card is mounted once and never reordered. The transform is the only
 * thing that changes, driven by where the card currently belongs. The previous
 * version re-rendered a three-card window, so React recycled DOM nodes as the
 * array shifted and a half-finished tween carried onto whichever card landed
 * in that slot -- which is what the judder was.
 */
export function ShuffleTriage({
  cards, onClose, onSubmit, keepLabel = 'Keep', dropLabel = 'Discard',
}: {
  cards: Card[]
  onClose: () => void
  /** Right-hand pile first, then left. */
  onSubmit: (kept: Card[], dropped: Card[]) => void
  keepLabel?: string
  dropLabel?: string
}) {
  /** Fixed for the lifetime of the mode: index i is always the same card. */
  const order = useMemo(() => cards, [cards])
  const [verdicts, setVerdicts] = useState<(Verdict | null)[]>(
    () => order.map(() => null),
  )

  const rootRef = useRef<HTMLDivElement>(null)
  const nodes = useRef<(HTMLDivElement | null)[]>([])
  const drag = useRef<{ id: number; startX: number; startY: number; index: number } | null>(null)
  const animating = useRef(false)

  /** The card being asked about: the first without a verdict. */
  const cursor = verdicts.findIndex((v) => v === null)
  const done = cursor === -1
  const yesCount = verdicts.filter((v) => v === 'yes').length
  const noCount = verdicts.filter((v) => v === 'no').length

  /* --- where each card belongs ------------------------------------------- */

  /** Stack jitter is small -- a tidy pile someone squared up. Pile jitter is
   *  large, because those were thrown. Both are seeded from the card. */
  const place = useCallback((index: number) => {
    const card = order[index]
    const verdict = verdicts[index]
    const jr = (salt: number) => hash(card.oracle_id, salt) - 0.5

    if (verdict) {
      const side = verdict === 'yes' ? 1 : -1
      return {
        x: side * (window.innerWidth * 0.34) + jr(1) * 46,
        y: jr(2) * 54,
        rotation: side * 6 + jr(3) * 34,
        scale: 1,
        opacity: 1,
        zIndex: 10 + index,
      }
    }

    const depth = index - cursor
    if (depth > VISIBLE_DEPTH) {
      return { x: 0, y: 0, rotation: 0, scale: 1, opacity: 0, zIndex: 1 }
    }
    // Squared up, not scattered. The card you are deciding about is the whole
    // point of this view, and jitter under it only made the edges shimmer.
    // The piles keep theirs -- those were thrown, this one is presented.
    return {
      x: 0,
      y: depth * 2.5,
      rotation: 0,
      // Every card the same size: a scale ramp makes the stack read as
      // perspective, and the ask was a squared-up pile, not a funnel.
      scale: 1,
      opacity: 1,
      zIndex: 1000 - depth,
    }
  }, [order, verdicts, cursor])

  /** Move every card to where it now belongs. Tweened, so a decision reads as
   *  the card travelling rather than teleporting. */
  const settle = useCallback((animate: boolean) => {
    order.forEach((_, index) => {
      const el = nodes.current[index]
      if (!el) return
      const target = place(index)
      if (!animate || !canAnimate()) {
        gsap.set(el, target)
        return
      }
      gsap.to(el, {
        ...target,
        duration: 0.42,
        ease: 'power3.out',
        overwrite: 'auto',
      })
    })
  }, [order, place])

  // Position on mount without animating, then animate every later change.
  const mounted = useRef(false)
  useLayoutEffect(() => {
    settle(mounted.current)
    mounted.current = true
  }, [settle])

  /* --- deciding ---------------------------------------------------------- */

  const decide = useCallback((verdict: Verdict) => {
    if (done || animating.current) return
    setVerdicts((v) => v.map((x, i) => (i === cursor ? verdict : x)))
  }, [cursor, done])

  const undoPile = (verdict: Verdict) => {
    // The most recently decided card on that side is the one to take back.
    for (let i = verdicts.length - 1; i >= 0; i--) {
      if (verdicts[i] === verdict) {
        setVerdicts((v) => v.map((x, j) => (j === i ? null : x)))
        return
      }
    }
  }

  /* --- dragging ---------------------------------------------------------- */

  const onPointerDown = (event: React.PointerEvent, index: number) => {
    if (index !== cursor || animating.current) return
    drag.current = {
      id: event.pointerId, startX: event.clientX, startY: event.clientY, index,
    }
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const onPointerMove = (event: React.PointerEvent) => {
    const held = drag.current
    if (!held || held.id !== event.pointerId) return
    const el = nodes.current[held.index]
    if (!el) return
    const dx = event.clientX - held.startX
    const dy = event.clientY - held.startY
    const base = place(held.index)
    // set, not to: this follows the pointer and must not be tweened.
    gsap.set(el, {
      x: base.x + dx,
      y: base.y + dy,
      rotation: base.rotation + dx / 24,
    })
  }

  const endDrag = (event: React.PointerEvent) => {
    const held = drag.current
    if (!held || held.id !== event.pointerId) return
    drag.current = null
    const dx = event.clientX - held.startX
    if (Math.abs(dx) >= COMMIT_PX) decide(dx > 0 ? 'yes' : 'no')
    else settle(true)  // not far enough: springs back to its place in the stack
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

  useEffect(() => {
    if (!rootRef.current || !canAnimate()) return
    gsap.fromTo(rootRef.current, { opacity: 0 }, { opacity: 1, duration: 0.3, ease: 'power2.out' })
  }, [])

  const submit = () => {
    const kept = order.filter((_, i) => verdicts[i] === 'yes')
    const dropped = order.filter((_, i) => verdicts[i] === 'no')
    const finish = () => onSubmit(kept, dropped)
    if (!rootRef.current || !canAnimate()) { finish(); return }
    gsap.to(rootRef.current, { opacity: 0, duration: 0.28, ease: 'power2.in', onComplete: finish })
  }

  return createPortal(
    <div className="shuffle" ref={rootRef} role="dialog" aria-modal="true" aria-label="Triage results">
      <div className="shuffle-head">
        <span className="mono faint">
          {order.length - yesCount - noCount} left · {yesCount} {keepLabel.toLowerCase()} ·{' '}
          {noCount} {dropLabel.toLowerCase()}
        </span>
      </div>

      <div className="shuffle-stage">
        <button
          className="shuffle-pile-label no"
          onClick={() => undoPile('no')}
          disabled={!noCount}
          title={noCount ? 'Take the last one back' : 'Nothing here yet'}
        >
          {dropLabel} · {noCount}
        </button>

        {/* One layer, every card in it. Piles are positions, not containers,
            so a card moves between them by tweening rather than by being
            unmounted and rebuilt somewhere else. */}
        <div className="shuffle-layer">
          {order.map((card, index) => (
            <div
              key={card.oracle_id}
              ref={(el) => { nodes.current[index] = el }}
              className={`shuffle-card ${index === cursor ? 'active' : ''}`}
              onPointerDown={(e) => onPointerDown(e, index)}
              onPointerMove={onPointerMove}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
            >
              {card.image_normal ?? card.image_small ? (
                <img
                  src={(card.image_normal ?? card.image_small)!}
                  alt={card.name}
                  draggable={false}
                />
              ) : (
                <div className="shuffle-fallback">{card.name}</div>
              )}
            </div>
          ))}

          {done && (
            <p className="shuffle-empty">
              Every card decided. Submit to {keepLabel.toLowerCase()} {yesCount} and{' '}
              {dropLabel.toLowerCase()} {noCount}.
            </p>
          )}
        </div>

        <button
          className="shuffle-pile-label yes"
          onClick={() => undoPile('yes')}
          disabled={!yesCount}
          title={yesCount ? 'Take the last one back' : 'Nothing here yet'}
        >
          {keepLabel} · {yesCount}
        </button>
      </div>

      {/* Centred under the stack, because that is where you are looking. */}
      <div className="shuffle-foot">
        <button className="btn btn-primary" onClick={submit} disabled={!yesCount && !noCount}>
          Submit — {keepLabel.toLowerCase()} {yesCount}, {dropLabel.toLowerCase()} {noCount}
        </button>
        <button className="btn btn-danger sm" onClick={onClose}>
          Cancel
        </button>
        <span className="faint">Drag, or use ← and →. Click a pile to take the last one back.</span>
      </div>
    </div>,
    document.body,
  )
}
