import { useEffect, useRef } from 'react'

import { canAnimate, gsap } from '../lib/motion'
import { DIE_PX, DIE_SIDES, TRAY_SNAP, type DieState } from '../lib/playtestCache'

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
const SIZE = DIE_PX
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

/** How far the d20's silhouette is allowed to tilt out of plane, in degrees.
 *  Shallow on purpose: enough to read as a solid turning over, nowhere near
 *  enough to catch it edge-on. */
const TILT = 24
const DEG = Math.PI / 180

const clamp01 = (n: number) => Math.max(0, Math.min(1, n))

/** Signed shortest way round to an angle, in degrees. */
const wrap180 = (a: number) => (((a + 180) % 360) + 360) % 360 - 180

/**
 * The face the die is closest to already, and the turn that lays it flat.
 *
 * This is what decides the roll. Picking a value up front and then rotating
 * to match meant the tumble was theatre: the cube would be showing a six as
 * it came to rest and then jump to the five that had been chosen before it
 * was ever thrown. Reading the face out of the physics instead means the
 * number is whatever the die actually did, and the settle is a few degrees of
 * turn rather than a snap.
 */
function nearestFace(spinX: number, spinY: number) {
  let best = { value: 1, x: spinX, y: spinY, cost: Infinity }
  for (const face of [1, 2, 3, 4, 5, 6]) {
    const { rx, ry } = ORIENT[face]
    const dx = wrap180(rx - spinX)
    const dy = wrap180(ry - spinY)
    const cost = Math.abs(dx) + Math.abs(dy)
    if (cost < best.cost) best = { value: face, x: spinX + dx, y: spinY + dy, cost }
  }
  return best
}

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
  die, matRef, trayRef, binRef, onChange, onRoll, onDragState, onDiscard,
}: {
  die: DieState
  /** The playmat, which is both the coordinate space and the walls. */
  matRef: React.RefObject<HTMLDivElement | null>
  /** This die's tray. A die at home is placed from this element's measured
   *  position rather than from its own coordinates — see `DieState.home`.
   *  Typed as an element rather than a div because only its box is ever read:
   *  the Settings table makes each slot a button that calls its die home. */
  trayRef: React.RefObject<HTMLElement | null>
  /** The bin, which only exists while a die is in hand. */
  binRef?: React.RefObject<HTMLDivElement | null>
  /** `backInTray` says the die came to rest on its own slot, which is how a
   *  loose one is put away and how a home one is known not to have left. */
  onChange: (next: Partial<DieState>, backInTray?: boolean) => void
  onRoll?: (value: number, counting: boolean) => void
  /** Carrying a die, and whether it is currently over the bin. Drives both
   *  the bin appearing and its armed state. */
  onDragState?: (carrying: boolean, overBin: boolean) => void
  /** Released over the bin: this die goes away. */
  onDiscard?: () => void
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

  /** The tray's own resting spot, in pixels from the mat's corner. */
  const trayAt = () => {
    const mat = matRef.current
    const tray = trayRef.current
    if (!mat || !tray) return null
    const m = mat.getBoundingClientRect()
    const t = tray.getBoundingClientRect()
    return { x: t.x - m.x + (t.width - SIZE) / 2, y: t.y - m.y + (t.height - SIZE) / 2 }
  }

  /** Is the pointer over the bin? Tested against the pointer rather than the
   *  die, because the die is a 46px block under your finger and what you aim
   *  with is the finger. */
  const overBin = (clientX: number, clientY: number) => {
    const bin = binRef?.current
    if (!bin) return false
    const b = bin.getBoundingClientRect()
    return clientX >= b.left && clientX <= b.right && clientY >= b.top && clientY <= b.bottom
  }

  /** Whether a resting position counts as back in the slot. Measured in
   *  pixels against the tray itself, so it means the same thing at every
   *  window size — a fraction of the mat did not. */
  const onTray = (px: number, py: number) => {
    const at = trayAt()
    return at ? Math.hypot(px - at.x, py - at.y) < TRAY_SNAP : false
  }

  /** Where this die belongs right now, in pixels from the mat's corner.
   *
   * A die at home is measured off its tray, so it sits in the outline exactly
   * however flexbox laid that tray out. Everything else comes from its stored
   * fraction of the mat's free space, which is what survives a resize. */
  const restingAt = () => {
    const mat = matRef.current
    if (!mat) return null
    if (die.home) {
      const tray = trayRef.current
      if (!tray) return null
      const m = mat.getBoundingClientRect()
      const t = tray.getBoundingClientRect()
      return {
        x: t.x - m.x + (t.width - SIZE) / 2,
        y: t.y - m.y + (t.height - SIZE) / 2,
      }
    }
    const { w, h } = span()
    return { x: die.x * w, y: die.y * h }
  }

  /* Put the die where it belongs.
   *
   * Watches the mat itself rather than the window, because the thing that
   * actually moves the tray is the mat changing size, and only some of the
   * ways that happens are window resizes. The one that mattered: the hand's
   * card images arrive after this has mounted, the hand grows to fit them,
   * the mat is squeezed by exactly that much, and the tools ride up with its
   * bottom edge -- while the die, positioned once against the old box, stays
   * where it was. No resize event is fired for any of it, so a window
   * listener sleeps through it and the die starts life below its own square.
   * That is also why a die spawned later looked fine: it mounts into a
   * layout that has already settled.
   *
   * Skipped mid-gesture, when the element's position is being driven directly
   * and the state is deliberately stale. */
  useEffect(() => {
    const place = () => {
      if (busy.current || !ref.current) return
      const at = restingAt()
      if (at) gsap.set(ref.current, at)
    }
    place()
    // A frame later as well: on first mount the tray may not have been laid
    // out when this runs, and a die placed against a zero-size tray is the
    // die that appears just outside its own slot.
    const settle = requestAnimationFrame(place)
    const mat = matRef.current
    const watch = new ResizeObserver(place)
    if (mat) watch.observe(mat)
    return () => {
      cancelAnimationFrame(settle)
      watch.disconnect()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [die.x, die.y, die.home])

  /** How the accumulated spin becomes actual rotation.
   *
   * A cube is a real solid and turns on X and Y. The d20 is not: it is one
   * flat silhouette, and a plane turned edge-on in 3D collapses to a line —
   * a d20 that vanishes to a hairline halfway through a throw reads as a
   * sheet of paper rather than as a solid. So its tumble is an in-plane spin
   * on Z, which can never flatten, plus a shallow bounded tilt that keeps it
   * turning *in* space rather than sliding across it.
   *
   * Both tilt terms are sines of the spin, so they vanish exactly when the
   * spin lands on a multiple of 360 — which is what `land` snaps to. The die
   * therefore comes to rest genuinely flat-on, never a few degrees off. */
  const turn = (rx: number, ry: number) => (
    die.kind === 'd20'
      ? {
          rotateZ: ry,
          rotateX: TILT * Math.sin(rx * DEG),
          rotateY: TILT * Math.sin(ry * DEG),
        }
      : { rotateX: rx, rotateY: ry, rotateZ: 0 }
  )

  /** Show a face flat-on. Used by count mode, where the die is being read
   *  rather than thrown and any tumble is noise. */
  const faceOn = (value: number, animate: boolean) => {
    const cube = cubeRef.current
    if (!cube) return
    // A d20 has no face geometry to turn to — upright is the whole of it.
    const { rx, ry } = die.kind === 'd20' ? { rx: 0, ry: 0 } : ORIENT[value] ?? ORIENT[1]
    // Nearest equivalent turn, so it never rewinds through five faces.
    const target = {
      x: rx + 360 * Math.round((spin.current.x - rx) / 360),
      y: ry + 360 * Math.round((spin.current.y - ry) / 360),
    }
    spin.current = target
    settleTween.current?.kill()
    if (animate && canAnimate()) {
      settleTween.current = gsap.to(cube, {
        ...turn(target.x, target.y), duration: 0.4, ease: 'power3.out',
      })
    } else {
      gsap.set(cube, turn(target.x, target.y))
    }
  }

  /* What the cube is currently turned to show.
   *
   * The settle reports its value up, which comes straight back down as a prop
   * — and without this the effect below would treat its own result as an
   * external change, recompute the orientation and `gsap.set` it, killing the
   * settle tween mid-flight. That was the snap: the die stopped turning and
   * jumped square in the same instant it landed. */
  const shown = useRef(die.value)

  // The cube follows the value when it changes from outside a throw: counting,
  // or a resumed game.
  useEffect(() => {
    if (busy.current || shown.current === die.value) return
    shown.current = die.value
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
    if (!el || !cube) return

    const { w, h } = span()
    let px = gsap.getProperty(el, 'x') as number
    let py = gsap.getProperty(el, 'y') as number

    /** Come to rest: lay the cube flat on whichever face it is nearest, and
     *  report that face as the roll. */
    const land = () => {
      stopTicker()
      /* A cube's result is read off its geometry; a d20's cannot be.
       *
       * Twenty triangular faces is not a shape you can build out of six divs,
       * so the d20 tumbles as a solid and carries a numeral. Choosing that
       * numeral at the end rather than the start is what keeps it honest —
       * the number is never legible mid-tumble, so there is nothing for it to
       * contradict, which is the same trick the coin's spin plays. */
      const rest = die.kind === 'd20'
        ? {
            value: 1 + Math.floor(Math.random() * 20),
            x: 360 * Math.round(spin.current.x / 360),
            y: 360 * Math.round(spin.current.y / 360),
          }
        : nearestFace(spin.current.x, spin.current.y)
      spin.current = { x: rest.x, y: rest.y }
      shown.current = rest.value
      settleTween.current?.kill()
      if (canAnimate()) {
        settleTween.current = gsap.to(cube, {
          ...turn(rest.x, rest.y),
          // Short and soft: this is the die rocking onto a face, not a
          // separate animation happening to it.
          duration: 0.28, ease: 'power2.out',
          onComplete: () => { busy.current = false },
        })
      } else {
        gsap.set(cube, turn(rest.x, rest.y))
        busy.current = false
      }
      onChange(
        { x: w ? clamp01(px / w) : 0, y: h ? clamp01(py / h) : 0, value: rest.value },
        onTray(px, py),
      )
      onRoll?.(rest.value, false)
    }

    if (!canAnimate()) {
      // No frames to animate with: carry the throw to where it would have
      // ended up rather than dropping the die where it was released, and give
      // the cube a tumble to be read off.
      px = Math.max(0, Math.min(w, px + vx * 260))
      py = Math.max(0, Math.min(h, py + vy * 260))
      spin.current.y += vx * 260 * ROLL
      spin.current.x -= vy * 260 * ROLL
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
      gsap.set(cube, turn(spin.current.x, spin.current.y))

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
    onDragState?.(true, false)
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

    /* Deliberately no tumble while it is being carried.
     *
     * A die in your hand does not roll -- you are holding it. Spinning it
     * during the drag also made the face unreadable exactly when someone is
     * placing it deliberately rather than throwing it, and blurred the line
     * between the two gestures. It turns only in flight. */

    onDragState?.(true, overBin(event.clientX, event.clientY))

    trail.current.push({ x: event.clientX, y: event.clientY, t: performance.now() })
    // Only the tail is needed, and an unbounded trail on a long drag would
    // average the throw away.
    if (trail.current.length > 6) trail.current.shift()
  }

  const onPointerUp = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (!origin.current) return
    origin.current = null
    try { event.currentTarget.releasePointerCapture(event.pointerId) } catch { /* fine */ }
    onDragState?.(false, false)

    /* Dropped in the bin. Checked before the throw test, so a die flicked
     * into it is binned rather than thrown out of it — the bin is where you
     * let go, and letting go fast is still letting go there. */
    if (overBin(event.clientX, event.clientY)) {
      trail.current = []
      busy.current = false
      threw.current = true
      onDiscard?.()
      return
    }

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
    onChange({ x: w ? clamp01(px / w) : 0, y: h ? clamp01(py / h) : 0 }, onTray(px, py))
  }

  const onClick = () => {
    // The release of a throw also produces a click; the throw already dealt
    // with it. In rolling mode a bare click does nothing at all, which is what
    // leaves the double-click free to mean something.
    if (threw.current) { threw.current = false; return }
    if (!die.counting) return
    // Cycles at the die's own size rather than at six: a d20 counting to 6 and
    // starting over is a counter that cannot count to the number it is for.
    const next = die.value >= DIE_SIDES[die.kind] ? 1 : die.value + 1
    onChange({ value: next })
    onRoll?.(next, true)
  }

  const onDoubleClick = () => {
    /* Only ever *enters* count mode.
     *
     * A second click inside the double-click window fires `onClick` as well as
     * this, so counting up quickly ran 3 -> 4 and then had this reset it to 1.
     * A die already counting is a die whose double-click has done its job, and
     * the fastest way to count is exactly the way that used to break it. */
    if (die.counting) return
    stopTicker()
    busy.current = false
    onChange({ counting: true, value: 1 })
    onRoll?.(1, true)
  }

  return (
    <button
      ref={ref}
      className={`pt-die pt-${die.kind} ${die.counting ? 'counting' : ''}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      title={die.counting
        ? `Counting: ${die.value}. Click to count up, throw it to roll again.`
        : `${die.kind.toUpperCase()} showing ${die.value}. Throw it anywhere on the mat; double-click to count.`}
      aria-label={die.counting
        ? `Counter at ${die.value}`
        : `${die.kind.toUpperCase()} showing ${die.value}`}
      aria-live="polite"
    >
      <div className="pt-die-cube" ref={cubeRef} aria-hidden>
        {die.kind === 'd20' ? (
          /* The icosahedron as a drawn silhouette rather than twenty real
             faces. Face-on, a d20 is a hexagon with the face you read in the
             middle of it, so that outline plus three edges running out to the
             corners is the whole of what makes it recognisable — and it is
             recognisable *before* you read the number, which is the entire
             job. Twenty real faces would need twenty clip-paths and the
             dihedral angles to go with them, for a shape that is edge-on and
             unreadable most of the time anyway. See `turn` for why it spins
             in-plane. */
          <span className="pt-die-body">
            <svg className="pt-d20-shape" viewBox="0 0 100 100">
              <polygon className="hull" points="50,4 89.8,27 89.8,73 50,96 10.2,73 10.2,27" />
              <polygon className="face" points="50,26 73,66 27,66" />
              <path className="edge" d="M50,4 L50,26 M89.8,73 L73,66 M10.2,73 L27,66" />
            </svg>
            <span className="pt-d20-num">{die.value}</span>
          </span>
        ) : (
          [1, 2, 3, 4, 5, 6].map((face) => (
            <span className={`pt-die-side s${face}`} key={face}>
              {Array.from({ length: 9 }, (_, cell) => (
                <i key={cell} className={FACES[face].includes(cell) ? 'on' : ''} />
              ))}
            </span>
          ))
        )}
      </div>
    </button>
  )
}
