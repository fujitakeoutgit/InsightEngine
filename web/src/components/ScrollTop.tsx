import { useEffect, useRef, useState } from 'react'

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
      onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
      aria-label="Back to top"
      aria-hidden={!shown}
      tabIndex={shown ? 0 : -1}
      title="Back to top"
    >
      ↑
    </button>
  )
}
