/** Recent searches, shown on the landing page.
 *
 * Persisted so the list survives a reload, and paired with the in-memory
 * result cache: clicking an entry restores the results outright when the cache
 * still holds them, which for a `q:` run is the difference between instant and
 * eight minutes.
 */

import { useSyncExternalStore } from 'react'

const KEY = 'insight-enigma:history'
const LIMIT = 5

export interface HistoryEntry {
  query: string
  total: number
  engine: string
  at: number
}

let entries: HistoryEntry[] = load()
const listeners = new Set<() => void>()

function load(): HistoryEntry[] {
  try {
    const raw = localStorage.getItem(KEY)
    return raw ? (JSON.parse(raw) as HistoryEntry[]) : []
  } catch {
    return []
  }
}

function commit(next: HistoryEntry[]) {
  entries = next
  try {
    localStorage.setItem(KEY, JSON.stringify(next))
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

  /** Record a completed search. Re-running a query moves it to the top. */
  record(query: string, total: number, engine: string) {
    const trimmed = query.trim()
    if (!trimmed) return
    const rest = entries.filter((e) => e.query !== trimmed)
    commit([{ query: trimmed, total, engine, at: Date.now() }, ...rest].slice(0, LIMIT))
  },

  clear() {
    commit([])
  },
}

export function useHistory(): HistoryEntry[] {
  return useSyncExternalStore(history.subscribe, history.snapshot, history.snapshot)
}
