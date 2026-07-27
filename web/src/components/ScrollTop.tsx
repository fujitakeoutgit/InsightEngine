import { useEffect, useRef, useState } from 'react'

import { gsap, reduced } from '../lib/motion'

/**
 * Scroll the window to the top.
 *
 * Native `behavior: 'smooth'` uses a symmetric ease that crawls through the
 * last couple of hundred pixels; from deep in a result set that reads as the
 * page having stalled. `power2.in` spends its slow part at the *start*, where
 * the movement is legible, and arrives briskly.
 */
function scrollToTop() {
  if (reduced()) {
    window.scrollTo(0, 0)
    return
  }
  // Tweening a proxy and scrolling in onUpdate, rather than pulling in
  // ScrollToPlugin for one call.
  const position = { y: window.scrollY }
  gsap.to(position, {
    y: 0,
    duration: Math.min(0.75, 0.28 + window.scrollY / 9000),
    ease: 'power2.in',
    overwrite: true,
    onUpdate: () => window.scrollTo(0, position.y),
  })
}

/**
 * Floating return-to-top control.
 *
 * Watches a sentinel — the results toolbar — rather than a scroll threshold,
 * so it appears exactly when the controls you would otherwise scroll back for
 * have left the viewport, regardless of how tall the results are.
 */
export function ScrollTop({
  watch,
  ready,
}: {
  watch: React.RefObject<HTMLElement | null>
  /**
   * Whether the watched element is currently mounted. A ref is stable across
   * renders, so an effect keyed on it alone runs once — while `watch.current`
   * is still null — and never sees the toolbar arrive with the first results.
   */
  ready: boolean
}) {
  const [shown, setShown] = useState(false)
  const observer = useRef<IntersectionObserver | null>(null)

  useEffect(() => {
    const target = watch.current
    if (!ready || !target) {
      setShown(false)
      return
    }
    observer.current = new IntersectionObserver(
      ([entry]) => setShown(!entry.isIntersecting),
      { rootMargin: '-8px 0px 0px 0px' },
    )
    observer.current.observe(target)
    return () => observer.current?.disconnect()
  }, [watch, ready])

  return (
    <button
      className={`to-top ${shown ? 'shown' : ''}`}
      onClick={() => scrollToTop()}
      aria-label="Back to top"
      aria-hidden={!shown}
      tabIndex={shown ? 0 : -1}
      title="Back to top"
    >
      ↑
    </button>
  )
}
