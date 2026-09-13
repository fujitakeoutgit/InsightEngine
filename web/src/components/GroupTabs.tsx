import { useState } from 'react'

/**
 * Groups as tabs — one bucket on screen at a time.
 *
 * The deck editor has shown its groups this way over images since it had
 * groups: a hundred cards split into six headed blocks is a page you scroll
 * past rather than read, and the question grouping answers ("what are the
 * creatures here") is about one bucket at a time. The search results and the
 * recommendations are the same grids with the same problem, so they ask the
 * same way rather than inventing a second shape for it.
 */
export interface GroupTab {
  key: string
  label: string
  count: number
}

export function GroupTabs({
  tabs, open, onOpen, label = 'Groups',
}: {
  tabs: GroupTab[]
  open: string | undefined
  onOpen: (key: string) => void
  label?: string
}) {
  return (
    <div className="group-tabs" role="tablist" aria-label={label}>
      {tabs.map((tab) => (
        <button
          key={tab.key}
          role="tab"
          aria-selected={tab.key === open}
          className={tab.key === open ? 'on' : ''}
          onClick={() => onOpen(tab.key)}
        >
          {tab.label}
          <span className="mono faint"> {tab.count}</span>
        </button>
      ))}
    </div>
  )
}

/**
 * Which bucket is open, holding steady while the list underneath moves.
 *
 * The chosen key is remembered rather than the index: a new search, a changed
 * grouping or a theme filter can empty a bucket out of existence, and an index
 * would then quietly select whatever slid into that position. A key that no
 * longer names a group falls back to the first, which is the only bucket
 * guaranteed to be there.
 */
export function useOpenGroup<T extends { key: string }>(
  groups: T[],
): [T | undefined, (key: string) => void] {
  const [open, setOpen] = useState<string | null>(null)
  return [groups.find((group) => group.key === open) ?? groups[0], setOpen]
}
