import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import type { Card } from '../lib/api'
import { collection, useIsCollected } from '../lib/collection'
import { attachTilt, dissolveIn } from '../lib/motion'
import { useCardFace } from '../lib/faces'
import { groupBareCards, sortCards } from '../lib/deckModel'
import type { GroupBy, Section, SortBy } from '../lib/deckModel'
import { solidDragImage } from '../lib/useQuietDrag'
import { CARD_DRAG_TYPE } from './DeckSearch'
import { FlipButton } from './FlipButton'
import { GroupTabs, useOpenGroup } from './GroupTabs'
import { IdentityDots, ManaCost } from './ManaCost'

function money(value: number | null) {
  return value === null || value === undefined ? '—' : `$${value.toFixed(2)}`
}

/** The two places a card found outside the deck can be put. Trash and
 *  Sideboard are absent on purpose: neither is a thing you do to a card that
 *  is not in the deck yet. */
const ADD_SECTIONS: { key: Section; label: string }[] = [
  { key: 'main', label: 'Main' },
  { key: 'maybeboard', label: 'Maybe' },
]

/** Opens a per-card menu at the click point instead of navigating. */
export type CardPick = (card: Card, at: { x: number; y: number }) => void

/**
 * The corner `+`.
 *
 * Defaults to the Cards collection, but a grid can override where a card goes
 * -- the recommendation list sends it straight to that deck's maybeboard,
 * because routing a suggestion through a queue on another page and importing
 * it back is not "adding" it.
 */
function CollectButton({
  card, onAdd, addLabel,
}: { card: Card; onAdd?: (card: Card) => void; addLabel?: string }) {
  const held = useIsCollected(card.oracle_id)
  const custom = Boolean(onAdd)
  return (
    <button
      className={`collect-btn ${!custom && held ? 'held' : ''}`}
      title={custom ? addLabel ?? 'Add' : held ? 'Remove from Cards' : 'Add to Cards'}
      aria-label={
        custom
          ? `${addLabel ?? 'Add'} — ${card.name}`
          : held ? `Remove ${card.name} from Cards` : `Add ${card.name} to Cards`
      }
      onClick={(event) => {
        // The tile is a link; collecting must not navigate.
        event.preventDefault()
        event.stopPropagation()
        if (onAdd) onAdd(card)
        else collection.toggle(card)
      }}
    >
      {!custom && held ? '✓' : '+'}
    </button>
  )
}

/**
 * The corner `⋯`.
 *
 * Separate from `onPick`, which replaces the tile's click outright. On a
 * results grid opening the card *is* the click, so the actions need a control
 * of their own rather than a hijacked one -- otherwise adding a way to reach
 * the deck costs the way to read the card.
 */
function MenuButton({
  card, onMenu, className = 'menu-btn',
}: { card: Card; onMenu: CardPick; className?: string }) {
  return (
    <button
      className={className}
      title={`More for ${card.name}`}
      aria-label={`Actions for ${card.name}`}
      aria-haspopup="menu"
      onClick={(event) => {
        event.preventDefault()
        event.stopPropagation()
        onMenu(card, { x: event.clientX, y: event.clientY })
      }}
    >
      ⋯
    </button>
  )
}

function CardTile({
  card, collectable, caption, onPick, onMenu, onAdd, addLabel, owned, onAddTo,
}: {
  card: Card
  collectable: boolean
  caption?: string
  onPick?: CardPick
  onMenu?: CardPick
  onAdd?: (card: Card) => void
  addLabel?: string
  /** Already in your binder. */
  owned?: boolean
  /** Put this card somewhere in the deck being edited. Absent everywhere
   *  there is no deck to put it in, which is most places this grid appears. */
  onAddTo?: (card: Card, section: Section) => void
}) {
  const ref = useRef<HTMLAnchorElement>(null)
  const [loaded, setLoaded] = useState(false)
  const { flippable, faceName, src: image, flip } = useCardFace(card)

  useEffect(() => {
    if (!ref.current) return
    return attachTilt(ref.current)
  }, [])

  return (
    <Link
      ref={ref}
      to={`/card/${card.oracle_id}`}
      className={owned ? "card-tile owned" : "card-tile"}
      /* Carries the card itself, so a result can be dragged into the Cards
         tray or straight onto a deck section. An anchor is draggable anyway —
         without this it would drag as a URL, which nothing here accepts. */
      draggable
      onDragStart={(event) => {
        event.dataTransfer.setData(CARD_DRAG_TYPE, JSON.stringify(card))
        event.dataTransfer.setData('text/plain', `1 ${card.name}`)
        event.dataTransfer.effectAllowed = 'copy'
        solidDragImage(event, event.currentTarget as HTMLElement)
      }}
      // With a picker attached the tile opens a menu instead of navigating;
      // Info is one of the menu's own entries, so nothing becomes unreachable.
      onClick={onPick && ((event) => {
        event.preventDefault()
        onPick(card, { x: event.clientX, y: event.clientY })
      })}
      // Only when there is something to say that the art does not. The card's
      // own name and type are printed on the image you are already looking at,
      // so a tooltip repeating them is a label that follows the pointer around.
      // Recommendation reasons are the exception -- image view has nowhere else
      // to put them.
      title={caption}
    >
      {collectable && <CollectButton card={card} onAdd={onAdd} addLabel={addLabel} />}
      {onMenu && <MenuButton card={card} onMenu={onMenu} />}
      {flippable && <FlipButton onFlip={flip} faceName={faceName} />}
      {image ? (
        <img
          src={image}
          alt={faceName}
          loading="lazy"
          draggable={false}
          decoding="async"
          className={loaded ? 'loaded' : ''}
          onLoad={() => setLoaded(true)}
        />
      ) : (
        <div className="fallback">
          <div>
            <div className="nm">{card.name}</div>
            <ManaCost cost={card.mana_cost} />
          </div>
          <div className="tl">{card.type_line}</div>
        </div>
      )}
      <span className="price mono">{money(card.usd)}</span>

      {/* Where this card can go, on the card itself.
          One `+` could only ever mean one destination, and the destination is
          half the decision: a suggestion you are sure about and one you want
          to think about are different answers. Both are on the tile you are
          already looking at, rather than a menu away.

          The tile is a link, so each button has to stop the click travelling
          up to it -- otherwise adding a card also navigates away from the
          list you were adding from. */}
      {onAddTo && (
        <div className="tile-sections">
          {ADD_SECTIONS.map(({ key, label }) => (
            <button
              key={key}
              type="button"
              title={`Add ${card.name} to the ${label.toLowerCase()}`}
              onClick={(event) => {
                event.preventDefault()
                event.stopPropagation()
                onAddTo(card, key)
              }}
            >
              {label}
            </button>
          ))}
        </div>
      )}
    </Link>
  )
}

function CardRow({
  card, onPick, onMenu,
}: { card: Card; onPick?: CardPick; onMenu?: CardPick }) {
  const navigate = useNavigate()
  const held = useIsCollected(card.oracle_id)
  return (
    <tr
      onClick={(event) =>
        onPick
          ? onPick(card, { x: event.clientX, y: event.clientY })
          : navigate(`/card/${card.oracle_id}`)
      }
    >
      <td>
        <button
          className="btn btn-ghost sm"
          title={held ? 'Remove from Cards' : 'Add to Cards'}
          onClick={(event) => {
            event.stopPropagation()
            collection.toggle(card)
          }}
        >
          {held ? '✓' : '+'}
        </button>
      </td>
      <td className="nm">
        <Link to={`/card/${card.oracle_id}`} onClick={(e) => e.stopPropagation()}>
          {card.name}
        </Link>
      </td>
      <td>
        <ManaCost cost={card.mana_cost} />
      </td>
      <td className="muted">{card.type_line}</td>
      <td>
        <IdentityDots identity={card.color_identity} />
      </td>
      <td className="muted mono">{card.set_code?.toUpperCase()}</td>
      <td className="num">{money(card.usd)}</td>
      {onMenu && (
        <td className="num">
          <MenuButton card={card} onMenu={onMenu} className="btn btn-ghost sm" />
        </td>
      )}
    </tr>
  )
}

export function CardGrid({
  cards,
  view = 'grid',
  size = 190,
  collectable = true,
  captionFor,
  onPick,
  onMenu,
  onAdd,
  addLabel,
  ownedIds,
  onAddTo,
  groupBy = 'none',
  sortBy,
  sortDir = 'asc',
}: {
  cards: Card[]
  view?: 'grid' | 'list'
  /** Minimum tile width in px, driven by the size slider. */
  size?: number
  collectable?: boolean
  /** Extra hover text per card — used to keep recommendation reasons visible
   *  in image view, where there is no room to print them. */
  captionFor?: (card: Card) => string | undefined
  /** When set, clicking a card opens a menu here rather than navigating. */
  onPick?: CardPick
  /** When set, a corner `⋯` opens a menu and the click still opens the card. */
  onMenu?: CardPick
  /** Oracle ids you already hold, marked with a thin gold edge. A set rather
   *  than a predicate so the grid does not re-scan a collection per card. */
  ownedIds?: Set<string>
  /** Overrides where the corner + sends the card. */
  onAdd?: (card: Card) => void
  addLabel?: string
  /** Put a card into the deck being edited, from the tile itself. Only the
   *  deck builder passes this; everywhere else has no deck to add to. */
  onAddTo?: (card: Card, section: Section) => void
  /** Split the grid into headed blocks, the way the deck editor does. Callers
   *  that leave this alone get one flat grid in the order they handed over —
   *  the search page's order comes from the server and is not ours to shuffle. */
  groupBy?: GroupBy
  /** Reorder before grouping. Omitted means "keep the given order". */
  sortBy?: SortBy
  sortDir?: 'asc' | 'desc'
}) {
  const container = useRef<HTMLDivElement>(null)

  /* Sort first, then group: grouping keeps each bucket in the order it was
     handed, so sorting afterwards would have to be done per bucket to mean
     the same thing. */
  const ordered = useMemo(
    () => (sortBy ? sortCards(cards, sortBy, sortDir) : cards),
    [cards, sortBy, sortDir],
  )
  const groups = useMemo(() => groupBareCards(ordered, groupBy), [ordered, groupBy])
  /** One bucket is not a grouping, it is the whole list wearing a tab. */
  const tabbed = groupBy !== 'none' && groups.length > 1
  const [openGroup, setOpenGroup] = useOpenGroup(groups)
  const shown = tabbed ? openGroup?.cards ?? [] : ordered

  // Layout effect so the reveal starts from the pre-animation state and the
  // grid is never briefly visible at full opacity first.
  useLayoutEffect(() => {
    if (!container.current) return
    const items = container.current.querySelectorAll(
      view === 'grid' ? '.card-tile' : 'tbody tr',
    )
    dissolveIn(items, { stagger: view === 'grid' ? 0.026 : 0.012 })
  }, [cards, view, groupBy, sortBy, sortDir, openGroup?.key])

  const tabs = tabbed && (
    <GroupTabs
      tabs={groups.map((group) => ({
        key: group.key, label: group.label, count: group.cards.length,
      }))}
      open={openGroup?.key}
      onOpen={setOpenGroup}
    />
  )

  if (view === 'list') {
    return (
      <div ref={container}>
        {tabs}
        <div className="scroll-x">
          <table className="card-list">
            <thead>
              <tr>
                <th />
                <th>Name</th>
                <th>Cost</th>
                <th>Type</th>
                <th>ID</th>
                <th>Set</th>
                <th style={{ textAlign: 'right' }}>USD</th>
                {onMenu && <th />}
              </tr>
            </thead>
            <tbody>
              {shown.map((card) => (
                <CardRow key={card.oracle_id} card={card} onPick={onPick} onMenu={onMenu} />
              ))}
            </tbody>
          </table>
        </div>
      </div>
    )
  }

  const tiles = shown.map((card) => (
    <CardTile
      key={card.oracle_id}
      card={card}
      collectable={collectable}
      caption={captionFor?.(card)}
      onPick={onPick}
      onMenu={onMenu}
      onAdd={onAdd}
      addLabel={addLabel}
      owned={ownedIds?.has(card.oracle_id)}
      onAddTo={onAddTo}
    />
  ))

  // Ungrouped, the grid *is* the container — the shape every caller that never
  // asked for grouping already lays out against, left exactly as it was.
  if (!tabbed) {
    return (
      <div
        className="card-grid"
        ref={container}
        style={{ ['--card-w' as string]: `${size}px` }}
      >
        {tiles}
      </div>
    )
  }

  return (
    <div ref={container}>
      {tabs}
      <div className="card-grid" style={{ ['--card-w' as string]: `${size}px` }}>
        {tiles}
      </div>
    </div>
  )
}

export function GridSkeleton({ count = 12, size = 190 }: { count?: number; size?: number }) {
  return (
    <div className="card-grid" style={{ ['--card-w' as string]: `${size}px` }} aria-hidden>
      {Array.from({ length: count }, (_, i) => (
        <div className="skeleton" key={i} />
      ))}
    </div>
  )
}
