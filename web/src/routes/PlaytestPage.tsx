import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'

import { isBinder } from '../lib/binder'
import { DECK_GROUPS, api, groupOf, type DeckGroup, type DeckToken, type SavedDeck } from '../lib/api'
import { fromResolutions, type DeckCard } from '../lib/deckModel'
import { canAnimate, gsap } from '../lib/motion'
import { usePersisted } from '../lib/usePersisted'
import { BackLink, Chars } from '../components/PageHead'
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
  const [group, setGroup] = usePersisted<DeckGroup>('insight-engine:playtest-group', 'main')
  const shelf = useMemo(
    () => (decks ?? []).filter((d) => groupOf(d) === group),
    [decks, group],
  )
  const [tokens, setTokens] = useState<DeckToken[]>([])
  const [cards, setCards] = useState<DeckCard[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const titleRef = useRef<HTMLDivElement>(null)
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
      .then((report) => {
        if (cancelled) return
        setCards(fromResolutions(report.entries))
        // What this deck can put onto the battlefield without drawing it.
        // Already computed for the deck's analysis, so the mat costs nothing
        // extra to know about them.
        setTokens(report.stats?.tokens ?? [])
      })
      .catch(() => { if (!cancelled) setError('Could not open that deck.') })
    return () => { cancelled = true }
  }, [deckId])

  /* The letters are rendered by `Chars`, not cut out of the DOM by
   * splitChars: this page unmounts the titles the moment you pick a deck, and
   * React cannot remove a text node that something else replaced. */
  useLayoutEffect(() => {
    if (deckId) return
    const chars = titleRef.current?.querySelectorAll<HTMLElement>('.shelf-title .char')
    if (!chars?.length) return
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
        tokens={tokens}
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
      {/* The same masthead-as-selector as the Deck Lab, so a shelf is in the
          same place and the same shape in both. The page's own name moves up
          to the eyebrow — the title is answering "which decks", and the lede
          below still says what you are here to do. */}
      <div className="gallery-head">
        <span className="eyebrow">Playtest</span>
        <div className="shelf-titles" role="tablist" aria-label="Deck shelf" ref={titleRef}>
          {DECK_GROUPS.map(({ key, heading }) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={group === key}
              className={`display shelf-title${group === key ? ' on' : ''}`}
              onClick={() => setGroup(key)}
            >
              <Chars text={heading} />
            </button>
          ))}
        </div>
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

      {decks && decks.length > 0 && shelf.length === 0 && (
        <div className="notice">
          <h3>Nothing on this shelf</h3>
          <p>
            {group === 'prototype'
              ? 'Decks you are still working on appear here. Set a deck’s group to Prototype in its Text tab.'
              : 'Your finished decks appear here.'}
          </p>
        </div>
      )}

      {decks && shelf.length > 0 && (
        <div className="deck-gallery" ref={gridRef}>
          {shelf.map((deck) => (
            <article
              key={deck.id}
              className="deck-tile"
              onPointerMove={track}
              onPointerLeave={release}
              onClick={() => navigate(`/playtest/${deck.id}`, { state: { from: '/playtest' } })}
              role="button"
              tabIndex={0}
              aria-label={`Playtest ${deck.name}`}
              onKeyDown={(e) =>
                (e.key === 'Enter' || e.key === ' ') && navigate(`/playtest/${deck.id}`, { state: { from: '/playtest' } })}
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
