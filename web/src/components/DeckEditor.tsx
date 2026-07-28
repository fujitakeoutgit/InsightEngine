import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'

import type { Card } from '../lib/api'
import { collection, useCollection } from '../lib/collection'
import {
  SECTIONS, countCards, deckValue, filterCards, groupCards, sortDeckCards,
  type DeckCard, type GroupBy, type Section, type SortBy,
} from '../lib/deckModel'
import { useCardFace } from '../lib/faces'
import { attachTilt } from '../lib/motion'
import { solidDragImage, useQuietDrag } from '../lib/useQuietDrag'
import { usePersisted } from '../lib/usePersisted'
import { CARD_DRAG_TYPE } from './DeckSearch'
import { FlipButton } from './FlipButton'
import { ShuffleTriage } from './ShuffleTriage'
import { ManaCost } from './ManaCost'

const GROUPINGS: [GroupBy, string][] = [
  ['type', 'Type'], ['cmc', 'Mana value'], ['color', 'Colour'],
  ['rarity', 'Rarity'], ['none', 'None'],
]

/** The three editable sections, as tabs. Commander is excluded deliberately —
 *  see the note where these are rendered. */
const SECTION_TABS = SECTIONS.filter((s) => s.key !== 'commander')

const SORTS: [SortBy, string][] = [
  ['name', 'Name'], ['cmc', 'Mana value'], ['price', 'Price'],
  ['rarity', 'Rarity'], ['color', 'Colour'],
]

/**
 * The deck builder.
 *
 * Sections are the drop targets, because they are the only move that means
 * anything: groups are derived from the cards themselves, so you cannot drag a
 * creature into the land group, but you can move it to the sideboard.
 */
export function DeckEditor({
  cards,
  onChange,
  onAddCard,
  onAddSearched,
}: {
  cards: DeckCard[]
  onChange: (next: DeckCard[]) => void
  onAddCard?: () => void
  /** A card dragged in from the Search tab, dropped on a section. */
  onAddSearched?: (card: Card, section: Section) => void
}) {
  const [groupBy, setGroupBy] = useState<GroupBy>('type')
  const [sortBy, setSortBy] = useState<SortBy>('name')
  const [view, setView] = usePersisted<'list' | 'grid'>('insight-enigma:deck-view', 'list')
  const [tileSize, setTileSize] = usePersisted('insight-enigma:editor-tile', 120)
  const [query, setQuery] = useState('')
  /** Which group tab is open, per section. */
  const [openGroups, setOpenGroups] = useState<Record<string, string>>({})
  const [dragging, setDragging] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<Section | null>(null)
  const [activeSection, setActiveSection] = useState<Section>("main")
  const [shuffling, setShuffling] = useState(false)
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc")
  /** Springs a hovered tab open mid-drag. */
  const springTimer = useRef<number | undefined>(undefined)
  const collected = useCollection()

  useEffect(() => () => window.clearTimeout(springTimer.current), [])

  /** Drop onto a section, whether that is its tab or its body.
   *
   * A card dragged in from the Search tab is an addition; a uid dragged from
   * another section is a move. The card is checked first, since that drag also
   * carries a text/plain fallback for dropping into other applications. */
  const onDropInto = (event: React.DragEvent, section: Section) => {
    event.preventDefault()
    window.clearTimeout(springTimer.current)
    setDropTarget(null)
    const payload = event.dataTransfer.getData(CARD_DRAG_TYPE)
    if (payload) {
      try {
        onAddSearched?.(JSON.parse(payload) as Card, section)
      } catch { /* not ours after all */ }
      return
    }
    const uid = dragging ?? event.dataTransfer.getData('text/plain')
    if (uid) move(uid, section)
    setDragging(null)
  }

  /** The open tab for a section, falling back to the first group. Editing can
   *  empty the selected group out of existence, so the stored key is only
   *  honoured while it still names a group that is there. */
  const openGroup = (section: string, groups: { key: string }[]) => {
    const chosen = openGroups[section]
    return chosen && groups.some((g) => g.key === chosen) ? chosen : groups[0]?.key
  }

  const patch = (uid: string, change: Partial<DeckCard>) =>
    onChange(cards.map((c) => (c.uid === uid ? { ...c, ...change } : c)))

  const remove = (uid: string) => onChange(cards.filter((c) => c.uid !== uid))

  const adjust = (uid: string, delta: number) => {
    const entry = cards.find((c) => c.uid === uid)
    if (!entry) return
    const next = entry.quantity + delta
    if (next <= 0) remove(uid)
    else patch(uid, { quantity: next })
  }

  const move = (uid: string, section: Section) => patch(uid, { section })

  const visible = useMemo(() => filterCards(cards, query), [cards, query])
  const totals = useMemo(() => ({
    deck: countCards(cards),
    value: deckValue(cards),
  }), [cards])

  // The "no drop" cursor is suppressed document-wide by useQuietDrag; scoping
  // it to this container was not enough, because the gaps a drag crosses are
  // everywhere -- panel padding, the splitter, the page background.
  useQuietDrag()

  /** Triage the open section: right keeps a card where it is, left sends it to
   *  the maybeboard to decide on later. */
  const shuffleCards = visible.filter((c) => c.section === activeSection)

  return (
    <div className="editor">
      {shuffling && (
        <ShuffleTriage
          cards={shuffleCards.map((c) => c.card)}
          keepLabel="Keep"
          dropLabel="Maybe"
          onClose={() => setShuffling(false)}
          onSubmit={(_kept, maybes) => {
            const moving = new Set(maybes.map((c) => c.oracle_id))
            onChange(cards.map((c) => (
              c.section === activeSection && moving.has(c.card.oracle_id)
                ? { ...c, section: 'maybeboard' as Section }
                : c
            )))
            setShuffling(false)
          }}
        />
      )}
      <div className="editor-bar">
        <input
          className="fld"
          style={{ maxWidth: 240 }}
          placeholder="Filter this deck…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Filter deck"
        />
        <select
          className="fld" style={{ width: 'auto' }}
          value={groupBy} onChange={(e) => setGroupBy(e.target.value as GroupBy)}
          aria-label="Group by"
        >
          {GROUPINGS.map(([v, l]) => <option key={v} value={v}>Group: {l}</option>)}
        </select>
        <select
          className="fld" style={{ width: 'auto' }}
          value={sortBy} onChange={(e) => setSortBy(e.target.value as SortBy)}
          aria-label="Sort by"
        >
          {SORTS.map(([v, l]) => <option key={v} value={v}>Sort: {l}</option>)}
        </select>
        {view === 'grid' && (
          <label className="size-slider" title="Card size">
            <input
              // Starts at 100, not 80: below that a card is an unreadable
              // smudge, so the bottom of the travel was dead range. Dropping it
              // spends the whole slider on sizes worth picking.
              type="range" min={100} max={300} step={10} value={tileSize}
              onChange={(e) => setTileSize(Number(e.target.value))}
              aria-label="Card image size"
            />
          </label>
        )}
        <button className="btn btn-ghost sm" onClick={() => setView(view === 'list' ? 'grid' : 'list')}>
          {view === 'list' ? 'Images' : 'List'}
        </button>
        <button
          className="btn sm"
          onClick={() => setShuffling(true)}
          disabled={!visible.some((c) => c.section === activeSection)}
          title="Go through this section one card at a time"
        >
          Shuffle
        </button>
        <span className="push mono faint" style={{ fontSize: 11 }}>
          {totals.deck} cards · ${totals.value.toFixed(2)}
        </span>
        {onAddCard && collected.length > 0 && (
          <button
            className="btn sm"
            onClick={onAddCard}
            title="Add every card from the Cards tab into this deck"
          >
            Add {collected.length} collected
          </button>
        )}
      </div>

      {/* Deck, Sideboard and Maybeboard are tabs rather than three stacked
          lists. Only one is ever the thing you are working on, and the other
          two were pushing it up the page.

          Commander is filtered out here rather than dropped from SECTIONS,
          which also drives serialize() -- removing it there would strip the
          commander out of the decklist text entirely. The analysis tab shows
          the card itself, so a one-card section earned nothing. */}
      <div className="section-tabs">
        {SECTION_TABS.map(({ key, label }) => {
          const count = cards
            .filter((c) => c.section === key)
            .reduce((n, c) => n + c.quantity, 0)
          return (
            <button
              key={key}
              className={[
                activeSection === key ? 'on' : '',
                dropTarget === key ? 'drop' : '',
              ].filter(Boolean).join(' ')}
              onClick={() => setActiveSection(key)}
              // A tab is a drop target, so a card can be moved to a section
              // without opening it first. Hovering also *springs* the tab open
              // after a beat, which is what lets you drop into a group inside
              // it rather than only onto the section as a whole.
              onDragOver={(e) => {
                e.preventDefault()
                e.dataTransfer.dropEffect = 'move'
                if (dropTarget !== key) {
                  setDropTarget(key)
                  window.clearTimeout(springTimer.current)
                  springTimer.current = window.setTimeout(() => setActiveSection(key), 550)
                }
              }}
              onDragLeave={() => {
                window.clearTimeout(springTimer.current)
                setDropTarget((t) => (t === key ? null : t))
              }}
              onDrop={(e) => onDropInto(e, key)}
            >
              {label}
              <span className="mono faint"> {count}</span>
            </button>
          )
        })}

        {/* Sort direction sits with the section it applies to, at the far end
            of the same row. The sort *field* is a dropdown in the toolbar; its
            direction is one bit and deserves one control, not a second menu. */}
        <button
          className="sort-dir push"
          onClick={() => setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))}
          title={sortDir === 'asc' ? 'Ascending — click for descending' : 'Descending — click for ascending'}
          aria-label={`Sort ${sortDir === 'asc' ? 'ascending' : 'descending'}`}
        >
          {sortDir === 'asc' ? '↑' : '↓'}
        </button>
      </div>

      <div className="sections">
        {SECTION_TABS.filter((s) => s.key === activeSection).map(({ key }) => {
          const inSection = visible.filter((c) => c.section === key)
          const groups = groupCards(sortDeckCards(inSection, sortBy, sortDir), groupBy)

          return (
            <section
              key={key}
              className={`deck-section ${dropTarget === key ? 'drop' : ''}`}
              onDragOver={(e) => {
                e.preventDefault()
                e.dataTransfer.dropEffect = 'move'
                setDropTarget(key)
              }}
              onDragLeave={() => setDropTarget((t) => (t === key ? null : t))}
              onDrop={(e) => onDropInto(e, key)}
            >
              {inSection.length === 0 ? (
                <p className="faint empty">
                  {query
                    ? 'Nothing matches the filter.'
                    : cards.length === 0
                      ? 'Empty. Paste a list in Text mode, or add the cards you have collected.'
                      : 'Drag cards here.'}
                </p>
              ) : (
                <>
                  {/* Groups become tabs rather than stacking into one long
                      scroll. Grouping is how you ask to look at one part of the
                      deck; printing all the parts underneath each other answers
                      a question nobody asked. */}
                  {groupBy !== 'none' && groups.length > 1 && (
                    <div className="group-tabs">
                      {groups.map((group) => (
                        <button
                          key={group.key}
                          className={openGroup(key, groups) === group.key ? 'on' : ''}
                          onClick={() => setOpenGroups((g) => ({ ...g, [key]: group.key }))}
                        >
                          {group.label}
                          <span className="mono faint"> {group.count}</span>
                        </button>
                      ))}
                    </div>
                  )}

                  {groups
                    .filter((group) =>
                      groupBy === 'none' || groups.length === 1 ||
                      openGroup(key, groups) === group.key)
                    .map((group) => (
                  <div className="deck-group" key={group.key}>
                    <div
                      className={view === 'grid' ? 'group-grid' : ''}
                      style={view === 'grid'
                        ? { ['--tile-w' as string]: `${tileSize}px` }
                        : undefined}
                    >
                      {group.cards.map((entry) => (
                        <EditorRow
                          key={entry.uid}
                          entry={entry}
                          view={view}
                          section={key}
                          onDragStart={() => setDragging(entry.uid)}
                          onDragEnd={() => { setDragging(null); setDropTarget(null) }}
                          onAdjust={adjust}
                          onRemove={remove}
                          onMove={move}
                        />
                      ))}
                    </div>
                  </div>
                ))}
                </>
              )}
            </section>
          )
        })}
      </div>
    </div>
  )
}

function EditorRow({
  entry, view, section, onDragStart, onDragEnd, onAdjust, onRemove, onMove,
}: {
  entry: DeckCard
  view: 'list' | 'grid'
  section: Section
  onDragStart: () => void
  onDragEnd: () => void
  onAdjust: (uid: string, delta: number) => void
  onRemove: (uid: string) => void
  onMove: (uid: string, section: Section) => void
}) {
  const card: Card = entry.card
  const tiltRef = useRef<HTMLDivElement>(null)
  const face = useCardFace(card)

  // Same pointer-tracking tilt the search grid uses, so a card behaves the
  // same way wherever you meet it.
  useEffect(() => {
    if (view !== 'grid' || !tiltRef.current) return
    return attachTilt(tiltRef.current, 6)
  }, [view])

  const dragProps = {
    draggable: true,
    onDragStart: (e: React.DragEvent) => {
      e.dataTransfer.setData('text/plain', entry.uid)
      e.dataTransfer.effectAllowed = 'move'
      solidDragImage(e, e.currentTarget as HTMLElement)
      onDragStart()
    },
    onDragEnd,
  }

  if (view === 'grid') {
    return (
      <div
        className="editor-tile"
        ref={tiltRef}
        {...dragProps}
        title={`${card.name} — ${card.type_line ?? ''}`}
      >
        {face.src ? (
          <img src={face.src} alt={face.faceName} loading="lazy" />
        ) : (
          <div className="fallback"><div className="nm">{card.name}</div></div>
        )}

        {/* Below the info control, which already owns this corner. */}
        {face.flippable && (
          <FlipButton onFlip={face.flip} faceName={face.faceName} below />
        )}

        {/* Quantity floats top-left, price bottom-right — the same corners the
            search tiles use, so the eye already knows where to look. */}
        <div className="tile-qty">
          <button onClick={() => onAdjust(entry.uid, -1)} aria-label="One fewer">▾</button>
          <span className="mono">{entry.quantity}</span>
          <button onClick={() => onAdjust(entry.uid, 1)} aria-label="One more">▴</button>
        </div>

        <span className="price mono">
          {card.usd !== null ? `$${(card.usd * entry.quantity).toFixed(2)}` : '—'}
        </span>

        <Link
          to={`/card/${card.oracle_id}`}
          className="tile-info"
          title={`Open ${card.name}`}
          aria-label={`Open ${card.name}`}
          onClick={(e) => e.stopPropagation()}
        >
          i
        </Link>

        <div className="tile-acts">
          {section !== 'sideboard' && (
            <button onClick={() => onMove(entry.uid, 'sideboard')}>Sideboard</button>
          )}
          {section !== 'maybeboard' && (
            <button onClick={() => onMove(entry.uid, 'maybeboard')}>Maybe</button>
          )}
          <button className="danger" onClick={() => onRemove(entry.uid)}>Trash</button>
        </div>
      </div>
    )
  }

  return (
    <div className="editor-row" {...dragProps}>
      <span className="grip" aria-hidden>⠿</span>
      <div className="qty">
        <button onClick={() => onAdjust(entry.uid, -1)} aria-label="One fewer">−</button>
        <span className="mono">{entry.quantity}</span>
        <button onClick={() => onAdjust(entry.uid, 1)} aria-label="One more">+</button>
      </div>
      <Link to={`/card/${card.oracle_id}`} className="nm">{card.name}</Link>
      <ManaCost cost={card.mana_cost} />
      <span className="push mono faint price">
        {card.usd !== null ? `$${(card.usd * entry.quantity).toFixed(2)}` : '—'}
      </span>
      <button
        className="row-act" title="Add to Cards"
        onClick={() => collection.add(card)}
      >
        +
      </button>
      <button className="row-act danger" title="Remove" onClick={() => onRemove(entry.uid)}>
        ✕
      </button>
    </div>
  )
}
