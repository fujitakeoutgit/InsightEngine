import { useEffect, useRef, useState } from 'react'

import { canAnimate, gsap } from '../lib/motion'
import { LESSONS, readDone, writeDone } from '../lib/lessons'
import artwork from '../assets/glossary-lessons.png'

/** `**bold**` and `` `code` ``, rendered. Split on both markers at once so a
 *  step can mix them, and the delimiters are dropped rather than shown — they
 *  were appearing literally, which is worse than no formatting at all. */
function formatted(step: string) {
  return step.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).filter(Boolean).map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**')) {
      return <strong key={i}>{part.slice(2, -2)}</strong>
    }
    if (part.startsWith('`') && part.endsWith('`')) {
      return <code key={i}>{part.slice(1, -1)}</code>
    }
    return <span key={i}>{part}</span>
  })
}

/**
 * Lessons, at the top of the Glossary.
 *
 * The Glossary is already the page you come to when you want to know how
 * something works, so the lessons belong above the reference rather than in
 * Settings, where they would be a feature you have to know exists before you
 * can be taught anything.
 *
 * A lesson is ticked or it is nothing — no progress bar, no percentage. The
 * tick is yours to set: this cannot observe whether you have understood a
 * thing, and pretending to by watching which pages you opened would be both
 * creepy and wrong.
 */
export function Lessons() {
  const [done, setDone] = useState<string[]>(readDone)
  const [open, setOpen] = useState<string | null>(null)
  const artRef = useRef<HTMLImageElement>(null)

  useEffect(() => writeDone(done), [done])

  /* A slow drift, not an animation you would call one.
   *
   * The artwork sits beside a list of things to read, so anything with a
   * beginning or an end would pull the eye off the words every time it
   * restarted. A long, seamless yoyo has no event in it to notice. */
  useEffect(() => {
    if (!artRef.current || !canAnimate()) return
    const drift = gsap.to(artRef.current, {
      y: -10, scale: 1.015, duration: 7,
      ease: 'sine.inOut', repeat: -1, yoyo: true,
    })
    return () => { drift.kill() }
  }, [])

  const toggle = (id: string) =>
    setDone((d) => (d.includes(id) ? d.filter((x) => x !== id) : [...d, id]))

  return (
    <div className="lessons">
      <div className="lessons-list">
        {LESSONS.map((lesson) => {
          const ticked = done.includes(lesson.id)
          const showing = open === lesson.id
          return (
            <article key={lesson.id} className={`lesson${ticked ? ' done' : ''}`}>
              <button
                className="lesson-head"
                aria-expanded={showing}
                onClick={() => setOpen(showing ? null : lesson.id)}
              >
                {/* The tick is a control in its own right, so a lesson you
                    already knew can be dismissed without opening it. */}
                <span
                  className="lesson-tick"
                  role="checkbox"
                  aria-checked={ticked}
                  aria-label={`Mark “${lesson.title}” ${ticked ? 'not done' : 'done'}`}
                  tabIndex={0}
                  onClick={(e) => { e.stopPropagation(); toggle(lesson.id) }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault(); e.stopPropagation(); toggle(lesson.id)
                    }
                  }}
                >
                  {ticked && (
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                      <path d="M5 13l4 4L19 7" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  )}
                </span>
                <span className="lesson-text">
                  <span className="lesson-title">{lesson.title}</span>
                  <span className="lesson-blurb">{lesson.blurb}</span>
                </span>
                <span className={`lesson-chev${showing ? ' open' : ''}`} aria-hidden>›</span>
              </button>

              {showing && (
                <ol className="lesson-steps">
                  {lesson.steps.map((step, i) => <li key={i}>{formatted(step)}</li>)}
                </ol>
              )}
            </article>
          )
        })}
      </div>

      <div className="lessons-art" aria-hidden>
        <img ref={artRef} src={artwork} alt="" draggable={false} />
      </div>
    </div>
  )
}
