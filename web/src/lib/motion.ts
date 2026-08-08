/** GSAP motion primitives shared across the app.
 *
 * House style: things arrive *out of* the page rather than sliding onto it --
 * blur and scale resolving together, staggered along the reading direction.
 * Every helper is a no-op under prefers-reduced-motion, and because each one
 * animates *to* the element's resting state, skipping the animation always
 * leaves correct final styling.
 */

import { gsap } from 'gsap'
import { ScrollTrigger } from 'gsap/ScrollTrigger'

gsap.registerPlugin(ScrollTrigger)

gsap.defaults({ ease: 'power3.out', duration: 0.7 })

export const reduced = () =>
  window.matchMedia('(prefers-reduced-motion: reduce)').matches

/**
 * Whether it is safe to run an entrance animation.
 *
 * GSAP is driven by requestAnimationFrame, which does not fire while the
 * document is hidden. An entrance tween sets its "from" state synchronously,
 * so starting one on a hidden page leaves the content at opacity 0 with
 * nothing scheduled to reveal it. In that case callers jump straight to the
 * end state: nothing is animated, but nothing is ever invisible either.
 */
export const canAnimate = () => !reduced() && document.visibilityState === 'visible'

/**
 * Wrap each character of an element in a span so it can be staggered.
 *
 * Elements marked `data-nosplit` are animated as a single unit instead. That
 * matters for gradient text: `background-clip: text` stops painting when a
 * descendant becomes `inline-block`, so a gradient word must keep its text
 * nodes intact and move as one piece.
 */
export function splitChars(el: HTMLElement): HTMLElement[] {
  if (el.dataset.split === 'true') {
    return Array.from(el.querySelectorAll<HTMLElement>('.char'))
  }
  const walk = (node: Node): Node[] => {
    if (node.nodeType === Node.ELEMENT_NODE && (node as HTMLElement).dataset?.nosplit !== undefined) {
      ;(node as HTMLElement).classList.add('char')
      return [node]
    }
    if (node.nodeType === Node.TEXT_NODE) {
      const frag = document.createDocumentFragment()
      for (const ch of node.textContent ?? '') {
        if (ch === ' ') {
          frag.appendChild(document.createTextNode(' '))
          continue
        }
        const span = document.createElement('span')
        span.className = 'char'
        span.textContent = ch
        frag.appendChild(span)
      }
      return [frag]
    }
    if (node.nodeType === Node.ELEMENT_NODE) {
      const children = Array.from(node.childNodes)
      children.forEach((child) => {
        const replacement = walk(child)
        if (replacement.length && replacement[0] !== child) {
          child.replaceWith(...replacement)
        }
      })
    }
    return [node]
  }
  walk(el)
  el.dataset.split = 'true'
  return Array.from(el.querySelectorAll<HTMLElement>('.char'))
}

/** The signature title reveal: characters resolve out of blur, bottom-up. */
export function revealTitle(el: HTMLElement | null) {
  if (!el) return
  const chars = splitChars(el)
  if (!canAnimate()) {
    gsap.set(chars, { opacity: 1, yPercent: 0, scale: 1, filter: 'none' })
    return
  }
  gsap.fromTo(
    chars,
    { opacity: 0, yPercent: 55, filter: 'blur(14px)', scale: 1.15 },
    {
      opacity: 1,
      yPercent: 0,
      filter: 'blur(0px)',
      scale: 1,
      duration: 1.1,
      ease: 'expo.out',
      stagger: { each: 0.026, from: 'start' },
    },
  )
}

/** Grid/list reveal. Used for result batches; safe to call repeatedly. */
export function dissolveIn(
  targets: Element[] | NodeListOf<Element>,
  opts?: { stagger?: number; blur?: boolean },
) {
  const items = Array.from(targets)
  if (!items.length) return
  const rest = { opacity: 1, y: 0, scale: 1, filter: 'none' }
  if (!canAnimate()) {
    gsap.set(items, rest)
    return
  }

  // Only animate what is actually on screen. The sets page renders several
  // hundred tiles at once, and animating a blur on all of them means compositing
  // hundreds of offscreen layers per frame -- which stutters, to reveal things
  // nobody is looking at. Everything below the fold goes straight to rest.
  const fold = innerHeight + 120
  const onscreen: Element[] = []
  const offscreen: Element[] = []
  for (const item of items) {
    const top = item.getBoundingClientRect().top
    ;(top < fold && top > -240 ? onscreen : offscreen).push(item)
  }
  if (offscreen.length) gsap.set(offscreen, rest)
  if (!onscreen.length) return

  // `amount` spreads the stagger across a fixed window rather than adding a
  // fixed delay per item. A Scryfall page is 175 cards, which at a per-item
  // delay would leave the last tile invisible for over four seconds.
  const per = opts?.stagger ?? 0.028
  const span = Math.min(0.85, onscreen.length * per)
  const blur = opts?.blur ?? true
  gsap.fromTo(
    onscreen,
    { opacity: 0, y: 26, scale: 0.965, ...(blur ? { filter: 'blur(10px)' } : null) },
    {
      opacity: 1,
      y: 0,
      scale: 1,
      ...(blur ? { filter: 'blur(0px)' } : null),
      duration: 0.78,
      ease: 'power3.out',
      stagger: { amount: span, from: 'start' },
      overwrite: 'auto',
    },
  )
}

/** Simple fade/rise for panels and sections. */
export function riseIn(target: Element | null, delay = 0) {
  if (!target) return
  if (!canAnimate()) {
    gsap.set(target, { opacity: 1, y: 0 })
    return
  }
  gsap.fromTo(
    target,
    { opacity: 0, y: 18 },
    { opacity: 1, y: 0, duration: 0.6, delay, ease: 'power2.out' },
  )
}

/** Reveal-on-scroll for long pages. Returns a cleanup function. */
export function revealOnScroll(selector: string, root?: Element | null) {
  if (!canAnimate()) return () => {}
  const scope = root ?? document
  const items = Array.from(scope.querySelectorAll(selector))
  const triggers = items.map((item) =>
    ScrollTrigger.create({
      trigger: item,
      start: 'top 92%',
      once: true,
      onEnter: () =>
        gsap.fromTo(
          item,
          { opacity: 0, y: 24, filter: 'blur(8px)' },
          { opacity: 1, y: 0, filter: 'blur(0px)', duration: 0.7 },
        ),
    }),
  )
  return () => triggers.forEach((t) => t.kill())
}

/**
 * Pointer-tracking tilt with a specular highlight.
 *
 * Writes --mx/--my for the CSS sheen and applies a small 3D rotation. Attached
 * per tile; detaches itself via the returned cleanup.
 */
export function attachTilt(el: HTMLElement, strength = 7) {
  if (reduced()) return () => {}

  const quickX = gsap.quickTo(el, 'rotationY', { duration: 0.5, ease: 'power3.out' })
  const quickY = gsap.quickTo(el, 'rotationX', { duration: 0.5, ease: 'power3.out' })
  const quickScale = gsap.quickTo(el, 'scale', { duration: 0.45, ease: 'power3.out' })

  const onMove = (event: PointerEvent) => {
    const rect = el.getBoundingClientRect()
    const px = (event.clientX - rect.left) / rect.width
    const py = (event.clientY - rect.top) / rect.height
    el.style.setProperty('--mx', `${px * 100}%`)
    el.style.setProperty('--my', `${py * 100}%`)
    quickX((px - 0.5) * strength * 2)
    quickY((0.5 - py) * strength * 2)
  }

  const onEnter = () => {
    gsap.set(el, { transformPerspective: 900, z: 0 })
    quickScale(1.035)
  }

  const onLeave = () => {
    quickX(0)
    quickY(0)
    quickScale(1)
  }

  el.addEventListener('pointermove', onMove)
  el.addEventListener('pointerenter', onEnter)
  el.addEventListener('pointerleave', onLeave)

  return () => {
    el.removeEventListener('pointermove', onMove)
    el.removeEventListener('pointerenter', onEnter)
    el.removeEventListener('pointerleave', onLeave)
    gsap.killTweensOf(el)
  }
}

/**
 * Route-change dissolve for the main content column.
 *
 * Opacity and blur only — never position — so it can run over the scroll
 * restoration that several pages perform on entry without fighting it. The
 * inline styles are cleared on completion because a lingering
 * `filter: blur(0px)` is still a filter, and a filtered ancestor becomes the
 * containing block for every `position: fixed` descendant — which is exactly
 * what the playtester, the shuffle overlay and the lightbox are.
 */
export function dissolvePage(el: HTMLElement | null) {
  if (!el) return
  if (!canAnimate()) {
    gsap.set(el, { clearProps: 'opacity,filter' })
    return
  }
  gsap.fromTo(
    el,
    { opacity: 0, filter: 'blur(9px)' },
    {
      opacity: 1,
      filter: 'blur(0px)',
      duration: 0.5,
      ease: 'power2.out',
      onComplete: () => gsap.set(el, { clearProps: 'opacity,filter' }),
    },
  )
}

/**
 * Magnetic hover: the element leans toward the pointer and springs home when
 * it leaves. Reserved for the few controls that carry real intent — a page's
 * primary call to action — because a surface where everything is magnetic is
 * a surface where nothing is.
 */
export function attachMagnet(el: HTMLElement, strength = 0.28) {
  if (reduced()) return () => {}

  const toX = gsap.quickTo(el, 'x', { duration: 0.5, ease: 'power3.out' })
  const toY = gsap.quickTo(el, 'y', { duration: 0.5, ease: 'power3.out' })

  const onMove = (event: PointerEvent) => {
    const rect = el.getBoundingClientRect()
    toX((event.clientX - rect.left - rect.width / 2) * strength)
    toY((event.clientY - rect.top - rect.height / 2) * strength)
  }

  const onLeave = () => {
    // A softer, springier return than the approach: letting go should feel
    // like release, not like a second cursor movement.
    gsap.to(el, { x: 0, y: 0, duration: 0.7, ease: 'elastic.out(1, 0.45)' })
  }

  el.addEventListener('pointermove', onMove)
  el.addEventListener('pointerleave', onLeave)

  return () => {
    el.removeEventListener('pointermove', onMove)
    el.removeEventListener('pointerleave', onLeave)
    gsap.killTweensOf(el)
    gsap.set(el, { x: 0, y: 0 })
  }
}

/** Count a number up. Used for result totals and deck prices. */
export function countTo(
  el: HTMLElement | null,
  value: number,
  format: (n: number) => string = (n) => Math.round(n).toLocaleString(),
) {
  if (!el) return
  if (!canAnimate()) {
    el.textContent = format(value)
    return
  }
  // Counts up to one short of the target, pauses, then ticks the last one on
  // its own. The hitch is deliberate — it reads as the number arriving rather
  // than a bar filling, and the final digit lands where the eye already is.
  const penultimate = Math.abs(value) > 1 ? value - Math.sign(value) : value
  const state = { n: Number(el.dataset.value ?? 0) }

  gsap.to(state, {
    n: penultimate,
    duration: 0.8,
    ease: 'power2.out',
    onUpdate: () => {
      el.textContent = format(state.n)
    },
    onComplete: () => {
      if (penultimate === value) {
        el.dataset.value = String(value)
        return
      }
      gsap.to(state, {
        n: value,
        duration: 0.18,
        // A full second. Long enough that the number reads as settled and the
        // last tick lands as a deliberate beat rather than a stutter.
        delay: 1,
        ease: 'back.out(3)',
        onUpdate: () => {
          el.textContent = format(state.n)
        },
        onComplete: () => {
          el.dataset.value = String(value)
        },
      })
    },
  })
}

export { gsap, ScrollTrigger }
