import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'

import { isBinder } from '../lib/binder'
import { api, type SavedDeck } from '../lib/api'
import { fromResolutions, type DeckCard } from '../lib/deckModel'
import { canAnimate, gsap, splitChars } from '../lib/motion'
import { BackLink } from '../components/PageHead'
import { Playtest } from '../components/Playtest'

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
 * Playtest as a destination of its own.
 *
 * Goldfishing used to be reachable only from inside a deck: open the Deck Lab,
 * pick a deck, wait for the analysis, find the button. But wanting to draw
 * seven is its own intent, and it arrives before you have decided which deck —
 * so this asks that question first and puts you on the mat, skipping the
 * editor entirely.
 *
 * One route with two faces: no id and it is the picker, an id and it is the
 * table. The same component either way, because "which deck" is the only
 * state between them.
 */
export function PlaytestPage() {
  const { deckId } = useParams()
  const navigate = useNavigate()

  const [decks, setDecks] = useState<SavedDeck[] | null>(null)
  const [cards, setCards] = useState<DeckCard[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const titleRef = useRef<HTMLHeadingElement>(null)
  const gridRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (deckId) return
    setCards(null)
    api.savedDecks()
      // Same reason the gallery hides it: the binder is a record of what you
      // own, not a deck you would sit down and goldfish.
      .then((r) => setDecks(r.decks.filter((d) => !isBinder(d))))
      .catch(() => setError('Could not load your decks.'))
  }, [deckId])

  /* Straight to the table: load the decklist, resolve it, deal.
   *
   * The analysis round trip is what turns saved text into cards with images
   * and types, which the mat cannot do without — so it is the same work the
   * Deck Lab does, just without stopping to show you the editor on the way. */
  useEffect(() => {
    if (!deckId) return
    let cancelled = false
    setError(null)
    setCards(null)
    api.loadDeck(Number(deckId))
      .then((r) => api.analyzeDeck(r.deck.text ?? ''))
      .then((report) => { if (!cancelled) setCards(fromResolutions(report.entries)) })
      .catch(() => { if (!cancelled) setError('Could not open that deck.') })
    return () => { cancelled = true }
  }, [deckId])

  useLayoutEffect(() => {
    if (deckId || !titleRef.current) return
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
  }, [deckId])

  useLayoutEffect(() => {
    if (deckId || !decks || !gridRef.current) return
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
  }, [deckId, decks])

  // Pointer parallax, matching the Deck Lab gallery: art drifts with the
  // cursor, plate drifts against it.
  const track = (event: React.PointerEvent<HTMLElement>) => {
    if (!canAnimate()) return
    const tile = event.currentTarget
    const rect = tile.getBoundingClientRect()
    const px = (event.clientX - rect.left) / rect.width - 0.5
    const py = (event.clientY - rect.top) / rect.height - 0.5
    const art = tile.querySelector('.deck-tile-art')
    const plate = tile.querySelector('.deck-tile-plate')
    if (art) gsap.to(art, { x: px * 14, y: py * 14, duration: 0.6, ease: 'power3.out' })
    if (plate) gsap.to(plate, { x: px * -6, y: py * -4, duration: 0.7, ease: 'power3.out' })
  }

  const release = (event: React.PointerEvent<HTMLElement>) => {
    gsap.to(event.currentTarget.querySelectorAll('.deck-tile-art, .deck-tile-plate'), {
      x: 0, y: 0, duration: 0.7, ease: 'power3.out',
    })
  }

  // On the table. Closing returns to the picker rather than to the deck page:
  // you came here to play, so the way out is another game, not an editor.
  if (deckId && cards) {
    return (
      <Playtest
        deck={cards}
        gameKey={deckId}
        onClose={() => navigate('/playtest')}
      />
    )
  }

  if (deckId) {
    return (
      <section className="shell">
        <div className="page-back"><BackLink fallback="/playtest" /></div>
        {error
          ? <div className="notice error"><h3>Unavailable</h3><p>{error}</p></div>
          : <div className="row gap-2 muted"><span className="spinner" /> Shuffling up…</div>}
      </section>
    )
  }

  return (
    <section className="shell">
      <div className="page-back"><BackLink /></div>
      <div className="gallery-head">
        <span className="eyebrow">Commander</span>
        <h1 className="display" ref={titleRef}>Playtest</h1>
        <hr className="manaline" style={{ maxWidth: 300, marginTop: 14 }} />
        <p className="lede" style={{ marginTop: 14 }}>
          Pick your deck - cast your spells and practice your interaction.
        </p>
      </div>

      {error && <div className="notice error"><h3>Unavailable</h3><p>{error}</p></div>}

      {decks === null && !error && (
        <div className="deck-gallery" aria-hidden>
          {Array.from({ length: 4 }, (_, i) => <div className="deck-tile-skeleton" key={i} />)}
        </div>
      )}

      {decks && decks.length === 0 && (
        <div className="notice">
          <h3>No decks to play</h3>
          <p>Build one in the Deck Lab and it will show up here.</p>
        </div>
      )}

      {decks && decks.length > 0 && (
        <div className="deck-gallery" ref={gridRef}>
          {decks.map((deck) => (
            <article
              key={deck.id}
              className="deck-tile"
              onPointerMove={track}
              onPointerLeave={release}
              onClick={() => navigate(`/playtest/${deck.id}`)}
              role="button"
              tabIndex={0}
              aria-label={`Playtest ${deck.name}`}
              onKeyDown={(e) =>
                (e.key === 'Enter' || e.key === ' ') && navigate(`/playtest/${deck.id}`)}
            >
              <div className="deck-tile-art">
                {deck.commander_art
                  ? <img src={deck.commander_art} alt="" loading="lazy" />
                  : <div className="deck-tile-blank" />}
              </div>
              <div className="deck-tile-plate">
                <div className="row gap-1" style={{ marginBottom: 6 }}>
                  <Pips identity={deck.color_identity ?? null} />
                </div>
                <h2>{deck.name}</h2>
                <p className="mono">{deck.commander ?? 'No commander'}</p>
                {/* The same subtitle Deck Lab gives a deck, so the one deck reads
                    identically wherever it is listed. */}
                <p className="mono faint meta">
                  {deck.lines ?? 0} lines · {deck.updated_at.slice(0, 10)}
                </p>
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  )
}
