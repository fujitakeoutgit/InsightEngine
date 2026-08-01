/** Recent searches, shown on the landing page.
 *
 * Persisted so the list survives a reload, and paired with the in-memory
 * result cache: clicking an entry restores the results outright when the cache
 * still holds them, which for a `q:` run is the difference between instant and
 * eight minutes.
 */

import { useSyncExternalStore } from 'react'

const KEY = 'insight-enigma:history'
/** How many *unlocked* searches to keep. Locked ones are kept in addition:
 *  the list evicts what you did not ask it to hold on to. */
const LIMIT = 5

export interface HistoryEntry {
  query: string
  total: number
  engine: string
  at: number
  /** Pinned: held at the top, never evicted, and kept by Clear. */
  locked?: boolean
}

let entries: HistoryEntry[] = normalise(load())
const listeners = new Set<() => void>()

function load(): HistoryEntry[] {
  try {
    const raw = localStorage.getItem(KEY)
    return raw ? (JSON.parse(raw) as HistoryEntry[]) : []
  } catch {
    return []
  }
}

/**
 * Pins first, everything else after, and only the unpinned count against the
 * limit.
 *
 * Applied here rather than in each mutator, so there is one statement of the
 * rule instead of one per verb — the version that recomputed it per mutator
 * left `toggleLock` able to produce an over-long list (unpinning a sixth entry
 * kept all six until the next search happened to trim it), and gave `load` no
 * guarantee at all about what localStorage handed back. The partition is
 * stable, so relative order within each block survives and callers can place
 * an entry by putting it at the boundary.
 */
function normalise(list: HistoryEntry[]): HistoryEntry[] {
  return [
    ...list.filter((e) => e.locked),
    ...list.filter((e) => !e.locked).slice(0, LIMIT),
  ]
}

function commit(next: HistoryEntry[]) {
  entries = normalise(next)
  try {
    localStorage.setItem(KEY, JSON.stringify(entries))
  } catch {
    /* quota: keep it in memory only */
  }
  listeners.forEach((fn) => fn())
}

export const history = {
  subscribe(fn: () => void) {
    listeners.add(fn)
    return () => listeners.delete(fn)
  },

  snapshot: () => entries,

  /** Record a completed search. Re-running a query moves it to the top of the
   *  unlocked list; re-running a locked one refreshes its numbers in place,
   *  because a pin is a position you chose and searching should not move it. */
  record(query: string, total: number, engine: string) {
    const trimmed = query.trim()
    if (!trimmed) return
    const existing = entries.find((e) => e.query === trimmed)
    const fresh: HistoryEntry = {
      query: trimmed, total, engine, at: Date.now(), locked: existing?.locked,
    }
    if (existing?.locked) {
      commit(entries.map((e) => (e.query === trimmed ? fresh : e)))
      return
    }
    // At the boundary, which normalise() reads as the head of the unpinned
    // block — the top of the recent list, below whatever is pinned.
    commit([
      ...entries.filter((e) => e.locked),
      fresh,
      ...entries.filter((e) => !e.locked && e.query !== trimmed),
    ])
  },

  /** Pin a search to the top, or release it.
   *
   * Both directions are the same splice, which is the neat part: the boundary
   * between the locked block and the rest is exactly where the entry belongs
   * either way — the end of the pins when locking, so it stacks below the ones
   * already there, and the front of the recents when releasing.
   */
  toggleLock(query: string) {
    const entry = entries.find((e) => e.query === query)
    if (!entry) return
    const moved = { ...entry, locked: !entry.locked }
    const others = entries.filter((e) => e.query !== query)
    commit([
      ...others.filter((e) => e.locked),
      moved,
      ...others.filter((e) => !e.locked),
    ])
  },

  /** Drop one entry. The list is five long and evicts from the bottom, so a
   *  single mistyped query would otherwise sit there through four more
   *  searches, and the only way to be rid of it was to discard the lot. */
  remove(query: string) {
    commit(entries.filter((e) => e.query !== query))
  },

  /** Clear keeps the pins. Locking a search is the statement that it should
   *  outlive the browsing around it, and Clear is that browsing. */
  clear() {
    commit(entries.filter((e) => e.locked))
  },
}

export function useHistory(): HistoryEntry[] {
  return useSyncExternalStore(history.subscribe, history.snapshot, history.snapshot)
}
