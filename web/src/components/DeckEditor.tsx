import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'

import type { Card } from '../lib/api'
import { collection, useCollection } from '../lib/collection'
import {
  SECTIONS, countCards, deckValue, filterCards, groupCards, sortDeckCards,
  type DeckCard, type GroupBy, type Section, type SortBy,
} from '../lib/deckModel'
import { ManaCost } from './ManaCost'

const GROUPINGS: [GroupBy, string][] = [
  ['type', 'Type'], ['cmc', 'Mana value'], ['color', 'Colour'],
  ['rarity', 'Rarity'], ['none', 'Ungrouped'],
]

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
}: {
  cards: DeckCard[]
  onChange: (next: DeckCard[]) => void
  onAddCard?: () => void
}) {
  const [groupBy, setGroupBy] = useState<GroupBy>('type')
  const [sortBy, setSortBy] = useState<SortBy>('name')
  const [view, setView] = useState<'list' | 'grid'>('list')
  const [tileSize, setTileSize] = useState(
    () => Number(localStorage.getItem('insight-enigma:editor-tile')) || 120,
  )
  const [query, setQuery] = useState('')
  const [dragging, setDragging] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<Section | null>(null)
  const collected = useCollection()

  useEffect(() => {
    localStorage.setItem('insight-enigma:editor-tile', String(tileSize))
  }, [tileSize])

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

  return (
    <div className="editor">
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
              type="range" min={80} max={220} step={10} value={tileSize}
              onChange={(e) => setTileSize(Number(e.target.value))}
              aria-label="Card image size"
            />
          </label>
        )}
        <button className="btn btn-ghost sm" onClick={() => setView(view === 'list' ? 'grid' : 'list')}>
          {view === 'list' ? 'Images' : 'List'}
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

      <div className="sections">
        {SECTIONS.map(({ key, label }) => {
          const inSection = visible.filter((c) => c.section === key)
          const count = inSection.reduce((n, c) => n + c.quantity, 0)
          const groups = groupCards(sortDeckCards(inSection, sortBy), groupBy)

          return (
            <section
              key={key}
              className={`deck-section ${dropTarget === key ? 'drop' : ''}`}
              onDragOver={(e) => { e.preventDefault(); setDropTarget(key) }}
              onDragLeave={() => setDropTarget((t) => (t === key ? null : t))}
              onDrop={(e) => {
                e.preventDefault()
                const uid = dragging ?? e.dataTransfer.getData('text/plain')
                if (uid) move(uid, key)
                setDragging(null)
                setDropTarget(null)
              }}
            >
              <header>
                <span className="label">{label}</span>
                <span className="mono faint">{count}</span>
              </header>

              {inSection.length === 0 ? (
                <p className="faint empty">
                  {query
                    ? 'Nothing matches the filter.'
                    : cards.length === 0
                      ? 'Empty. Paste a list in Text mode, or add the cards you have collected.'
                      : 'Drag cards here.'}
                </p>
              ) : (
                groups.map((group) => (
                  <div className="deck-group" key={group.key}>
                    {groupBy !== 'none' && (
                      <div className="group-head">
                        <span>{group.label}</span>
                        <span className="mono faint">{group.count}</span>
                      </div>
                    )}
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
                          onDragStart={() => setDragging(entry.uid)}
                          onDragEnd={() => { setDragging(null); setDropTarget(null) }}
                          onAdjust={adjust}
                          onRemove={remove}
                        />
                      ))}
                    </div>
                  </div>
                ))
              )}
            </section>
          )
        })}
      </div>
    </div>
  )
}

function EditorRow({
  entry, view, onDragStart, onDragEnd, onAdjust, onRemove,
}: {
  entry: DeckCard
  view: 'list' | 'grid'
  onDragStart: () => void
  onDragEnd: () => void
  onAdjust: (uid: string, delta: number) => void
  onRemove: (uid: string) => void
}) {
  const card: Card = entry.card

  const dragProps = {
    draggable: true,
    onDragStart: (e: React.DragEvent) => {
      e.dataTransfer.setData('text/plain', entry.uid)
      e.dataTransfer.effectAllowed = 'move'
      onDragStart()
    },
    onDragEnd,
  }

  if (view === 'grid') {
    return (
      <div className="editor-tile" {...dragProps} title={`${card.name} — ${card.type_line ?? ''}`}>
        {card.image_normal ? (
          <img src={card.image_normal} alt={card.name} loading="lazy" />
        ) : (
          <div className="fallback"><div className="nm">{card.name}</div></div>
        )}
        <div className="tile-qty">
          <button onClick={() => onAdjust(entry.uid, -1)} aria-label="One fewer">−</button>
          <span className="mono">{entry.quantity}</span>
          <button onClick={() => onAdjust(entry.uid, 1)} aria-label="One more">+</button>
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
