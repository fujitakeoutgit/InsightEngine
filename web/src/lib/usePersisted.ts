import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Escape closes it.
 *
 * Every overlay in the app wants this and each was writing the same four lines,
 * which is how the two newest dialogs — delete-this-deck and unsaved-changes —
 * ended up without it. Pass `false` to disarm while the overlay is closed.
 */
export function useEscape(onEscape: () => void, armed = true) {
  const latest = useRef(onEscape)
  latest.current = onEscape

  useEffect(() => {
    if (!armed) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') latest.current()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [armed])
}

/**
 * A flag that turns itself off — "✓ Copied", "Saved", "Clipboard blocked".
 *
 * Hand-rolled `setTimeout(() => setFlag(false), …)` was written four times
 * with four different durations, and the two written inline rather than in an
 * effect never cleared on unmount, so a copy on a page you immediately left
 * set state on a gone component.
 */
export function useTransient(ms = 1800): [boolean, () => void] {
  const [on, setOn] = useState(false)
  const timer = useRef<number | undefined>(undefined)

  useEffect(() => () => window.clearTimeout(timer.current), [])

  const flash = useCallback(() => {
    setOn(true)
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setOn(false), ms)
  }, [ms])

  return [on, flash]
}

/**
 * A message that clears itself, for the same reason.
 *
 * Separate from `useTransient` because the caller wants the text back, not
 * just whether something happened.
 */
export function useTransientMessage(ms = 3000): [string | null, (text: string) => void] {
  const [message, setMessage] = useState<string | null>(null)
  const timer = useRef<number | undefined>(undefined)

  useEffect(() => () => window.clearTimeout(timer.current), [])

  const say = useCallback((text: string) => {
    setMessage(text)
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setMessage(null), ms)
  }, [ms])

  return [message, say]
}

/* One key, one value, everywhere it is read.
 *
 * These hooks used to hold a private copy each, which is fine while only one
 * component names a key and wrong the moment two do. The overlay pin is read
 * by the editor, the search results and the recommendations at the same time,
 * on screen together: toggling it in one left the other two unchanged until
 * something happened to remount them — one setting showing two answers. The
 * same is true of the grouping and sort now that they reach past the deck.
 *
 * So a key has one value and a set of listeners, and a write reaches every
 * hook that named it. Whether it also reaches localStorage is a separate
 * question, and the only difference between the two hooks below. */
const shared = new Map<string, unknown>()
const listeners = new Map<string, Set<(value: unknown) => void>>()

function subscribe(key: string, fn: (value: unknown) => void) {
  let set = listeners.get(key)
  if (!set) { set = new Set(); listeners.set(key, set) }
  set.add(fn)
  return () => { set!.delete(fn) }
}

/** Whatever this key holds now: the live value, else the stored one, else the
 *  caller's default — seeded into the store so later readers agree. */
function current<T>(key: string, initial: T, persist: boolean): T {
  if (shared.has(key)) return shared.get(key) as T
  let value = initial
  if (persist) {
    try {
      const raw = localStorage.getItem(key)
      if (raw !== null) value = JSON.parse(raw) as T
    } catch {
      // Private mode or corrupt entry: the default is a fine answer.
    }
  }
  shared.set(key, value)
  return value
}

function useKeyed<T>(key: string, initial: T, persist: boolean): [T, (next: T) => void] {
  const [value, setValue] = useState<T>(() => current(key, initial, persist))

  // The default is read through a ref so a caller passing a fresh object or
  // array literal does not resubscribe on every render.
  const fallback = useRef(initial)
  fallback.current = initial

  useEffect(() => {
    // Re-key (the editor swaps keys between deck and binder): adopt what the
    // new key holds before listening for changes to it.
    setValue(current(key, fallback.current, persist))
    return subscribe(key, (next) => setValue(next as T))
  }, [key, persist])

  const set = useCallback((next: T) => {
    shared.set(key, next)
    listeners.get(key)?.forEach((fn) => fn(next))
    if (!persist) return
    try {
      localStorage.setItem(key, JSON.stringify(next))
    } catch {
      // Quota or private mode: keep it in memory for this session.
    }
  }, [key, persist])

  return [value, set]
}

/**
 * State that survives a reload, keyed in localStorage.
 *
 * View mode and image size are preferences you set once and expect to stick;
 * resetting them on every navigation is the kind of small friction that makes
 * a tool feel disposable.
 */
export function usePersisted<T>(key: string, initial: T): [T, (next: T) => void] {
  return useKeyed(key, initial, true)
}

/**
 * State shared across components for as long as the tab is open, and no longer.
 *
 * For settings that should agree with each other while you work but start from
 * their default each visit — the deck's grouping, which fragments a list into
 * headed blocks and so is something you turn on for a question rather than
 * something you want waiting for you next time.
 */
export function useShared<T>(key: string, initial: T): [T, (next: T) => void] {
  return useKeyed(key, initial, false)
}

/* Shared preference keys. The search grid and the Cards grid are the same
   surface wearing different data, so they share one view mode and one size --
   setting it in one place and finding the other unchanged is worse than not
   remembering at all. The deck editor keeps its own, being a denser grid in a
   narrower column. */
export const VIEW_KEY = 'insight-enigma:card-view'
export const SIZE_KEY = 'insight-enigma:card-size'

/* Pinned card overlays: price always shown, and quantity where a view has one.
   Deliberately one key across the search grid, the deck editor and the binder.
   The question it answers -- "what is this worth, and how many do I have" --
   is the same question in all three, and someone who wants it answered wants
   it answered everywhere rather than three times. */
export const OVERLAY_KEY = 'insight-enigma:pin-overlays'

/* Sorting, remembered.
 *
 * Two keys, because they answer different questions. The sort *type* is one
 * preference. The *direction* is one per type: name reads naturally A-Z and
 * price reads naturally dearest-first, so a single remembered direction is
 * wrong for one of them every time you switch.
 */
export const SORT_KEY = 'insight-enigma:sort'
export const SORT_DIR_KEY = 'insight-enigma:sort-dir'

/* Grouping, shared but not remembered — `useShared`, not `usePersisted`.
   The deck editor's menu is the only place it is set, and the search results
   and the recommendations follow it, because "group by type" answering
   differently in two panels side by side is not two settings, it is one
   setting that looks broken. */
export const GROUP_KEY = 'insight-enigma:group'

export type SortDir = 'asc' | 'desc'

/** The remembered direction for one sort, and a setter that records it. */
export function useSortDir(
  key: string, sort: string, fallback: SortDir = 'asc',
): [SortDir, (next: SortDir) => void] {
  const [map, setMap] = usePersisted<Record<string, SortDir>>(key, {})
  const dir = map[sort] ?? fallback
  const setDir = useCallback((next: SortDir) => {
    setMap({ ...map, [sort]: next })
  }, [map, setMap, sort])
  return [dir, setDir]
}
