import type { ReactNode } from 'react'
import { forwardRef } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'

/**
 * Back control shared by every page.
 *
 * Uses history rather than a link to a fixed route: going back to the search
 * page re-renders it from cache, restoring both results and scroll position
 * instead of re-running what may have been a multi-minute `q:` query. Falls
 * back to the search page when there is no history to pop — a deep link opened
 * in a fresh tab, say.
 */
export function BackLink({ label = 'Back', fallback = '/' }: { label?: string; fallback?: string }) {
  const navigate = useNavigate()
  const location = useLocation()
  const canPop = window.history.length > 1 && location.key !== 'default'

  return (
    <button className="back-link" onClick={() => (canPop ? navigate(-1) : navigate(fallback))}>
      ← {label}
    </button>
  )
}

/**
 * The masthead every page wears: back control, eyebrow, title, and a slot for
 * whatever that page's controls are.
 *
 * Subtitles go *under* the title rather than beside it. `.section-head` is a
 * space-between row, so a paragraph passed as a sibling of the heading gets
 * flung to the far right and reads as an unrelated caption.
 */
export const PageHead = forwardRef<HTMLDivElement, {
  eyebrow?: string
  title: string
  subtitle?: ReactNode
  /** Right-hand controls: filters, counts, actions. */
  children?: ReactNode
  back?: false | { label?: string; fallback?: string }
}>(function PageHead({ eyebrow, title, subtitle, children, back = {} }, ref) {
  return (
    <div className="page-head" ref={ref}>
      {back !== false && <div className="page-back"><BackLink {...back} /></div>}
      <div className="section-head">
        <div className="head-titles">
          {eyebrow && <span className="eyebrow">{eyebrow}</span>}
          <h2>{title}</h2>
          {subtitle && <p className="head-sub muted">{subtitle}</p>}
        </div>
        {children && <div className="row gap-2 wrap head-tools">{children}</div>}
      </div>
    </div>
  )
})

/**
 * A word as one span per letter, for the staggered masthead reveal.
 *
 * Rendered rather than split in place. `splitChars` rewrites an element's
 * contents after the fact, which is fine for an element React never touches
 * again and fatal for one it does — unmounting a title built that way had
 * React try to remove a text node something else had already replaced, and
 * the page came down with "The node to be removed is not a child of this
 * node". Letting React own the spans costs nothing and cannot desynchronise.
 *
 * Spaces stay as text: a span per space would be a character the animation
 * staggers over and the reader cannot see.
 */
export function Chars({ text }: { text: string }) {
  return (
    <>
      {[...text].map((ch, i) => (
        ch === ' '
          ? ' '
          : <span className="char" key={`${ch}-${i}`}>{ch}</span>
      ))}
    </>
  )
}
