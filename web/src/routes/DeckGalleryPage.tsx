import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'

import { api, type SavedDeck } from '../lib/api'
import { canAnimate, gsap, splitChars } from '../lib/motion'
import { useTransientMessage } from '../lib/usePersisted'
import { BackLink } from '../components/PageHead'

const COLOR_VAR: Record<string, string> = {
  W: 'var(--mana-w)', U: 'var(--mana-u)', B: 'var(--mana-b)',
  R: 'var(--mana-r)', G: 'var(--mana-g)',
}

type SortBy = 'updated' | 'created' | 'name' | 'commander' | 'size'

const SORTS: [SortBy, string][] = [
  ['updated', 'Last edited'],
  ['created', 'Newest'],
  ['name', 'Name'],
  ['commander', 'Commander'],
  ['size', 'Size'],
]

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

function sortDecks(decks: SavedDeck[], by: SortBy): SavedDeck[] {
  const out = [...decks]
  switch (by) {
    // Descending: the most recent is the one you want, and for a date that is
    // the top of the list rather than the bottom.
    case 'updated': return out.sort((a, b) => b.updated_at.localeCompare(a.updated_at))
    case 'created': return out.sort((a, b) => b.created_at.localeCompare(a.created_at))
    case 'size': return out.sort((a, b) => (b.lines ?? 0) - (a.lines ?? 0))
    case 'commander':
      return out.sort((a, b) =>
        (a.commander ?? '￿').localeCompare(b.commander ?? '￿')
        || a.name.localeCompare(b.name))
    default: return out.sort((a, b) => a.name.localeCompare(b.name))
  }
}

/**
 * The Deck Lab landing: every deck as its commander's art.
 *
 * Tiles resolve out of blur on a stagger, then track the pointer with a
 * parallax on the art and a counter-shift on the plate, so the type appears to
 * float above the illustration rather than sit on it.
 *
 * Renaming, copying and deleting live here rather than inside a deck. They are
 * things you do *to* a deck, and having to open one to rename it — or to find
 * that you could not delete it at all — meant the list was the one place these
 * belonged and the one place they were missing.
 */
export function DeckGalleryPage() {
  const [decks, setDecks] = useState<SavedDeck[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const [sortBy, setSortBy] = useState<SortBy>('updated')
  /** The deck being renamed, and the draft name. */
  const [renaming, setRenaming] = useState<{ id: number; value: string } | null>(null)
  /** Deleting is two-step; this holds the deck awaiting its second click. */
  const [confirming, setConfirming] = useState<number | null>(null)
  const [busy, setBusy] = useState<number | null>(null)
  const [status, setStatus] = useTransientMessage(2600)
  const gridRef = useRef<HTMLDivElement>(null)
  const titleRef = useRef<HTMLHeadingElement>(null)
  const renameRef = useRef<HTMLInputElement>(null)
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

  const visible = useMemo(() => {
    if (!decks) return null
    const needle = filter.trim().toLowerCase()
    const matched = needle
      ? decks.filter((d) =>
          d.name.toLowerCase().includes(needle)
          || (d.commander ?? '').toLowerCase().includes(needle)
          || (d.format ?? '').toLowerCase().includes(needle))
      : decks
    return sortDecks(matched, sortBy)
  }, [decks, filter, sortBy])

  /* The reveal, on arrival and on a re-sort — but not on filtering.
   *
   * Filtering is per keystroke, and replaying an 0.85s staggered blur on every
   * one of them made the whole gallery strobe while you typed. Worse, nothing
   * killed the previous run and GSAP does not overwrite by default, so a
   * six-character filter left six tweens per tile writing `filter: blur()` to
   * the same elements every frame. Tiles that appear when a filter loosens are
   * simply visible, which is the right answer for a list you are narrowing. */
  const reveal = useRef<gsap.core.Tween | null>(null)
  useLayoutEffect(() => {
    if (!decks || !gridRef.current) return
    const tiles = gridRef.current.querySelectorAll('.deck-tile')
    if (!tiles.length) return
    reveal.current?.kill()
    if (!canAnimate()) {
      gsap.set(tiles, { opacity: 1, y: 0, scale: 1, filter: 'none' })
      return
    }
    reveal.current = gsap.fromTo(tiles,
      { opacity: 0, y: 30, scale: 0.94, filter: 'blur(14px)' },
      { opacity: 1, y: 0, scale: 1, filter: 'blur(0px)', duration: 0.85,
        ease: 'power3.out', stagger: { amount: Math.min(0.7, tiles.length * 0.06) } },
    )
  }, [decks, sortBy])

  useEffect(() => () => { reveal.current?.kill() }, [])

  useEffect(() => {
    if (renaming) renameRef.current?.select()
  }, [renaming])

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

  /** Opening the deck is the tile's job, so every control on it has to say so
   *  explicitly or a rename click navigates away mid-edit. */
  const swallow = (event: React.SyntheticEvent) => {
    event.preventDefault()
    event.stopPropagation()
  }

  const commitRename = async () => {
    if (!renaming) return
    const { id, value } = renaming
    const name = value.trim()
    const current = decks?.find((d) => d.id === id)
    setRenaming(null)
    if (!name || !current || name === current.name) return
    setBusy(id)
    try {
      const { deck } = await api.renameDeck(id, name)
      setDecks((ds) => (ds ?? []).map((d) => (d.id === id ? { ...d, ...deck } : d)))
      setStatus(`Renamed to “${deck.name}”`)
    } catch {
      setError('Could not rename that deck.')
    } finally { setBusy(null) }
  }

  const duplicate = async (deck: SavedDeck) => {
    setBusy(deck.id)
    try {
      const { deck: copy } = await api.duplicateDeck(deck.id)
      // Refetched rather than appended: the listing carries the commander art
      // and colour identity, which the save response has no reason to join in.
      const { decks: next } = await api.savedDecks()
      setDecks(next)
      setStatus(`Copied to “${copy.name}”`)
    } catch {
      setError('Could not copy that deck.')
    } finally { setBusy(null) }
  }

  const destroy = async (deck: SavedDeck) => {
    setConfirming(null)
    setBusy(deck.id)
    try {
      await api.deleteDeck(deck.id)
      setDecks((ds) => (ds ?? []).filter((d) => d.id !== deck.id))
      setStatus(`Deleted “${deck.name}”`)
    } catch {
      setError('Could not delete that deck.')
    } finally { setBusy(null) }
  }

  const open = (id: number) => {
    // A tile mid-edit is not a link. Without this, pressing Enter to commit a
    // rename would also open the deck you had just renamed.
    if (renaming || confirming !== null) return
    navigate(`/deck/${id}`)
  }

  return (
    <section className="shell">
      <div className="page-back"><BackLink /></div>
      <div className="gallery-head">
        <span className="eyebrow">Deck Lab</span>
        <h1 className="display" ref={titleRef}>Your decks</h1>
        <hr className="manaline" style={{ maxWidth: 300, marginTop: 14 }} />
      </div>

      {error && (
        <div className="notice error">
          <h3>Unavailable</h3>
          <p>{error}</p>
        </div>
      )}

      {status && (
        <p className="mono" style={{ fontSize: 12, color: 'var(--ok)', marginBottom: 12 }}>
          {status}
        </p>
      )}

      {/* Only once there is enough to sift. Two decks do not need a sort
          control, and an empty toolbar over an empty gallery is furniture. */}
      {decks && decks.length > 1 && (
        <div className="gallery-tools">
          <input
            className="fld"
            style={{ maxWidth: 260 }}
            placeholder="Filter by name, commander or format…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            aria-label="Filter decks"
          />
          <select
            className="fld"
            style={{ width: 'auto' }}
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value as SortBy)}
            aria-label="Sort decks"
          >
            {SORTS.map(([value, label]) => (
              <option key={value} value={value}>Sort: {label}</option>
            ))}
          </select>
          <span className="push mono faint" style={{ fontSize: 11 }}>
            {visible?.length ?? 0} of {decks.length}
          </span>
        </div>
      )}

      {decks === null && !error && (
        <div className="deck-gallery" aria-hidden>
          {Array.from({ length: 4 }, (_, i) => <div className="deck-tile-skeleton" key={i} />)}
        </div>
      )}

      {visible && (
        <div className="deck-gallery" ref={gridRef}>
          {visible.map((deck) => {
            const editing = renaming?.id === deck.id
            return (
              <article
                key={deck.id}
                className={`deck-tile ${busy === deck.id ? 'busy' : ''}`}
                onPointerMove={track}
                onPointerLeave={release}
                onClick={() => open(deck.id)}
                role="button"
                tabIndex={0}
                aria-label={`Open ${deck.name}`}
                onKeyDown={(e) => {
                  if (editing) return
                  if (e.key === 'Enter' || e.key === ' ') open(deck.id)
                }}
              >
                <div className="deck-tile-art">
                  {deck.commander_art ? (
                    <img src={deck.commander_art} alt="" loading="lazy" />
                  ) : (
                    <div className="deck-tile-blank" />
                  )}
                </div>

                {/* One `swallow` on the wrapper covers every button inside it:
                    the click reaches here before the tile, and stopping it here
                    stops it for all of them. */}
                <div className="deck-tile-acts" onClick={swallow}>
                  <button
                    title="Rename" aria-label={`Rename ${deck.name}`}
                    onClick={() => {
                      setConfirming(null)
                      setRenaming({ id: deck.id, value: deck.name })
                    }}
                  >
                    ✎
                  </button>
                  <button
                    title="Duplicate" aria-label={`Duplicate ${deck.name}`}
                    onClick={() => void duplicate(deck)}
                  >
                    ⧉
                  </button>
                  <button
                    className="danger"
                    title="Delete" aria-label={`Delete ${deck.name}`}
                    onClick={() => { setRenaming(null); setConfirming(deck.id) }}
                  >
                    ✕
                  </button>
                </div>

                {/* Two-step rather than a browser confirm: a deck is the only
                    copy of hours of work, and the second click should land on
                    the deck it is about rather than in a dialog that has left
                    it behind. */}
                {confirming === deck.id && (
                  <div className="deck-tile-confirm" onClick={swallow}>
                    <p>Delete “{deck.name}”?</p>
                    <p className="faint">This cannot be undone.</p>
                    <div className="row gap-2">
                      <button className="btn btn-danger sm" onClick={() => void destroy(deck)}>
                        Delete
                      </button>
                      <button className="btn btn-ghost sm" onClick={() => setConfirming(null)}>
                        Cancel
                      </button>
                    </div>
                  </div>
                )}

                <div className="deck-tile-plate">
                  <div className="row gap-1" style={{ marginBottom: 6 }}>
                    <Pips identity={deck.color_identity ?? null} />
                  </div>
                  {editing ? (
                    <input
                      ref={renameRef}
                      className="fld deck-rename"
                      value={renaming.value}
                      onClick={swallow}
                      onChange={(e) => setRenaming({ id: deck.id, value: e.target.value })}
                      onBlur={commitRename}
                      onKeyDown={(e) => {
                        e.stopPropagation()
                        if (e.key === 'Enter') { e.preventDefault(); void commitRename() }
                        if (e.key === 'Escape') { e.preventDefault(); setRenaming(null) }
                      }}
                      aria-label={`New name for ${deck.name}`}
                    />
                  ) : (
                    <h2>{deck.name}</h2>
                  )}
                  <p className="mono">{deck.commander ?? 'No commander'}</p>
                  <p className="mono faint meta">
                    {deck.lines ?? 0} lines · {deck.updated_at.slice(0, 10)}
                  </p>
                </div>
              </article>
            )
          })}

          {/* Filtering hides decks, never the way to make one. */}
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

      {visible?.length === 0 && decks && decks.length > 0 && (
        <p className="muted" style={{ fontSize: 13, marginTop: 12 }}>
          No deck matches “{filter}”.
        </p>
      )}
    </section>
  )
}
