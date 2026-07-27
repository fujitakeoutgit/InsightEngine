import { useEffect, useState } from 'react'

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
