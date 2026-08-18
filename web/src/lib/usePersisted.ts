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

/**
 * State that survives a reload, keyed in localStorage.
 *
 * View mode and image size are preferences you set once and expect to stick;
 * resetting them on every navigation is the kind of small friction that makes
 * a tool feel disposable.
 */
export function usePersisted<T>(key: string, initial: T): [T, (next: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key)
      return raw === null ? initial : (JSON.parse(raw) as T)
    } catch {
      return initial
    }
  })

  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(value))
    } catch {
      // Quota or private mode: keep it in memory for this session.
    }
  }, [key, value])

  return [value, setValue]
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
