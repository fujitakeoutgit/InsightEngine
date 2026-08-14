import { useSyncExternalStore } from 'react'

import { LESSONS, type Lesson } from './lessons'

/**
 * The running walkthrough.
 *
 * A module-level store rather than context, because the two ends of this are
 * far apart: a lesson is started from the Glossary, and the overlay that runs
 * it lives in the layout so it can survive the route changes the tour itself
 * performs. Threading a provider between them would put a tour-shaped hole in
 * a component that otherwise knows nothing about tours.
 */

interface TourState {
  lesson: Lesson | null
  index: number
}

let state: TourState = { lesson: null, index: 0 }
const listeners = new Set<() => void>()

function commit(next: TourState) {
  state = next
  listeners.forEach((fn) => fn())
}

export const tour = {
  subscribe(fn: () => void) {
    listeners.add(fn)
    return () => listeners.delete(fn)
  },

  snapshot: () => state,

  start(id: string) {
    const lesson = LESSONS.find((l) => l.id === id)
    if (lesson) commit({ lesson, index: 0 })
  },

  /** Advances, and reports whether that was the end — the caller ticks the
   *  lesson off, because finishing is the only thing that counts as done. */
  next(): 'more' | 'finished' {
    if (!state.lesson) return 'finished'
    if (state.index >= state.lesson.steps.length - 1) {
      commit({ lesson: null, index: 0 })
      return 'finished'
    }
    commit({ ...state, index: state.index + 1 })
    return 'more'
  },

  back() {
    if (!state.lesson || state.index === 0) return
    commit({ ...state, index: state.index - 1 })
  },

  stop() {
    commit({ lesson: null, index: 0 })
  },
}

export function useTour(): TourState {
  return useSyncExternalStore(tour.subscribe, tour.snapshot, tour.snapshot)
}
