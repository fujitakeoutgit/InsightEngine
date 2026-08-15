import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'

import { api, type Card } from '../lib/api'
import { DECK_UID_TYPE, onCardTaken } from '../lib/cardTransfer'
import { collection } from '../lib/collection'
import { BINDER_SECTIONS } from '../lib/binder'
import {
  SECTIONS, canBeCommander, countCards, deckValue, filterCards, groupCards, sortDeckCards,
  type DeckCard, type GroupBy, type Section, type SortBy,
} from '../lib/deckModel'
import { useCardFace } from '../lib/faces'
import { attachTilt } from '../lib/motion'
import { solidDragImage, useQuietDrag } from '../lib/useQuietDrag'
import { OVERLAY_KEY, usePersisted } from '../lib/usePersisted'
import { CARD_DRAG_TYPE } from './DeckSearch'
import { FlipButton } from './FlipButton'
import { PrintingPicker } from './PrintingPicker'
import { ShuffleTriage } from './ShuffleTriage'
import { ManaCost } from './ManaCost'

// None first, because it is the default and a list should open on its own
// starting point rather than make you hunt to the end for it.
const GROUPINGS: [GroupBy, string][] = [
  ['none', 'None'], ['type', 'Type'], ['cmc', 'Mana value'],
  ['color', 'Colour'], ['rarity', 'Rarity'],
]

/** Every section, as tabs — Commander included. The binder has its own three,
 *  with the same keys under different names: see `BINDER_SECTIONS`. */
const SECTION_TABS = SECTIONS

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
  onAddSearched,
  binder,
  jobFiltered,
  colours,
  onColours,
}: {
  cards: DeckCard[]
  onChange: (next: DeckCard[]) => void
  /** A card dragged in from the Search tab, dropped on a section. */
  onAddSearched?: (card: Card, section: Section) => void
  /** Binder mode: Bulk / Trades / Fav in place of the deck's four, and no
   *  commander, which a binder does not have. */
  binder?: boolean
  /** The subset left by the Ramp / Removal / Counters / Draw filter, when one
   *  is set. Only what is *shown* narrows: `onChange` still edits the whole
   *  list, so filtering can never delete what it is hiding. */
  jobFiltered?: DeckCard[]
  /** Lit colours. Owned by the page rather than here, because the same filter
   *  has to narrow the list *and* the numbers beside it, and two copies of it
   *  would drift the moment one was clicked. */
  colours?: string[]
  onColours?: (next: string[]) => void
}) {
  /* Both a deck and a binder open ungrouped. Grouping fragments the list into
   * headed blocks, which is useful when you have a question about shape and in
   * the way when you are just reading what is there -- and reading what is
   * there is what opening either one is for. Type grouping is a click away.
   *
   * B4 -- the binder still opens on images, because art is how you recognise a
   * card you own without reading its name. */
  const [groupBy, setGroupBy] = useState<GroupBy>('none')
  const [sortBy, setSortBy] = useState<SortBy>('name')
  const [pinOverlay, setPinOverlay] = usePersisted<boolean>(OVERLAY_KEY, false)
  /* Bulk edit: a mode, not a gesture.
   *
   * Filing a shoebox means moving thirty cards to Trades in one go, and doing
   * that one drag at a time is the reason a binder stops getting updated. In
   * this mode a tile is a checkbox and nothing else -- the tilt, the quantity
   * steppers and the hover actions all stand down, because a tile that both
   * selects and adjusts is a tile you cannot click confidently. */
  const [bulkEdit, setBulkEdit] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const [view, setView] = usePersisted<'list' | 'grid'>(
    binder ? 'insight-enigma:binder-view' : 'insight-enigma:deck-view',
    binder ? 'grid' : 'list',
  )
  const [tileSize, setTileSize] = usePersisted('insight-enigma:editor-tile', 120)
  const [query, setQuery] = useState('')
  /** Which group tab is open, per section. */
  const [openGroups, setOpenGroups] = useState<Record<string, string>>({})
  const [dragging, setDragging] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<Section | null>(null)
  const [activeSection, setActiveSection] = useState<Section>("main")
  const sectionTabs = binder ? BINDER_SECTIONS : SECTION_TABS
  const [shuffling, setShuffling] = useState(false)
  /** The entry whose printing is being chosen, if any. */
  const [picking, setPicking] = useState<DeckCard | null>(null)

  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc")
  /** Springs a hovered tab open mid-drag. */
  const springTimer = useRef<number | undefined>(undefined)

  useEffect(() => () => window.clearTimeout(springTimer.current), [])

  /* A card dragged out to the Cards tray leaves the deck.
   *
   * The tray cannot call back down into this component -- it lives in the
   * layout so it can open over any page -- so it announces what it took and
   * this listens. Kept in a ref-free effect that re-subscribes when the deck
   * changes, because the removal has to be computed against the current list. */
  useEffect(() => onCardTaken((uid) => {
    if (cards.some((c) => c.uid === uid)) onChange(cards.filter((c) => c.uid !== uid))
  }), [cards, onChange])

  /** Drop onto a section, whether that is its tab or its body.
   *
   * A card dragged in from the Search tab is an addition; a uid dragged from
   * another section is a move. The card is checked first, since that drag also
   * carries a text/plain fallback for dropping into other applications. */
  const onDropInto = (event: React.DragEvent, section: Section) => {
    event.preventDefault()
    window.clearTimeout(springTimer.current)
    setDropTarget(null)
    /* An entry already in this deck is a move, whatever else it is carrying.
     * Checked first, because those drags now also carry the card so the Cards
     * tray can accept them — and reading that half here would turn every
     * section move into a second copy. */
    const uid = event.dataTransfer.getData(DECK_UID_TYPE) || dragging
    if (uid) {
      move(uid, section)
      setDragging(null)
      return
    }
    const payload = event.dataTransfer.getData(CARD_DRAG_TYPE)
    if (payload) {
      try {
        onAddSearched?.(JSON.parse(payload) as Card, section)
      } catch { /* not ours after all */ }
    }
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

  const shown = jobFiltered ?? cards
  const visible = useMemo(() => filterCards(shown, query), [shown, query])
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
  /* B10 — basics never reach triage.
   *
   * Shuffle asks "keep this, or think about it later?" one card at a time, and
   * nobody has ever wanted to be asked that about a Mountain. Twenty of them in
   * the queue is twenty presses between you and the cards the question is
   * actually for. */
  const shuffleCards = visible.filter(
    (c) => c.section === activeSection && !/\bBasic\b/.test(c.card.type_line ?? ''),
  )

  return (
    <div className={pinOverlay ? 'editor overlay-pinned' : 'editor'}>
      {picking && (
        <PrintingPicker
          card={picking.card}
          onClose={() => setPicking(null)}
          onPick={(printing) => {
            /* The chosen edition replaces the card on this entry, so the list
             * writes `(SET) 123` for it and the tile shows that art.
             *
             * It is also kept: the server fetches this printing from Scryfall
             * once and stores it locally, so reopening the deck puts the same
             * art back. Without that the list would still say "(NEO) 123" but
             * the resolver, which only has the mirror's single oracle row per
             * card, would hand back whichever printing that row carries.
             *
             * Not awaited. The tile updates now; the keep is bookkeeping for
             * next time, and a slow network should not hold up a click. If it
             * fails the choice simply is not durable, which is where it stood
             * before -- so there is nothing to tell the user about. */
            if (printing.scryfall_id) {
              void api.keepPrinting(printing.scryfall_id).catch(() => {})
            }
            onChange(cards.map((c) => (
              c.uid === picking.uid ? { ...c, card: printing } : c
            )))
          }}
        />
      )}
      {shuffling && (
        <ShuffleTriage
          cards={shuffleCards.map((c) => c.card)}
          /* The triage asks one question per card, and what that question is
             depends on what you are sorting. A deck asks "does this make the
             cut", so the right pile keeps and the left demotes to the
             maybeboard. A binder is not a deck being cut down -- it is a
             collection being filed -- so both piles are destinations, and the
             card lands wherever you put it. */
          keepLabel={binder ? 'Trades' : 'Keep'}
          dropLabel={binder ? 'Bulk' : 'Maybe'}
          onClose={() => setShuffling(false)}
          onSubmit={(kept, dropped) => {
            if (binder) {
              // Both piles are filed. Trades on the right, Bulk on the left,
              // and a card is moved even if it was already in that section --
              // which costs nothing and keeps the rule "the pile you put it in
              // is the tab it ends up in" true without exception.
              const toTrades = new Set(kept.map((c) => c.oracle_id))
              const toBulk = new Set(dropped.map((c) => c.oracle_id))
              onChange(cards.map((c) => {
                if (c.section !== activeSection) return c
                if (toTrades.has(c.card.oracle_id)) return { ...c, section: 'sideboard' as Section }
                if (toBulk.has(c.card.oracle_id)) return { ...c, section: 'main' as Section }
                return c
              }))
            } else {
              const moving = new Set(dropped.map((c) => c.oracle_id))
              onChange(cards.map((c) => (
                c.section === activeSection && moving.has(c.card.oracle_id)
                  ? { ...c, section: 'maybeboard' as Section }
                  : c
              )))
            }
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
        {/* B7 — grouping and sorting live together at the top of the list.
            The direction is one bit, so it stays a single button rather than
            becoming a second menu; it just sits beside the field it reverses
            instead of a row further down. */}
        {binder && (
          <button
            className="sort-dir"
            onClick={() => setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))}
            title={sortDir === 'asc' ? 'Ascending — click for descending' : 'Descending — click for ascending'}
            aria-label={`Sort ${sortDir === 'asc' ? 'ascending' : 'descending'}`}
          >
            {sortDir === 'asc' ? '↑' : '↓'}
          </button>
        )}
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
        {/* Price and quantity normally fade in on hover, so comparing two
            cards means hovering each in turn. Only meaningful over images --
            the list view prints both in columns already. */}
        {view === 'grid' && (
          <button
            className={pinOverlay ? 'btn btn-primary sm' : 'btn btn-ghost sm'}
            aria-pressed={pinOverlay}
            onClick={() => setPinOverlay(!pinOverlay)}
            title={pinOverlay
              ? 'Show price and quantity only on hover'
              : 'Always show price and quantity, without hovering'}
          >
            Toggle Overlay
          </button>
        )}
        <button
          className="btn sm"
          onClick={() => setShuffling(true)}
          disabled={!visible.some((c) => c.section === activeSection)}
          title="Go through this section one card at a time"
        >
          Shuffle
        </button>
        {binder && (
          <button
            className={bulkEdit ? 'btn btn-primary sm' : 'btn btn-ghost sm'}
            aria-pressed={bulkEdit}
            onClick={() => {
              // Leaving the mode clears the selection: a set you cannot see is
              // a set that will surprise you when you come back.
              setBulkEdit((on) => { if (on) setSelected(new Set()); return !on })
            }}
          >
            Bulk Edit
          </button>
        )}
        {binder && bulkEdit && (
          <span className="bulk-move" role="group" aria-label="Move selected cards">
            <span className="label">Move to:</span>
            {BINDER_SECTIONS.map(({ key, label }) => (
              <button
                key={key}
                className="btn btn-ghost sm"
                disabled={!selected.size}
                onClick={() => {
                  onChange(cards.map((c) => (
                    selected.has(c.uid) ? { ...c, section: key } : c
                  )))
                  // The selection survives the move, so a mis-file is one more
                  // click to correct rather than thirty. The view follows the
                  // cards, because watching them arrive is the confirmation.
                  setActiveSection(key)
                }}
              >
                {label}
              </button>
            ))}
            <span className="faint mono" style={{ fontSize: 11 }}>{selected.size} selected</span>
          </span>
        )}
        {binder && (
          <span className="colour-filter push" role="group" aria-label="Filter by colour">
            <span className="label">Colours</span>
            {(['W', 'U', 'B', 'R', 'G', 'C'] as const).map((letter) => {
              const on = (colours ?? []).includes(letter)
              return (
                <button
                  key={letter}
                  className={`colour-pip${on ? ' on' : ''}`}
                  data-c={letter}
                  aria-pressed={on}
                  title={`${on ? 'Hide' : 'Show'} ${
                    letter === 'C' ? 'colourless cards' : letter}`}
                  onClick={() => onColours?.(
                    on ? (colours ?? []).filter((x) => x !== letter) : [...(colours ?? []), letter],
                  )}
                />
              )
            })}
          </span>
        )}
        {/* `paddingRight` rather than a margin: it is `push` that pins this to
            the right edge, and the gap it needs is from the rule the bar is
            drawn with, not from the control before it. */}
        <span className={`mono faint${binder ? '' : ' push'}`} style={{ fontSize: 11, paddingRight: 6 }}>
          {totals.deck} cards · ${totals.value.toFixed(2)}
        </span>
      </div>

      {/* The sections are tabs rather than stacked lists. Only one is ever the
          thing you are working on, and the others were pushing it up the page.

          Commander used to be filtered out here on the grounds that a one-card
          section earns nothing and the analysis tab shows the card anyway.
          That was true of *reading* it and wrong about writing it: with no tab
          there was no drop target, and so no way to set or change a commander
          in this editor at all -- you had to switch to Text mode and type a
          section header, for the one card that decides the deck's colour
          identity, its legality and its gallery art. */}
      <div className="section-tabs">
        {sectionTabs.map(({ key, label }) => {
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

        {/* B7 — in the binder the direction has moved up beside the Sort
            dropdown it belongs to. A deck keeps it here, at the end of the
            section row it applies to. */}
        {!binder && (
          <button
            className="sort-dir push"
            onClick={() => setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))}
            title={sortDir === 'asc' ? 'Ascending — click for descending' : 'Descending — click for ascending'}
            aria-label={`Sort ${sortDir === 'asc' ? 'ascending' : 'descending'}`}
          >
            {sortDir === 'asc' ? '↑' : '↓'}
          </button>
        )}
      </div>

      <div className="sections">
        {sectionTabs.filter((s) => s.key === activeSection).map(({ key }) => {
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
                          binder={binder}
                          onPickPrinting={setPicking}
                          bulkEdit={bulkEdit}
                          picked={selected.has(entry.uid)}
                          onPick={() => setSelected((prev) => {
                            const next = new Set(prev)
                            if (next.has(entry.uid)) next.delete(entry.uid)
                            else next.add(entry.uid)
                            return next
                          })}
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
  binder, onPickPrinting, bulkEdit, picked, onPick,
}: {
  entry: DeckCard
  view: 'list' | 'grid'
  section: Section
  onDragStart: () => void
  onDragEnd: () => void
  onAdjust: (uid: string, delta: number) => void
  onRemove: (uid: string) => void
  onMove: (uid: string, section: Section) => void
  /** Binder mode: the tile offers Printing instead of the section moves. */
  binder?: boolean
  onPickPrinting?: (entry: DeckCard) => void
  /** Bulk edit is on: the tile is a checkbox and nothing else. */
  bulkEdit?: boolean
  picked?: boolean
  onPick?: () => void
}) {
  const card: Card = entry.card
  const tiltRef = useRef<HTMLDivElement>(null)
  const face = useCardFace(card)

  // Same pointer-tracking tilt the search grid uses, so a card behaves the
  // same way wherever you meet it.
  useEffect(() => {
    // Stiff in bulk edit. A card that leans away under the pointer reads as
    // something you are about to pick up, which is the opposite of what a
    // checkbox is doing.
    if (view !== 'grid' || bulkEdit || !tiltRef.current) return
    return attachTilt(tiltRef.current, 6)
  }, [view, bulkEdit])

  const dragProps = {
    draggable: true,
    onDragStart: (e: React.DragEvent) => {
      // Three payloads, for three destinations. The uid is what this editor's
      // own sections read to move a card between them; the card itself is what
      // the Cards tray reads; text/plain is a usable decklist line for
      // anywhere else. The uid type is also how a drop target tells "this came
      // from the deck" from "this arrived from a search".
      e.dataTransfer.setData(DECK_UID_TYPE, entry.uid)
      e.dataTransfer.setData(CARD_DRAG_TYPE, JSON.stringify(card))
      e.dataTransfer.setData('text/plain', `1 ${card.name}`)
      e.dataTransfer.effectAllowed = 'move'
      solidDragImage(e, e.currentTarget as HTMLElement)
      onDragStart()
    },
    onDragEnd,
  }

  if (view === 'grid') {
    return (
      <div
        className={`editor-tile${bulkEdit ? ' picking' : ''}${picked ? ' picked' : ''}`}
        ref={tiltRef}
        // Dragging is off while selecting: the same press cannot mean both
        // "move this card" and "tick this card".
        {...(bulkEdit ? {} : dragProps)}
        onClick={bulkEdit ? onPick : undefined}
        role={bulkEdit ? 'checkbox' : undefined}
        aria-checked={bulkEdit ? Boolean(picked) : undefined}
        tabIndex={bulkEdit ? 0 : undefined}
        onKeyDown={bulkEdit
          ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPick?.() } }
          : undefined}
        // No tooltip: the name and type are printed on the art itself.
        title={undefined}
      >
        {face.src ? (
          <img src={face.src} alt={face.faceName} loading="lazy" draggable={false} />
        ) : (
          <div className="fallback"><div className="nm">{card.name}</div></div>
        )}

        {/* The only overlay in this mode. Everything else on the tile is
            hidden by CSS rather than unmounted, so leaving the mode restores
            the tile exactly as it was. */}
        {bulkEdit && (
          <span className="tile-check" aria-hidden>{picked ? '✓' : ''}</span>
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
          draggable={false}
        >
          i
        </Link>

        <div className="tile-acts">
          {/* Printing everywhere, section moves almost nowhere.
              Commander, Sideboard and Maybe were four buttons deep on every
              tile for a move that a drag onto the tab already does, and the
              tabs are the thing that makes the destination obvious. Which
              *edition* you own has no other way to be asked, in a deck or in
              a binder, so that is the button worth the space.

              Deck survives because it is the way back: a card sitting in the
              sideboard has no tab above it that reads "put this in the deck"
              as plainly as the others read as destinations. */}
          {!binder && section !== 'main' && (
            <button onClick={() => onMove(entry.uid, 'main')}>Deck</button>
          )}
          <button onClick={() => onPickPrinting?.(entry)}>Printing</button>
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
      {/* draggable={false} as well as the stylesheet rule: an anchor is
          draggable by default, and the card name is the obvious place to grab
          a row by. Without it the browser takes the gesture and drags the
          link — its own ghost, its own payload — and the drop never reaches
          the section handler, which reads as the row refusing to move. The
          attribute is what reliably stops it; -webkit-user-drag is a
          non-standard backstop. */}
      <Link to={`/card/${card.oracle_id}`} className="nm" draggable={false}>{card.name}</Link>
      <ManaCost cost={card.mana_cost} />
      <span className="push mono faint price">
        {card.usd !== null ? `$${(card.usd * entry.quantity).toFixed(2)}` : '—'}
      </span>
      {/* List view has no hover panel, so the one move that cannot be reached
          by dragging a row onto a tab you can already see gets a control. */}
      {section === 'commander' ? (
        <button
          className="row-act" title="Move to the deck"
          aria-label={`Move ${card.name} to the deck`}
          onClick={() => onMove(entry.uid, 'main')}
        >
          ↓
        </button>
      ) : canBeCommander(card) && (
        <button
          className="row-act" title="Make this the commander"
          aria-label={`Make ${card.name} the commander`}
          onClick={() => onMove(entry.uid, 'commander')}
        >
          ♛
        </button>
      )}
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
