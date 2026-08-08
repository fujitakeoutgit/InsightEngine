import { useEffect, useRef } from 'react'

import { canAnimate, gsap } from '../lib/motion'
import type { DieState } from '../lib/playtestCache'

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

/**
 * How to turn the cube so a given face points at the viewer.
 *
 * The faces are laid out so opposite sides sum to seven, as they do on a real
 * die: 1 front / 6 back, 3 right / 4 left, 5 top / 2 bottom. Each entry here
 * is the inverse of that face's own placement transform.
 */
const ORIENT: Record<number, { rx: number; ry: number }> = {
  1: { rx: 0, ry: 0 },
  2: { rx: 90, ry: 0 },
  3: { rx: 0, ry: -90 },
  4: { rx: 0, ry: 90 },
  5: { rx: -90, ry: 0 },
  6: { rx: 0, ry: 180 },
}

/** Rendered size, matching `.pt-die` in the stylesheet. */
const SIZE = 46
/** Below this release speed a drag is a placement, not a throw. px/ms. */
const THROW_SPEED = 0.22
/** Velocity lost per millisecond in flight. */
const DRAG = 0.0026
/** How much speed survives a bounce off the edge of the mat. */
const BOUNCE = 0.58
/** Slower than this and the die has stopped. px/ms. */
const RESTING = 0.015
/** Degrees of tumble per pixel travelled. A die that slides without rolling
 *  reads as a dragged icon, so this is deliberately generous. */
const ROLL = 1.35

const clamp01 = (n: number) => Math.max(0, Math.min(1, n))

interface Sample { x: number; y: number; t: number }

/**
 * The die: a real six-sided cube you can throw anywhere on the mat.
 *
 * It does two jobs. Rolling is the obvious one — grab it and throw, and it
 * tumbles across the board, bounces off the edges and settles on a face
 * wherever it stops, because a die you cannot throw across the table is a
 * button with dots on it. Counting is the other: a die on a table is the
 * nearest thing to hand for tracking storm, experience or monarch turns, and a
 * double-click switches to it. Throwing always returns it to rolling, so there
 * is one gesture out of count mode and it is the gesture that made the die
 * interesting in the first place.
 *
 * Position is owned by the parent as a fraction of the mat, so the die
 * survives a resize and is saved with the rest of the game. Between gestures
 * this component reads that; during one it drives the element directly and
 * reports the resting place at the end.
 */
export function PlayDie({
  die, matRef, onChange, onRoll,
}: {
  die: DieState
  /** The playmat, which is both the coordinate space and the walls. */
  matRef: React.RefObject<HTMLDivElement | null>
  onChange: (next: Partial<DieState>) => void
  onRoll?: (value: number, counting: boolean) => void
}) {
  const ref = useRef<HTMLButtonElement>(null)
  const cubeRef = useRef<HTMLDivElement>(null)

  /** Accumulated cube rotation. Kept unwrapped — never reduced modulo 360 —
   *  so a settle can always turn onwards to the target rather than spinning
   *  backwards to reach the same orientation. */
  const spin = useRef({ x: -18, y: 24 })
  /** Recent pointer samples for working out release speed. */
  const trail = useRef<Sample[]>([])
  /** Where the drag began, and whether there is one. */
  const origin = useRef<{ pointer: Sample; px: number; py: number } | null>(null)
  /** A throw is in flight, or a drag is; either way the position effect must
   *  keep its hands off the element. */
  const busy = useRef(false)
  /** Set by a throw so the click that follows the release does not also fire. */
  const threw = useRef(false)
  const ticker = useRef<((time: number, delta: number) => void) | null>(null)
  const settleTween = useRef<gsap.core.Tween | null>(null)

  /** The travel available to the die: the mat, less its own size. */
  const span = () => {
    const mat = matRef.current
    if (!mat) return { w: 0, h: 0 }
    return { w: Math.max(0, mat.clientWidth - SIZE), h: Math.max(0, mat.clientHeight - SIZE) }
  }

  const stopTicker = () => {
    if (!ticker.current) return
    gsap.ticker.remove(ticker.current)
    ticker.current = null
  }

  useEffect(() => () => {
    stopTicker()
    settleTween.current?.kill()
    gsap.killTweensOf([ref.current, cubeRef.current])
  }, [])

  /* Place the die from the stored fraction.
   *
   * Runs on mount, on resume, and on resize — anything that changes where the
   * fraction lands in pixels. Skipped mid-gesture, when the element's position
   * is being driven directly and the state is deliberately stale. */
  useEffect(() => {
    const place = () => {
      if (busy.current || !ref.current) return
      const { w, h } = span()
      gsap.set(ref.current, { x: die.x * w, y: die.y * h })
    }
    place()
    window.addEventListener('resize', place)
    return () => window.removeEventListener('resize', place)
  }, [die.x, die.y])

  /** Show a face flat-on. Used by count mode, where the die is being read
   *  rather than thrown and any tumble is noise. */
  const faceOn = (value: number, animate: boolean) => {
    const cube = cubeRef.current
    if (!cube) return
    const { rx, ry } = ORIENT[value] ?? ORIENT[1]
    // Nearest equivalent turn, so it never rewinds through five faces.
    const target = {
      x: rx + 360 * Math.round((spin.current.x - rx) / 360),
      y: ry + 360 * Math.round((spin.current.y - ry) / 360),
    }
    spin.current = target
    settleTween.current?.kill()
    if (animate && canAnimate()) {
      settleTween.current = gsap.to(cube, {
        rotateX: target.x, rotateY: target.y, duration: 0.4, ease: 'power3.out',
      })
    } else {
      gsap.set(cube, { rotateX: target.x, rotateY: target.y })
    }
  }

  // The cube's resting orientation follows the value whenever it changes from
  // outside a throw — counting, or a resumed game.
  useEffect(() => {
    if (busy.current) return
    faceOn(die.value, false)
    // Only when the value itself moves; a throw sets its own final rotation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [die.value])

  /**
   * Throw it.
   *
   * A small integrator rather than a single tween to a computed landing spot,
   * because the bounces are the point: the die has to be able to hit the far
   * edge and come back, and how far it travels has to be something you did
   * rather than something that was decided for you. Velocity decays
   * exponentially, walls reflect it, and the tumble is driven by distance
   * travelled so the die rolls rather than slides.
   */
  const throwIt = (vx: number, vy: number) => {
    const el = ref.current
    const cube = cubeRef.current
    const next = 1 + Math.floor(Math.random() * 6)
    if (!el || !cube) return

    const { w, h } = span()
    let px = gsap.getProperty(el, 'x') as number
    let py = gsap.getProperty(el, 'y') as number

    const land = () => {
      busy.current = false
      stopTicker()
      onChange({ x: w ? clamp01(px / w) : 0, y: h ? clamp01(py / h) : 0, value: next })
      faceOn(next, true)
      onRoll?.(next, false)
    }

    if (!canAnimate()) {
      // No frames to animate with: carry the throw to where it would have
      // ended up rather than dropping the die where it was released.
      px = Math.max(0, Math.min(w, px + vx * 260))
      py = Math.max(0, Math.min(h, py + vy * 260))
      gsap.set(el, { x: px, y: py })
      land()
      return
    }

    busy.current = true
    stopTicker()
    settleTween.current?.kill()

    const step = (_time: number, delta: number) => {
      // Clamped so a dropped frame cannot teleport the die through a wall.
      const dt = Math.min(delta, 32)
      px += vx * dt
      py += vy * dt

      if (px < 0) { px = -px; vx = -vx * BOUNCE }
      if (px > w) { px = 2 * w - px; vx = -vx * BOUNCE }
      if (py < 0) { py = -py; vy = -vy * BOUNCE }
      if (py > h) { py = 2 * h - py; vy = -vy * BOUNCE }

      const decay = Math.exp(-DRAG * dt)
      vx *= decay
      vy *= decay

      // Rolling: horizontal travel turns the cube about Y, vertical about X.
      spin.current.y += vx * dt * ROLL
      spin.current.x -= vy * dt * ROLL

      gsap.set(el, { x: px, y: py })
      gsap.set(cube, { rotateX: spin.current.x, rotateY: spin.current.y })

      if (Math.hypot(vx, vy) < RESTING) land()
    }

    ticker.current = step
    gsap.ticker.add(step)
  }

  const onPointerDown = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return
    stopTicker()
    settleTween.current?.kill()
    threw.current = false
    busy.current = true
    const el = ref.current
    origin.current = {
      pointer: { x: event.clientX, y: event.clientY, t: performance.now() },
      px: el ? (gsap.getProperty(el, 'x') as number) : 0,
      py: el ? (gsap.getProperty(el, 'y') as number) : 0,
    }
    trail.current = [{ x: event.clientX, y: event.clientY, t: performance.now() }]
    // Capture keeps the gesture alive once the pointer outruns the die, which
    // on a flick it does immediately. It throws if the pointer is already
    // gone, and a die that cannot be captured is still a die that can be
    // thrown.
    try { event.currentTarget.setPointerCapture(event.pointerId) } catch { /* fine */ }
  }

  const onPointerMove = (event: React.PointerEvent<HTMLButtonElement>) => {
    const start = origin.current
    if (!start || !ref.current) return
    const { w, h } = span()
    const px = Math.max(0, Math.min(w, start.px + (event.clientX - start.pointer.x)))
    const py = Math.max(0, Math.min(h, start.py + (event.clientY - start.pointer.y)))
    gsap.set(ref.current, { x: px, y: py })

    // Tumble while being carried, so it reads as an object in the hand rather
    // than an icon being dragged.
    const last = trail.current[trail.current.length - 1]
    if (last && cubeRef.current) {
      spin.current.y += (event.clientX - last.x) * 0.45
      spin.current.x -= (event.clientY - last.y) * 0.45
      gsap.set(cubeRef.current, { rotateX: spin.current.x, rotateY: spin.current.y })
    }

    trail.current.push({ x: event.clientX, y: event.clientY, t: performance.now() })
    // Only the tail is needed, and an unbounded trail on a long drag would
    // average the throw away.
    if (trail.current.length > 6) trail.current.shift()
  }

  const onPointerUp = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (!origin.current) return
    origin.current = null
    try { event.currentTarget.releasePointerCapture(event.pointerId) } catch { /* fine */ }

    // Speed over the last stretch of the drag, not over the whole of it: a
    // slow reposition ending in a flick is a throw, and averaging from the
    // first sample would call it a nudge.
    const samples = trail.current
    const last = samples[samples.length - 1]
    const first = samples[Math.max(0, samples.length - 4)]
    trail.current = []

    const dt = last && first ? last.t - first.t : 0
    const vx = dt ? (last.x - first.x) / dt : 0
    const vy = dt ? (last.y - first.y) / dt : 0

    if (Math.hypot(vx, vy) >= THROW_SPEED) {
      threw.current = true
      onChange({ counting: false })
      throwIt(vx, vy)
      return
    }

    // Not a throw: it stays where you set it down.
    busy.current = false
    const el = ref.current
    if (!el) return
    const { w, h } = span()
    const px = gsap.getProperty(el, 'x') as number
    const py = gsap.getProperty(el, 'y') as number
    onChange({ x: w ? clamp01(px / w) : 0, y: h ? clamp01(py / h) : 0 })
  }

  const onClick = () => {
    // The release of a throw also produces a click; the throw already dealt
    // with it. In rolling mode a bare click does nothing at all, which is what
    // leaves the double-click free to mean something.
    if (threw.current) { threw.current = false; return }
    if (!die.counting) return
    // A d6 has six faces, so counting cycles rather than running off the end
    // of what the pips can say.
    const next = die.value >= 6 ? 1 : die.value + 1
    onChange({ value: next })
    onRoll?.(next, true)
  }

  const onDoubleClick = () => {
    stopTicker()
    onChange({ counting: true, value: 1 })
    onRoll?.(1, true)
  }

  return (
    <button
      ref={ref}
      className={`pt-die ${die.counting ? 'counting' : ''}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      title={die.counting
        ? `Counting: ${die.value}. Click to count up, throw it to roll again.`
        : `Showing ${die.value}. Throw it anywhere on the mat; double-click to count.`}
      aria-label={die.counting ? `Counter at ${die.value}` : `Die showing ${die.value}`}
      aria-live="polite"
    >
      <div className="pt-die-cube" ref={cubeRef} aria-hidden>
        {[1, 2, 3, 4, 5, 6].map((face) => (
          <span className={`pt-die-side s${face}`} key={face}>
            {Array.from({ length: 9 }, (_, cell) => (
              <i key={cell} className={FACES[face].includes(cell) ? 'on' : ''} />
            ))}
          </span>
        ))}
      </div>
    </button>
  )
}
