import { useEffect, useMemo, useRef, useState } from 'react'

import type { Card } from '../lib/api'
import { announceTaken, DECK_UID_TYPE } from '../lib/cardTransfer'
import { collection, useCollection } from '../lib/collection'
import { primaryType } from '../lib/deckModel'
import { useCardFace } from '../lib/faces'
import { solidDragImage } from '../lib/useQuietDrag'
import { SIZE_KEY, useEscape, usePersisted } from '../lib/usePersisted'
import { CARD_DRAG_TYPE } from './DeckSearch'
import { Lightbox } from './Lightbox'

/** A card being looked at, and the rect it grew from. */
interface ZoomView { src: string; alt: string; from: DOMRect }

/** Tab order, matching the deck editor's grouping. */
const TYPE_ORDER = [
  'Creature', 'Planeswalker', 'Instant', 'Sorcery', 'Artifact',
  'Enchantment', 'Battle', 'Land', 'Other',
]

/**
 * One card in the tray.
 *
 * Draggable by default and a *move*: dragging a card into a deck takes it out
 * of the tray, because the tray is a holding area and a card that has found
 * its deck has left. Holding shift makes it a copy — the same card can go to
 * three decks without being fetched three times.
 */
function TrayCard({
  card, onZoom, onDragState, landedInside,
}: {
  card: Card
  onZoom: (view: ZoomView) => void
  onDragState: (dragging: boolean) => void
  /** Set by the tray when it — or its bin — took the drop itself. */
  landedInside: React.MutableRefObject<boolean>
}) {
  const face = useCardFace(card)
  /** Whether shift was down at the moment the drag began. Read again at the
   *  end, because the drop is what decides whether the card leaves. */
  const copying = useRef(false)

  return (
    <div
      className="tray-card"
      draggable
      onDragStart={(event) => {
        copying.current = event.shiftKey
        landedInside.current = false
        // Both types: the custom one carries the card, and text/plain means a
        // drop anywhere else pastes a usable decklist line.
        event.dataTransfer.setData(CARD_DRAG_TYPE, JSON.stringify(card))
        event.dataTransfer.setData('text/plain', `1 ${card.name}`)
        event.dataTransfer.effectAllowed = event.shiftKey ? 'copy' : 'move'
        solidDragImage(event, event.currentTarget as HTMLElement)
        onDragState(true)
      }}
      onDragEnd={(event) => {
        onDragState(false)
        /* Handed over: it landed somewhere outside the tray and was not a
         * copy, so the tray gives it up.
         *
         * `landedInside` is what stops a card being destroyed by being picked
         * up and put down again — the tray accepts its own drop, which used to
         * read as a successful hand-off and delete the card. Rearranging
         * inside the tray is not leaving it, and the bin is the only thing in
         * here that removes anything. `dropEffect` of 'none' means the drag
         * was abandoned entirely. */
        if (
          !copying.current
          && !landedInside.current
          && event.dataTransfer.dropEffect !== 'none'
        ) {
          collection.remove(card.oracle_id)
        }
      }}
      title={`${card.name} — drag to a deck, shift-drag to keep a copy`}
    >
      {face.src
        ? <img src={face.src} alt={face.faceName} loading="lazy" draggable={false} />
        : <div className="tray-fallback">{card.name}</div>}

      <button
        className="tray-info"
        title={`Look at ${card.name}`}
        aria-label={`Look at ${card.name}`}
        onClick={(event) => {
          event.stopPropagation()
          const tile = (event.currentTarget as HTMLElement).closest('.tray-card')
          if (face.src && tile) {
            onZoom({ src: face.src, alt: face.faceName, from: tile.getBoundingClientRect() })
          }
        }}
      >
        i
      </button>
    </div>
  )
}

/**
 * The Cards tray.
 *
 * Collected cards used to be a page you navigated to, which meant leaving
 * whatever you were doing to look at the pile you had gathered *while* doing
 * it. As a tray it slides out of the banner over the top of the work instead,
 * so cards can be dragged straight from it into the deck you are still
 * looking at.
 *
 * Lives in the layout rather than in a route, because it has to be able to
 * open over any page.
 */
export function CardTray({ open, onClose }: { open: boolean; onClose: () => void }) {
  const cards = useCollection()
  const [size, setSize] = usePersisted(SIZE_KEY, 190)
  const [zoomed, setZoomed] = useState<ZoomView | null>(null)
  /** A card is in hand. Only then is there anything for the bin to catch. */
  const [carrying, setCarrying] = useState(false)
  const [overBin, setOverBin] = useState(false)
  const [overTray, setOverTray] = useState(false)
  const [filter, setFilter] = useState<string>('all')

  /* Which types are in the tray, in the order players expect to see them, and
   * how many of each. Derived rather than fixed, so the tabs describe what is
   * actually there. */
  const present = useMemo(() => {
    const counts = new Map<string, number>()
    for (const card of cards) {
      const type = primaryType(card)
      counts.set(type, (counts.get(type) ?? 0) + 1)
    }
    return [...counts.entries()].sort((a, b) => TYPE_ORDER.indexOf(a[0]) - TYPE_ORDER.indexOf(b[0]))
  }, [cards])

  const shown = useMemo(
    () => (filter === 'all' ? cards : cards.filter((c) => primaryType(c) === filter)),
    [cards, filter],
  )

  // A tab whose cards have all been dragged away should not leave the tray
  // looking empty when it is not.
  useEffect(() => {
    if (filter !== 'all' && !present.some(([type]) => type === filter)) setFilter('all')
  }, [present, filter])
  /** The tray itself took the drop, so the card did not leave. */
  const landedInside = useRef(false)

  useEscape(onClose, open && !zoomed)

  // A drag that ends anywhere -- including outside the window -- has to clear
  // the bin, or it would be left showing over a tray with nothing in flight.
  useEffect(() => {
    if (!carrying) return
    const done = () => setCarrying(false)
    window.addEventListener('dragend', done)
    window.addEventListener('drop', done)
    return () => {
      window.removeEventListener('dragend', done)
      window.removeEventListener('drop', done)
    }
  }, [carrying])

  const takeDrop = (event: React.DragEvent) => {
    event.preventDefault()
    setOverTray(false)
    landedInside.current = true
    const payload = event.dataTransfer.getData(CARD_DRAG_TYPE)
    if (!payload) return
    try {
      collection.add(JSON.parse(payload) as Card)
    } catch { /* not ours after all */ }
    // Came out of a deck: the deck should let it go, since it is here now.
    const uid = event.dataTransfer.getData(DECK_UID_TYPE)
    if (uid) announceTaken(uid)
  }

  return (
    <>
      <div
        className={`card-tray ${open ? 'open' : ''} ${overTray ? 'taking' : ''}`}
        role="dialog"
        aria-label="Collected cards"
        aria-hidden={!open}
        onDragOver={(event) => {
          // Only claim drags carrying a card, so a decklist line dragged from
          // elsewhere still falls through to whatever is underneath.
          if (!event.dataTransfer.types.includes(CARD_DRAG_TYPE)) return
          event.preventDefault()
          event.dataTransfer.dropEffect = 'copy'
          setOverTray(true)
        }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node)) setOverTray(false)
        }}
        onDrop={takeDrop}
      >
        {/* Slim by design: the tray is for the cards, and a header with room
            to spare would be taking space from them. */}
        <div className="tray-head">
          <span className="label">Cards</span>
          <span className="mono faint">{cards.length}</span>
          {/* --fill drives the track's gradient, which is how a thumbless
              range shows how far along it is. */}
          <label className="tray-size" title="Card size">
            <input
              type="range" min={90} max={260} step={10} value={size}
              style={{ ['--fill' as string]: `${((size - 90) / 170) * 100}%` }}
              onChange={(e) => setSize(Number(e.target.value))}
              aria-label="Card image size"
            />
          </label>
          <button className="tray-close" onClick={onClose} aria-label="Close the tray">✕</button>
        </div>

        {/* Type tabs, the same shape the deck editor uses for its groups.
            Only the types actually present get a tab: a tray of six lands does
            not need to tell you it has no planeswalkers. */}
        {cards.length > 0 && (
          <div className="group-tabs tray-tabs">
            <button
              className={filter === 'all' ? 'on' : ''}
              onClick={() => setFilter('all')}
            >
              All<span className="mono faint"> {cards.length}</span>
            </button>
            {present.map(([type, n]) => (
              <button
                key={type}
                className={filter === type ? 'on' : ''}
                onClick={() => setFilter(type)}
              >
                {type}<span className="mono faint"> {n}</span>
              </button>
            ))}
          </div>
        )}

        <div className="tray-body" style={{ ['--tray-w' as string]: `${size}px` }}>
          {cards.length === 0 ? (
            <p className="faint tray-empty">
              Nothing collected. Press the + on any card, or drag one in here.
            </p>
          ) : (
            shown.map((card) => (
              <TrayCard
                key={card.oracle_id}
                card={card}
                onZoom={setZoomed}
                onDragState={setCarrying}
                landedInside={landedInside}
              />
            ))
          )}
        </div>

        {/* Only while something is in hand: a bin standing open over a tray
            you are merely reading is an invitation to an accident. */}
        {carrying && (
          <div
            className={`tray-bin ${overBin ? 'over' : ''}`}
            onDragOver={(event) => {
              event.preventDefault()
              event.stopPropagation()
              event.dataTransfer.dropEffect = 'move'
              setOverBin(true)
            }}
            onDragLeave={() => setOverBin(false)}
            onDrop={(event) => {
              // Stopped here so the tray behind does not also take it as a
              // drop and add the card straight back.
              event.preventDefault()
              event.stopPropagation()
              setOverBin(false)
              setCarrying(false)
              // The bin removes it explicitly, so dragEnd must not also treat
              // this as a hand-off and remove it a second time.
              landedInside.current = true
              const payload = event.dataTransfer.getData(CARD_DRAG_TYPE)
              if (!payload) return
              try {
                collection.remove((JSON.parse(payload) as Card).oracle_id)
              } catch { /* not ours after all */ }
            }}
            title="Drop here to remove"
            aria-hidden
          >
            🗑
          </div>
        )}
      </div>

      {zoomed && (
        <Lightbox
          src={zoomed.src}
          alt={zoomed.alt}
          from={zoomed.from}
          onClose={() => setZoomed(null)}
        />
      )}
    </>
  )
}
