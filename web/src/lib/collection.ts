/** The Cards tab: a scratch pile you build while browsing results.
 *
 * An external store rather than context, because the collect button lives
 * inside the results grid and must not re-render it on every change.
 */

import { useSyncExternalStore } from 'react'
import type { Card } from './api'

const KEY = 'insight-enigma:collection'
const LIMIT = 400

let cards: Card[] = load()
const listeners = new Set<() => void>()

function load(): Card[] {
  try {
    const raw = localStorage.getItem(KEY)
    return raw ? (JSON.parse(raw) as Card[]) : []
  } catch {
    return []
  }
}

function commit(next: Card[]) {
  cards = next
  try {
    localStorage.setItem(KEY, JSON.stringify(next))
  } catch {
    // Quota exceeded: keep the in-memory pile, drop persistence silently.
  }
  listeners.forEach((fn) => fn())
}

export const collection = {
  subscribe(fn: () => void) {
    listeners.add(fn)
    return () => listeners.delete(fn)
  },

  snapshot: () => cards,

  has: (oracleId: string) => cards.some((c) => c.oracle_id === oracleId),

  add(card: Card) {
    if (collection.has(card.oracle_id)) return
    commit([card, ...cards].slice(0, LIMIT))
  },

  remove(oracleId: string) {
    commit(cards.filter((c) => c.oracle_id !== oracleId))
  },

  toggle(card: Card) {
    if (collection.has(card.oracle_id)) collection.remove(card.oracle_id)
    else collection.add(card)
  },

  clear() {
    commit([])
  },
}

export function useCollection(): Card[] {
  return useSyncExternalStore(collection.subscribe, collection.snapshot, collection.snapshot)
}

export function useIsCollected(oracleId: string): boolean {
  return useSyncExternalStore(
    collection.subscribe,
    () => cards.some((c) => c.oracle_id === oracleId),
    () => false,
  )
}
