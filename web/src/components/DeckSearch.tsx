import { useEffect, useRef, useState } from 'react'

import { api, type Card } from '../lib/api'
import { useCardFace } from '../lib/faces'
import { solidDragImage } from '../lib/useQuietDrag'
import { attachTilt, dissolveIn } from '../lib/motion'
import { usePersisted } from '../lib/usePersisted'
import { FlipButton } from './FlipButton'
import { ManaCost } from './ManaCost'

/** Dragging a card out of here carries this; the deck sections read it. */
export const CARD_DRAG_TYPE = 'application/x-insight-card'

/**
 * One result tile.
 *
 * A component rather than inline JSX so each tile owns the ref `attachTilt`
 * needs -- these are the same `.card-tile` as the search page, and were the one
 * place rendering them without the tilt and sheen driving `--mx`/`--my`.
 */
function SearchTile({ card }: { card: Card }) {
  const ref = useRef<HTMLDivElement>(null)
  const face = useCardFace(card)

  useEffect(() => {
    if (!ref.current) return
    return attachTilt(ref.current)
  }, [])

  return (
    <div
      className="card-tile draggable"
      ref={ref}
      draggable
      onDragStart={(e) => {
        // Both types: the custom one carries the card, and text/plain
        // means a drop anywhere else pastes a usable decklist line.
        e.dataTransfer.setData(CARD_DRAG_TYPE, JSON.stringify(card))
        e.dataTransfer.setData('text/plain', `1 ${card.name}`)
        // 'move' rather than 'copy': the browser draws a badge for the effect,
        // and a green plus over every card is noise on a drag whose whole
        // purpose is obvious.
        e.dataTransfer.effectAllowed = 'move'
        solidDragImage(e, e.currentTarget as HTMLElement)
      }}
      // No tooltip: the name and type are printed on the art itself.
      title={undefined}
    >
      {face.flippable && <FlipButton onFlip={face.flip} faceName={face.faceName} />}
      {face.src ? (
        <SearchTileImage src={face.src} alt={face.faceName} />
      ) : (
        <div className="fallback">
          <div>
            <div className="nm">{card.name}</div>
            <ManaCost cost={card.mana_cost} />
          </div>
          <div className="tl">{card.type_line}</div>
        </div>
      )}
    </div>
  )
}

/**
 * Card art inside a `.card-tile`.
 *
 * `.card-tile img` starts at opacity 0 and fades in on a `loaded` class, so an
 * `<img>` that never sets it stays invisible forever -- which is exactly what
 * these tiles did.
 */
function SearchTileImage({ src, alt }: { src: string; alt: string }) {
  const [loaded, setLoaded] = useState(false)
  return (
    <img
      src={src}
      alt={alt}
      loading="lazy"
      decoding="async"
      className={loaded ? 'loaded' : ''}
      onLoad={() => setLoaded(true)}
      // A cached image can finish before React attaches onLoad.
      ref={(el) => { if (el?.complete) setLoaded(true) }}
    />
  )
}

/**
 * Name search inside the deck editor, for pulling cards into the list.
 *
 * Deliberately not the main search page in a panel. Here you already know
 * roughly what you want and are looking it up by name, so suggestions appear
 * as you type but never run the search themselves -- Tab or a click fills the
 * box, and only Enter or the button commits. Typing a name and having results
 * churn under you on every keystroke is the behaviour this avoids.
 */
export function DeckSearch() {
  const [draft, setDraft] = useState('')
  const [names, setNames] = useState<string[]>([])
  const [highlight, setHighlight] = useState(0)
  const [open, setOpen] = useState(false)
  const [cards, setCards] = useState<Card[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [size, setSize] = usePersisted('insight-enigma:deck-search-size', 150)
  const inputRef = useRef<HTMLInputElement>(null)
  const gridRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!draft.trim()) { setNames([]); return }
    let cancelled = false
    const timer = setTimeout(async () => {
      try {
        const resp = await fetch(`/api/catalog/names?q=${encodeURIComponent(draft)}&limit=10`)
        if (!resp.ok) return
        const data = (await resp.json()) as { values: string[] }
        if (!cancelled) { setNames(data.values); setHighlight(0) }
      } catch { /* offline: typing still works */ }
    }, 140)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [draft])

  useEffect(() => {
    if (gridRef.current) dissolveIn(gridRef.current.querySelectorAll('.card-tile'), { stagger: 0.02 })
  }, [cards])

  const fill = (name: string) => {
    setDraft(name)
    setNames([])
    setOpen(false)
    inputRef.current?.focus()
  }

  const run = async (term = draft) => {
    if (!term.trim()) return
    setBusy(true)
    setError(null)
    setOpen(false)
    try {
      // Bare words match names, which is what this box is for. 175 is the
      // server's page cap and comfortably covers any one name.
      const resp = await api.search({ q: term.trim(), per_page: 175, sort: 'name' })
      setCards(resp.cards)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Search failed')
      setCards([])
    } finally {
      setBusy(false)
    }
  }

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (!names.length) return
      event.preventDefault()
      setHighlight((h) => (h + (event.key === 'ArrowDown' ? 1 : -1) + names.length) % names.length)
      return
    }
    // Tab completes without leaving the field: you are still deciding.
    if (event.key === 'Tab' && names.length && open) {
      event.preventDefault()
      fill(names[highlight] ?? draft)
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      run()
      return
    }
    if (event.key === 'Escape') { setNames([]); setOpen(false) }
  }

  return (
    <div className="deck-search stack gap-3">
      <div className="row gap-2 wrap">
        <div className="typeahead" style={{ flex: 1, minWidth: 200 }}>
          <input
            ref={inputRef}
            className="fld"
            style={{ width: '100%' }}
            value={draft}
            placeholder="Card name — Tab to complete, Enter to search"
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => { setDraft(e.target.value); setOpen(true) }}
            onFocus={() => setOpen(true)}
            onBlur={() => setTimeout(() => setOpen(false), 140)}
            onKeyDown={onKeyDown}
            aria-label="Card name"
          />
          {open && names.length > 0 && (
            <div className="ta-options">
              {names.map((name, i) => (
                <button
                  key={name}
                  className={i === highlight ? 'active' : ''}
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseEnter={() => setHighlight(i)}
                  onClick={() => fill(name)}
                >
                  {name}
                </button>
              ))}
              <div className="ta-hint mono">Tab fills · Enter searches</div>
            </div>
          )}
        </div>

        <button className="btn btn-primary sm" onClick={() => run()} disabled={busy || !draft.trim()}>
          {busy && <span className="spinner" />}Search
        </button>

        <label className="size-slider" title="Card size">
          <input
            type="range" min={100} max={300} step={10} value={size}
            onChange={(e) => setSize(Number(e.target.value))}
            aria-label="Card image size"
          />
        </label>
      </div>

      {error && <div className="notice error"><h3>Search failed</h3><p>{error}</p></div>}

      {cards === null && !error && (
        <p className="faint" style={{ fontSize: 12.5 }}>
          Search by name, then drag any result onto the deck, sideboard or maybeboard.
        </p>
      )}

      {cards?.length === 0 && !error && (
        <p className="muted" style={{ fontSize: 13 }}>Nothing matches “{draft}”.</p>
      )}

      {cards && cards.length > 0 && (
        <>
          <span className="label">{cards.length} result{cards.length === 1 ? '' : 's'} · drag to add</span>
          <div className="card-grid" ref={gridRef} style={{ ['--card-w' as string]: `${size}px` }}>
            {cards.map((card) => (
              <SearchTile key={card.oracle_id} card={card} />
            ))}
          </div>
        </>
      )}
    </div>
  )
}
