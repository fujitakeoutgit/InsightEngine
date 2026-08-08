import { useRef } from 'react'

import { canAnimate, gsap } from '../lib/motion'

export type CoinFace = 'heads' | 'tails'

/**
 * The coin.
 *
 * One fixed piece of choreography, replayed identically every time: it leaps,
 * spins too fast to read, drops, and rattles twice on the way to still. Only
 * the landing rotation differs, and because the faces are two sides of a real
 * 3D disc rather than a swapped graphic, the result *is* the rotation — there
 * is no moment where the coin shows one thing and reports another. The state
 * change is committed at the apex all the same, so the label and the log
 * update behind the blur of the spin rather than after it.
 */
export function PlayCoin({
  face, onFlip,
}: {
  face: CoinFace
  onFlip: (next: CoinFace) => void
}) {
  const ref = useRef<HTMLButtonElement>(null)
  const discRef = useRef<HTMLSpanElement>(null)
  /** Accumulated rotation, so each flip carries on from the last rather than
   *  rewinding to zero. */
  const spin = useRef(0)
  const tl = useRef<gsap.core.Timeline | null>(null)

  const flip = () => {
    const next: CoinFace = Math.random() < 0.5 ? 'heads' : 'tails'
    const disc = discRef.current
    const el = ref.current

    // Heads is the face at a multiple of 360; tails is half a turn from it.
    // Land on whichever of those comes next after five full turns, so the
    // coin always stops square to the viewer showing the side it reports.
    const want = next === 'tails' ? 180 : 0
    const base = spin.current + 360 * 5
    const target = base + (((want - (base % 360)) % 360) + 360) % 360

    if (!disc || !el || !canAnimate()) {
      spin.current = target
      gsap.set(disc, { rotateX: target })
      onFlip(next)
      return
    }

    spin.current = target
    tl.current?.kill()
    const flight = gsap.timeline()
    tl.current = flight

    // Up, and back down. The spin runs across both, easing out of the throw
    // and never quite stopping until the coin has landed.
    flight
      .to(el, { y: -104, duration: 0.4, ease: 'power2.out' })
      .to(el, { y: 0, duration: 0.44, ease: 'power2.in' })
      // The rattle: two diminishing bounces and a wobble, which is what turns
      // a landing into a coin rather than an object arriving at a coordinate.
      .to(el, { y: -13, duration: 0.15, ease: 'power2.out' })
      .to(el, { y: 0, duration: 0.17, ease: 'power2.in' })
      .to(el, { y: -4, duration: 0.09, ease: 'power2.out' })
      .to(el, { y: 0, duration: 0.11, ease: 'power2.in' })

    flight.to(disc, { rotateX: target, duration: 0.94, ease: 'power1.out' }, 0)
    // A touch of tilt on the way up and off again on the way down, so it
    // tumbles through the air rather than spinning on a fixed axle.
    flight.to(disc, { rotateZ: 14, duration: 0.4, ease: 'power2.out' }, 0)
    flight.to(disc, { rotateZ: 0, duration: 0.5, ease: 'power2.inOut' }, 0.4)
    // Settles flat with a last shiver as it stops rocking.
    flight.to(disc, { rotateZ: 3, duration: 0.08 }, 0.88)
    flight.to(disc, { rotateZ: 0, duration: 0.22, ease: 'elastic.out(1, 0.35)' }, 0.96)

    // Committed at the apex, where the spin is fastest and nothing can be read.
    flight.call(() => onFlip(next), [], 0.4)
  }

  return (
    <button
      ref={ref}
      className="pt-coin"
      onClick={flip}
      title={`Coin showing ${face} — click to flip`}
      aria-label={`Coin showing ${face}`}
      aria-live="polite"
    >
      <span className="pt-coin-disc" ref={discRef} aria-hidden>
        <span className="pt-coin-side heads">✦</span>
        <span className="pt-coin-side tails">◈</span>
      </span>
    </button>
  )
}
