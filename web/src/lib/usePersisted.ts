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
