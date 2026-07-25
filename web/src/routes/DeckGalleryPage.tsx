import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'

import { api, type SavedDeck } from '../lib/api'
import { canAnimate, gsap, splitChars } from '../lib/motion'

const COLOR_VAR: Record<string, string> = {
  W: 'var(--mana-w)', U: 'var(--mana-u)', B: 'var(--mana-b)',
  R: 'var(--mana-r)', G: 'var(--mana-g)',
}

function Pips({ identity }: { identity: string | null }) {
  const letters = (identity || '').split('').filter(Boolean)
  if (!letters.length) return <i className="pip-dot" style={{ background: 'var(--mana-c)' }} />
  return (
    <>
      {letters.map((c) => (
        <i key={c} className="pip-dot" style={{ background: COLOR_VAR[c] ?? 'var(--mana-c)' }} />
      ))}
    </>
  )
}

/**
 * The Deck Lab landing: every deck as its commander's art.
 *
 * Tiles resolve out of blur on a stagger, then track the pointer with a
 * parallax on the art and a counter-shift on the plate, so the type appears to
 * float above the illustration rather than sit on it.
 */
export function DeckGalleryPage() {
  const [decks, setDecks] = useState<SavedDeck[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const gridRef = useRef<HTMLDivElement>(null)
  const titleRef = useRef<HTMLHeadingElement>(null)
  const navigate = useNavigate()

  useEffect(() => {
    api.savedDecks()
      .then((r) => setDecks(r.decks))
      .catch(() => setError('Could not load your decks.'))
  }, [])

  useLayoutEffect(() => {
    if (!titleRef.current) return
    const chars = splitChars(titleRef.current)
    if (!canAnimate()) {
      gsap.set(chars, { opacity: 1, yPercent: 0, filter: 'none' })
      return
    }
    gsap.fromTo(chars,
      { opacity: 0, yPercent: 60, filter: 'blur(12px)' },
      { opacity: 1, yPercent: 0, filter: 'blur(0px)', duration: 0.9,
        ease: 'expo.out', stagger: { amount: 0.32 } },
    )
  }, [])

  useLayoutEffect(() => {
    if (!decks || !gridRef.current) return
    const tiles = gridRef.current.querySelectorAll('.deck-tile')
    if (!tiles.length) return
    if (!canAnimate()) {
      gsap.set(tiles, { opacity: 1, y: 0, scale: 1, filter: 'none' })
      return
    }
    gsap.fromTo(tiles,
      { opacity: 0, y: 30, scale: 0.94, filter: 'blur(14px)' },
      { opacity: 1, y: 0, scale: 1, filter: 'blur(0px)', duration: 0.85,
        ease: 'power3.out', stagger: { amount: Math.min(0.7, tiles.length * 0.06) } },
    )
  }, [decks])

  // Pointer parallax: art drifts with the cursor, plate drifts against it.
  const track = (event: React.PointerEvent<HTMLElement>) => {
    if (!canAnimate()) return
    const tile = event.currentTarget
    const rect = tile.getBoundingClientRect()
    const px = (event.clientX - rect.left) / rect.width - 0.5
    const py = (event.clientY - rect.top) / rect.height - 0.5
    tile.style.setProperty('--mx', `${(px + 0.5) * 100}%`)
    tile.style.setProperty('--my', `${(py + 0.5) * 100}%`)
    const art = tile.querySelector('.deck-tile-art')
    const plate = tile.querySelector('.deck-tile-plate')
    if (art) gsap.to(art, { x: px * 14, y: py * 14, duration: 0.6, ease: 'power3.out' })
    if (plate) gsap.to(plate, { x: px * -6, y: py * -4, duration: 0.7, ease: 'power3.out' })
  }

  const release = (event: React.PointerEvent<HTMLElement>) => {
    const tile = event.currentTarget
    gsap.to(tile.querySelectorAll('.deck-tile-art, .deck-tile-plate'), {
      x: 0, y: 0, duration: 0.7, ease: 'power3.out',
    })
  }

  return (
    <section className="shell" style={{ paddingTop: 26 }}>
      <div className="gallery-head">
        <span className="eyebrow">Deck Lab</span>
        <h1 className="display" ref={titleRef}>Your decks</h1>
        <hr className="manaline" style={{ maxWidth: 300, marginTop: 14 }} />
      </div>

      {error && <div className="notice error"><h3>Unavailable</h3><p>{error}</p></div>}

      {decks === null && !error && (
        <div className="deck-gallery" aria-hidden>
          {Array.from({ length: 4 }, (_, i) => <div className="deck-tile-skeleton" key={i} />)}
        </div>
      )}

      {decks && (
        <div className="deck-gallery" ref={gridRef}>
          {decks.map((deck) => (
            <article
              key={deck.id}
              className="deck-tile"
              onPointerMove={track}
              onPointerLeave={release}
              onClick={() => navigate(`/deck/${deck.id}`)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && navigate(`/deck/${deck.id}`)}
            >
              <div className="deck-tile-art">
                {deck.commander_art ? (
                  <img src={deck.commander_art} alt="" loading="lazy" />
                ) : (
                  <div className="deck-tile-blank" />
                )}
              </div>
              <div className="deck-tile-plate">
                <div className="row gap-1" style={{ marginBottom: 6 }}>
                  <Pips identity={deck.color_identity ?? null} />
                </div>
                <h2>{deck.name}</h2>
                <p className="mono">{deck.commander ?? 'No commander'}</p>
                <p className="mono faint meta">
                  {deck.lines ?? 0} lines · {deck.updated_at.slice(0, 10)}
                </p>
              </div>
            </article>
          ))}

          <article
            className="deck-tile deck-tile-new"
            onClick={() => navigate('/deck/new')}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && navigate('/deck/new')}
            onPointerMove={track}
            onPointerLeave={release}
          >
            <div className="deck-tile-plate new-plate">
              <span className="plus" aria-hidden>+</span>
              <p className="mono">New deck</p>
            </div>
          </article>
        </div>
      )}
    </section>
  )
}
