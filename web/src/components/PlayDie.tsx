import { useEffect, useRef, useState } from 'react'

import { canAnimate, gsap } from '../lib/motion'

/**
 * Pip positions in a 3x3 grid, indexed
 *
 *     0 1 2
 *     3 4 5
 *     6 7 8
 *
 * Dots rather than numerals because that is what a die has on it. A numeral
 * would read as a counter that happens to be square; the pips are what make it
 * obvious at a glance that throwing it is the point.
 */
const FACES: Record<number, number[]> = {
  1: [4],
  2: [0, 8],
  3: [0, 4, 8],
  4: [0, 2, 6, 8],
  5: [0, 2, 4, 6, 8],
  6: [0, 2, 3, 5, 6, 8],
}

/** Below this, a release is a click rather than a throw. px/ms. */
const THROW_SPEED = 0.25
/** How far a throw carries, per unit of release speed. */
const CARRY = 190
/** Kept inside this box so the die never leaves its corner. */
const REACH = 150

interface Sample { x: number; y: number; t: number }

const clamp = (value: number) => Math.max(-REACH, Math.min(REACH, value))
const anyFace = () => 1 + Math.floor(Math.random() * 6)

/**
 * The die.
 *
 * Two modes, because it does two jobs. Rolling is the obvious one: grab it and
 * throw, and it tumbles and settles on a face. Counting is the other -- a die
 * on a table is the nearest thing to hand for tracking storm, experience,
 * monarch turns -- and a double-click switches to it. Throwing it always puts
 * it back to rolling, so there is one gesture out of count mode and it is the
 * same gesture that got you interested in the die in the first place.
 */
export function PlayDie({ onRoll }: { onRoll?: (value: number, counting: boolean) => void }) {
  const [value, setValue] = useState(6)
  const [counting, setCounting] = useState(false)
  const [held, setHeld] = useState(false)
  const ref = useRef<HTMLButtonElement>(null)

  /* The face, readable synchronously.
   *
   * Counting reads the current face to work out the next one, and clicks can
   * land faster than React re-renders — a quick double tally would otherwise
   * see the same stale value twice and count once. A ref rather than a
   * functional update because the new value is also reported to the log, and
   * doing that inside an updater would fire twice under StrictMode. */
  const face = useRef(6)
  const show = (next: number) => { face.current = next; setValue(next) }

  /** Recent pointer samples, newest last, for working out release speed. */
  const trail = useRef<Sample[]>([])
  /** Where the drag began, and whether there is one: the trail is trimmed to
   *  its tail, so it cannot be asked where the gesture started. Non-null for
   *  exactly the duration of a drag, which is also the "am I dragging" flag. */
  const origin = useRef<Sample | null>(null)
  /** Set by a throw so the click that follows the release does not also fire. */
  const threw = useRef(false)
  const spin = useRef(0)
  const tween = useRef<gsap.core.Timeline | null>(null)

  useEffect(() => () => { tween.current?.kill() }, [])

  const settle = (next: number) => {
    show(next)
    onRoll?.(next, false)
  }

  /** Tumble out along the throw, then come back and settle on a face. */
  const roll = (vx: number, vy: number) => {
    const el = ref.current
    const next = anyFace()
    setCounting(false)

    if (!el || !canAnimate()) {
      // No animation available: the result is the part that matters.
      gsap.set(el, { x: 0, y: 0, rotate: 0 })
      settle(next)
      return
    }

    const speed = Math.hypot(vx, vy) || 0.4
    const tx = clamp(vx * CARRY)
    const ty = clamp(vy * CARRY)
    // Harder throws spin further, so the throw looks like it caused the roll
    // rather than merely preceding it.
    spin.current += 360 + Math.round(speed * 520)

    tween.current?.kill()
    const timeline = gsap.timeline({ onComplete: () => settle(next) })
    tween.current = timeline
    // Out along the throw...
    timeline.to(el, {
      x: tx, y: ty, rotate: spin.current, scale: 1.12,
      duration: 0.34, ease: 'power2.out',
      // The face flickers while it is in the air. Driven by the tween's own
      // clock rather than a timer, so it cannot outlive the animation.
      onUpdate: () => setValue(anyFace()),
    })
    // ...and back down into its corner, landing on the face it keeps.
    timeline.to(el, {
      x: 0, y: 0, rotate: spin.current + 180, scale: 1,
      duration: 0.72, ease: 'bounce.out',
      onUpdate: () => setValue(anyFace()),
    })
  }

  const onPointerDown = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return
    tween.current?.kill()
    threw.current = false
    setHeld(true)
    const now = { x: event.clientX, y: event.clientY, t: performance.now() }
    origin.current = now
    trail.current = [now]
    // Capture keeps the throw alive when the pointer leaves the die, which on
    // a flick it does immediately. It throws if the pointer is already gone,
    // and a die that cannot be captured is still a die that can be thrown.
    try { event.currentTarget.setPointerCapture(event.pointerId) } catch { /* fine */ }
  }

  const onPointerMove = (event: React.PointerEvent<HTMLButtonElement>) => {
    const start = origin.current
    if (!start) return
    trail.current.push({ x: event.clientX, y: event.clientY, t: performance.now() })
    // Only the tail is needed, and an unbounded trail on a long drag would
    // average the throw away.
    if (trail.current.length > 6) trail.current.shift()
    gsap.set(ref.current, {
      x: clamp(event.clientX - start.x),
      y: clamp(event.clientY - start.y),
    })
  }

  const onPointerUp = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (!origin.current) return
    setHeld(false)
    try { event.currentTarget.releasePointerCapture(event.pointerId) } catch { /* fine */ }

    // Speed over the last stretch of the drag, not over the whole of it: a
    // slow reposition ending in a flick is a throw, and averaging from the
    // first sample would call it a nudge.
    const samples = trail.current
    const last = samples[samples.length - 1]
    const first = samples[Math.max(0, samples.length - 4)]
    trail.current = []
    origin.current = null
    if (!last || !first || last.t === first.t) return

    const dt = last.t - first.t
    const vx = (last.x - first.x) / dt
    const vy = (last.y - first.y) / dt

    if (Math.hypot(vx, vy) >= THROW_SPEED) {
      threw.current = true
      roll(vx, vy)
      return
    }
    // Not a throw: put it back where it sits, and let the click through.
    gsap.set(ref.current, { x: 0, y: 0 })
  }

  const onClick = () => {
    // The release of a throw also produces a click; the throw already dealt
    // with it. In rolling mode a bare click does nothing at all, which is what
    // leaves the double-click free to mean something.
    if (threw.current) { threw.current = false; return }
    if (!counting) return
    // A d6 has six faces, so counting cycles rather than running off the end of
    // what the pips can say.
    const next = face.current >= 6 ? 1 : face.current + 1
    show(next)
    onRoll?.(next, true)
  }

  const onDoubleClick = () => {
    tween.current?.kill()
    gsap.set(ref.current, { x: 0, y: 0, rotate: 0, scale: 1 })
    setCounting(true)
    show(1)
    onRoll?.(1, true)
  }

  const pips = FACES[value] ?? FACES[1]

  return (
    <button
      ref={ref}
      className={`pt-die ${counting ? 'counting' : ''} ${held ? 'held' : ''}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      title={counting
        ? `Counting: ${value}. Click to count up, throw it to roll again.`
        : `Showing ${value}. Throw it to roll; double-click to count.`}
      aria-label={counting ? `Counter at ${value}` : `Die showing ${value}`}
      aria-live="polite"
    >
      <span className="pt-die-face" aria-hidden>
        {Array.from({ length: 9 }, (_, cell) => (
          <i key={cell} className={pips.includes(cell) ? 'on' : ''} />
        ))}
      </span>
    </button>
  )
}
