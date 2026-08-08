import { useRef } from 'react'

import { canAnimate, gsap } from '../lib/motion'

/**
 * The d20.
 *
 * Numerals rather than pips, because twenty of anything is not countable at a
 * glance — and drawn as the icosahedron silhouette so it is recognisable as
 * the twenty before you read the number on it. Fixed in the tool column
 * rather than thrown: a d20 is rolled for an answer, not scattered across the
 * board the way a fistful of d6s is.
 *
 * The tumble hides the number changing, in the same way the coin's spin does.
 */
export function PlayD20({
  value, onRoll,
}: {
  value: number
  onRoll: (next: number) => void
}) {
  const ref = useRef<HTMLButtonElement>(null)
  const spin = useRef(0)
  const tl = useRef<gsap.core.Timeline | null>(null)

  const roll = () => {
    const next = 1 + Math.floor(Math.random() * 20)
    const el = ref.current
    if (!el || !canAnimate()) { onRoll(next); return }

    spin.current += 720
    tl.current?.kill()
    const flight = gsap.timeline()
    tl.current = flight

    flight
      .to(el, { y: -34, scale: 1.14, duration: 0.26, ease: 'power2.out' })
      .to(el, { y: 0, scale: 1, duration: 0.3, ease: 'power2.in' })
      .to(el, { y: -7, duration: 0.11, ease: 'power2.out' })
      .to(el, { y: 0, duration: 0.13, ease: 'power2.in' })

    flight.to(el, { rotate: spin.current, duration: 0.7, ease: 'power2.out' }, 0)
    // Committed at the apex, under the fastest part of the spin.
    flight.call(() => onRoll(next), [], 0.26)
  }

  return (
    <button
      ref={ref}
      className="pt-d20"
      onClick={roll}
      title={`d20 showing ${value} — click to roll`}
      aria-label={`d20 showing ${value}`}
      aria-live="polite"
    >
      <svg viewBox="0 0 100 100" aria-hidden>
        {/* Hexagonal outline with the upward face inside it: the projection of
            an icosahedron, and the shape everyone reads as "d20". */}
        <polygon className="body" points="50,3 91,26 91,74 50,97 9,74 9,26" />
        <polygon className="face" points="50,27 77,73 23,73" />
      </svg>
      <span className="pt-d20-value mono">{value}</span>
    </button>
  )
}
