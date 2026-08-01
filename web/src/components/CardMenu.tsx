import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'

import { api, type Card, type SavedDeck } from '../lib/api'
import { collection, useIsCollected } from '../lib/collection'
import { canAnimate, gsap } from '../lib/motion'

/**
 * Per-card actions, wherever a card is shown.
 *
 * Opens where it was clicked and flips to stay on screen near an edge. Adding
 * sends the card to the target deck's *maybeboard*, not the main list: a card
 * you collected while browsing is a candidate, and dropping it straight into
 * the deck would silently change the deck's legality and curve.
 *
 * `onRemove` is what distinguishes the Cards page from everywhere else. There
 * the pile itself is the subject, so removing from it is a first-class action;
 * on a results grid the same card is merely passing through, so the entry
 * becomes a collect toggle instead. One meaning per menu.
 */
export function CardMenu({
  card, at, onClose, onRemove,
}: {
  card: Card
  /** Viewport coordinates of the click that opened this. */
  at: { x: number; y: number }
  onClose: () => void
  /** Only on the Cards page: drop this card from the collection. */
  onRemove?: () => void
}) {
  const held = useIsCollected(card.oracle_id)
  const navigate = useNavigate()
  const ref = useRef<HTMLDivElement>(null)
  const [decks, setDecks] = useState<SavedDeck[] | null>(null)
  const [picking, setPicking] = useState(false)
  const [note, setNote] = useState<string | null>(null)

  useEffect(() => {
    api.savedDecks().then((r) => setDecks(r.decks)).catch(() => setDecks([]))
  }, [])

  // Keep the whole menu inside the viewport rather than letting it run off the
  // bottom-right, which is exactly where the last card in a grid tends to be.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const { width, height } = el.getBoundingClientRect()
    const x = Math.min(at.x, innerWidth - width - 12)
    const y = Math.min(at.y, innerHeight - height - 12)
    el.style.left = `${Math.max(12, x)}px`
    el.style.top = `${Math.max(12, y)}px`
    if (canAnimate()) {
      gsap.fromTo(el, { opacity: 0, scale: 0.94, y: -6 },
        { opacity: 1, scale: 1, y: 0, duration: 0.22, ease: 'power3.out' })
    } else {
      gsap.set(el, { opacity: 1, scale: 1, y: 0 })
    }
  }, [at, picking, decks])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const addTo = async (deck: SavedDeck) => {
    try {
      await api.addToDeck(deck.id, card.name, 'maybeboard')
      setNote(`Added to ${deck.name}`)
      setTimeout(onClose, 900)
    } catch (err) {
      setNote(err instanceof Error ? err.message : 'Could not add')
    }
  }

  return createPortal(
    <div className="menu-backdrop" onClick={onClose} role="presentation">
      <div
        className="card-menu"
        ref={ref}
        onClick={(e) => e.stopPropagation()}
        role="menu"
        aria-label={`Actions for ${card.name}`}
      >
        <div className="menu-title">{card.name}</div>

        {note ? (
          <div className="menu-note">{note}</div>
        ) : picking ? (
          <>
            {decks === null && <div className="menu-note">Loading decks…</div>}
            {decks?.length === 0 && <div className="menu-note">No saved decks yet.</div>}
            {decks?.map((deck) => (
              <button key={deck.id} className="menu-item" onClick={() => addTo(deck)}>
                {deck.name}
                {deck.commander && <span className="faint"> · {deck.commander}</span>}
              </button>
            ))}
            <button className="menu-item back" onClick={() => setPicking(false)}>← Back</button>
          </>
        ) : (
          <>
            <button className="menu-item" onClick={() => setPicking(true)}>
              Add to deck <span className="faint">→ maybeboard</span>
            </button>
            <button className="menu-item" onClick={() => navigate(`/card/${card.oracle_id}`)}>
              Info
            </button>
            {onRemove ? (
              <button className="menu-item danger" onClick={() => { onRemove(); onClose() }}>
                Remove
              </button>
            ) : (
              <button
                className="menu-item"
                onClick={() => { collection.toggle(card); onClose() }}
              >
                {held ? 'Remove from Cards' : 'Add to Cards'}
              </button>
            )}
          </>
        )}
      </div>
    </div>,
    document.body,
  )
}
