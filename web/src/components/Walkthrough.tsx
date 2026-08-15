import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useLocation, useNavigate } from 'react-router-dom'

import { api } from '../lib/api'
import { isBinder } from '../lib/binder'
import { readDone, writeDone } from '../lib/lessons'
import { tour, useTour } from '../lib/tour'
import { formatted } from './Lessons'

/** Where the lessons live, and where a finished one puts you back. */
const HOME = '/glossary'

/**
 * A deck to demonstrate on.
 *
 * Minsc first because it is the deck this app seeds, so it is the one most
 * installs have — but it is an ordinary deck and can be deleted, so any other
 * will do, and the gallery is the honest fallback when there are none. The
 * binder is skipped: it is not a deck you would open to learn the editor.
 */
async function examplePath(kind: 'deck' | 'playtest' | 'simulate'): Promise<string> {
  try {
    const { decks } = await api.savedDecks()
    const usable = decks.filter((d) => !isBinder(d))
    const pick = usable.find((d) => d.name === 'Minsc') ?? usable[0]
    if (pick) return `/${kind}/${pick.id}`
  } catch { /* offline: the gallery still teaches the shape of the page */ }
  return kind === 'playtest' ? '/playtest' : '/deck'
}

/** Gap between the highlighted thing and the card talking about it. */
const GAP = 14
/** Kept this far from the edge of the window. */
const MARGIN = 12
const CARD_WIDTH = 340

interface Spot {
  top: number
  left: number
  width: number
  height: number
}

/**
 * The guided walkthrough.
 *
 * Lives in the layout rather than on the Glossary, because a lesson walks you
 * to other pages: mounted inside a route, it would unmount itself the moment
 * it navigated.
 *
 * The dimming is one element, not four. A single box positioned over the
 * target with an enormous spread `box-shadow` darkens the entire page *except*
 * that box — no masks, no four rectangles to keep in sync around a hole, and
 * it follows the target with one style update.
 *
 * Rendered through a portal onto `document.body`, and that is not incidental.
 * `position: fixed` resolves against the nearest ancestor carrying a
 * transform, filter or perspective rather than against the viewport — and this
 * app animates pages with transforms. Left inside the layout, the highlight
 * took its coordinates from one frame of reference and was painted in another:
 * its inline `left` was right to the pixel while the box on screen sat scores
 * of pixels away and never moved. A portal has no such ancestor.
 */
export function Walkthrough() {
  const { lesson, index } = useTour()
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const [spot, setSpot] = useState<Spot | null>(null)
  const cardRef = useRef<HTMLDivElement>(null)

  const step = lesson?.steps[index] ?? null

  /* Walk to the page this step is about. Done as an effect off the step rather
   * than inside the click, so Back re-navigates too.
   *
   * `example` steps resolve a real deck first — a lesson about the editor has
   * to be *in* the editor, and the editor needs something to edit. */
  useEffect(() => {
    if (!step) return
    let cancelled = false
    if (step.example) {
      const wanted = step.example === 'deck' ? '/deck/' : '/playtest/'
      // Already inside one: do not hop to a different deck mid-lesson.
      if (pathname.startsWith(wanted)) return
      examplePath(step.example).then((to) => { if (!cancelled) navigate(to) })
      return () => { cancelled = true }
    }
    if (step.route && step.route !== pathname) navigate(step.route)
    return () => { cancelled = true }
  }, [step, pathname, navigate])

  /* Find the thing being pointed at.
   *
   * Retried across a few frames because a step usually arrives with a route
   * change, and the page it names has not rendered yet on the frame the step
   * changes. Giving up quietly is the right failure: the card centres itself
   * and the lesson still reads, which is much better than an arrow pointing
   * at the corner of an empty page. */
  useLayoutEffect(() => {
    if (!step) { setSpot(null); return }
    if (!step.target) { setSpot(null); return }

    let timer = 0
    let cancelled = false
    /* Bounded by time, not by a frame count.
     *
     * Thirty frames is half a second, which is fine for a step that only
     * changes route — and far too short for one that opens a deck, since the
     * playtest mat is not in the DOM until the decklist has been analysed and
     * dealt. The lesson then pointed at nothing and fell back to a centred
     * card *while the thing it names was seconds from appearing*. Four
     * seconds covers a deck load and still gives up rather than hanging.
     *
     * Polled on a timer rather than `requestAnimationFrame`. rAF is tied to
     * the rendering loop, and a page that is not compositing never runs one —
     * so the retry silently never happened and the very first look decided the
     * answer. A timer keeps ticking either way. */
    const deadline = performance.now() + 8000

    /* Keep measuring for a moment after the first hit.
     *
     * The thing being pointed at often grows right after it appears — a mat
     * lays out its tools, a tile loads its art — and a box measured on the
     * first frame it exists is a box around the wrong shape. Re-reads for a
     * second and a half, and only writes when it has actually moved. */
    const settle = (el: Element) => {
      const until = performance.now() + 1500
      const again = () => {
        if (cancelled || performance.now() > until) return
        const r = el.getBoundingClientRect()
        setSpot((prev) => (
          prev && Math.abs(prev.top - r.top) < 0.5 && Math.abs(prev.left - r.left) < 0.5
            && Math.abs(prev.height - r.height) < 0.5 && Math.abs(prev.width - r.width) < 0.5
            ? prev
            : { top: r.top, left: r.left, width: r.width, height: r.height }
        ))
        timer = window.setTimeout(again, 150)
      }
      timer = window.setTimeout(again, 150)
    }

    const look = () => {
      if (cancelled) return
      const el = document.querySelector(step.target as string)
      if (el) {
        const r = el.getBoundingClientRect()
        if (r.width || r.height) {
          /* Scrolled instantly, not smoothly.
           *
           * A smooth scroll is still travelling when the next line measures,
           * so the highlight was placed at the element's *pre-scroll* position
           * and the page then slid out from under it — which is why it sat
           * high, and why stepping away and back fixed it: by then no scroll
           * was needed and the first measurement was already correct. */
          el.scrollIntoView({ block: 'center', behavior: 'auto' })
          const after = el.getBoundingClientRect()
          setSpot({ top: after.top, left: after.left, width: after.width, height: after.height })
          settle(el)
          return
        }
      }
      if (performance.now() < deadline) timer = window.setTimeout(look, 120)
      else setSpot(null)
    }
    look()
    return () => { cancelled = true; window.clearTimeout(timer) }
  }, [step, pathname])

  /* Keep the highlight on the thing as the page moves under it. */
  useEffect(() => {
    if (!step?.target) return
    const follow = () => {
      const el = document.querySelector(step.target as string)
      if (!el) return
      const r = el.getBoundingClientRect()
      setSpot({ top: r.top, left: r.left, width: r.width, height: r.height })
    }
    window.addEventListener('scroll', follow, true)
    window.addEventListener('resize', follow)
    return () => {
      window.removeEventListener('scroll', follow, true)
      window.removeEventListener('resize', follow)
    }
  }, [step])

  const finish = useCallback(() => {
    if (!lesson) return
    const done = readDone()
    if (!done.includes(lesson.id)) writeDone([...done, lesson.id])
  }, [lesson])

  const advance = useCallback(() => {
    if (tour.next() === 'finished') {
      finish()
      /* Back where the lesson was started from. A walkthrough that ends by
       * abandoning you three pages deep in a deck you did not open leaves you
       * to find your own way home, and the tick you just earned is on the
       * Glossary. */
      navigate(HOME)
    }
  }, [finish, navigate])

  useEffect(() => {
    if (!lesson) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); tour.stop() }
      if (e.key === 'ArrowRight') { e.preventDefault(); advance() }
      if (e.key === 'ArrowLeft') { e.preventDefault(); tour.back() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [lesson, advance])

  if (!lesson || !step) return null

  const last = index === lesson.steps.length - 1

  /* Below the target if it fits, above if not, centred if there is nothing to
   * point at. The arrow is only drawn when there is something to point at. */
  const below = spot ? spot.top + spot.height + GAP : 0
  const roomBelow = spot ? window.innerHeight - below : 0
  const placeAbove = Boolean(spot) && roomBelow < 190
  const cardStyle: React.CSSProperties = spot
    ? {
        top: placeAbove ? undefined : below,
        bottom: placeAbove ? window.innerHeight - spot.top + GAP : undefined,
        left: Math.min(
          Math.max(MARGIN, spot.left + spot.width / 2 - CARD_WIDTH / 2),
          Math.max(MARGIN, window.innerWidth - CARD_WIDTH - MARGIN),
        ),
      }
    : { top: '50%', left: '50%', transform: 'translate(-50%, -50%)' }

  return createPortal(
    <div className="tour" role="dialog" aria-modal aria-label={`${lesson.title}, step ${index + 1}`}>
      {/* Swallows stray clicks so a walkthrough cannot be half-driven by the
          page underneath it. */}
      <div className="tour-catch" onClick={() => tour.stop()} />

      {spot && (
        <div
          className="tour-spot"
          style={{
            top: spot.top - 6,
            left: spot.left - 6,
            width: spot.width + 12,
            height: spot.height + 12,
          }}
        />
      )}

      <div className={`tour-card${spot ? (placeAbove ? ' above' : ' below') : ' centred'}`}
        style={cardStyle} ref={cardRef}
      >
        <div className="tour-head">
          <span className="tour-title">{lesson.title}</span>
          <span className="tour-count mono">{index + 1} / {lesson.steps.length}</span>
        </div>

        <p className="tour-text">{formatted(step.text)}</p>

        <div className="tour-actions">
          <button className="btn btn-ghost sm" onClick={() => tour.stop()}>Stop</button>
          <span className="push" />
          <button className="btn btn-ghost sm" onClick={() => tour.back()} disabled={index === 0}>
            Back
          </button>
          <button className="btn btn-primary sm" onClick={advance}>
            {last ? 'Done' : 'Next'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
