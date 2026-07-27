import { useEffect, useLayoutEffect, useRef } from 'react'
import { createPortal } from 'react-dom'

import { canAnimate, gsap } from '../lib/motion'

/**
 * Full-screen card view.
 *
 * Animates out of the thumbnail's own rectangle rather than fading in from
 * nowhere, so the card appears to grow from where it was clicked and shrink
 * back to it on exit. Escape and a backdrop click both close it, and the
 * closing tween is awaited before unmounting so the card is never seen to
 * vanish mid-flight.
 */
export function Lightbox({
  src, alt, from, onClose,
}: {
  src: string
  alt: string
  /** The thumbnail's bounding rect, for the grow-from-here transition. */
  from: DOMRect | null
  onClose: () => void
}) {
  const backdropRef = useRef<HTMLDivElement>(null)
  const figureRef = useRef<HTMLImageElement>(null)
  const closing = useRef(false)

  useLayoutEffect(() => {
    const backdrop = backdropRef.current
    const figure = figureRef.current
    if (!backdrop || !figure) return

    if (!canAnimate()) {
      gsap.set(backdrop, { opacity: 1 })
      gsap.set(figure, { opacity: 1, scale: 1, x: 0, y: 0 })
      return
    }

    gsap.fromTo(backdrop, { opacity: 0 }, { opacity: 1, duration: 0.28, ease: 'power2.out' })

    if (from) {
      // Translate/scale the final position back onto the thumbnail, then play
      // it forward — cheaper and smoother than animating width/height.
      const to = figure.getBoundingClientRect()
      gsap.fromTo(figure,
        {
          x: from.left + from.width / 2 - (to.left + to.width / 2),
          y: from.top + from.height / 2 - (to.top + to.height / 2),
          scale: from.width / to.width,
          opacity: 0.6,
        },
        { x: 0, y: 0, scale: 1, opacity: 1, duration: 0.42, ease: 'power3.out' },
      )
    } else {
      gsap.fromTo(figure, { opacity: 0, scale: 0.92 },
        { opacity: 1, scale: 1, duration: 0.34, ease: 'power3.out' })
    }
  }, [from])

  const close = () => {
    if (closing.current) return
    closing.current = true
    const backdrop = backdropRef.current
    const figure = figureRef.current

    if (!canAnimate() || !backdrop || !figure) { onClose(); return }

    gsap.to(backdrop, { opacity: 0, duration: 0.24, ease: 'power2.in' })
    const target = from
      ? (() => {
          const to = figure.getBoundingClientRect()
          return {
            x: from.left + from.width / 2 - (to.left + to.width / 2),
            y: from.top + from.height / 2 - (to.top + to.height / 2),
            scale: from.width / to.width,
          }
        })()
      : { scale: 0.92 }

    gsap.to(figure, {
      ...target, opacity: 0, duration: 0.3, ease: 'power3.in', onComplete: onClose,
    })
  }

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); close() }
    }
    window.addEventListener('keydown', onKey)
    // The page behind must not scroll while this is open.
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = previous
    }
  })

  return createPortal(
    <div
      className="lightbox"
      ref={backdropRef}
      onClick={close}
      role="dialog"
      aria-modal="true"
      aria-label={alt}
    >
      <img
        ref={figureRef}
        src={src}
        alt={alt}
        // Clicks on the card itself must not fall through to the backdrop.
        onClick={(e) => e.stopPropagation()}
      />
      <button className="lightbox-close" onClick={close} aria-label="Close">✕</button>
    </div>,
    document.body,
  )
}
