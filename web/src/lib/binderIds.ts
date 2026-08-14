import { useEffect, useState } from 'react'

import { api } from './api'
import { BINDER_NAME } from './binder'

/**
 * The oracle ids in your binder, for marking search results you already own.
 *
 * Fetched only when something asks to see it, because it costs a deck load and
 * an analysis, and most searches are not asking "do I have this?".
 *
 * Ids rather than names: a name can be spelled several ways and a binder line
 * can carry a printing, whereas the oracle id is what a search result and a
 * resolved decklist entry genuinely share.
 */
export function useBinderIds(enabled: boolean): Set<string> {
  const [ids, setIds] = useState<Set<string>>(() => new Set())

  useEffect(() => {
    if (!enabled) { setIds(new Set()); return }
    let cancelled = false

    ;(async () => {
      try {
        const { decks } = await api.savedDecks()
        const binder = decks.find((d) => d.name === BINDER_NAME)
        if (!binder) return
        const { deck } = await api.loadDeck(binder.id)
        const report = await api.analyzeDeck(deck.text ?? '')
        if (cancelled) return
        setIds(new Set(
          report.entries
            .map((e) => e.card?.oracle_id)
            .filter((id): id is string => Boolean(id)),
        ))
      } catch {
        // No binder, or the server is busy. Marking nothing is the right
        // failure: the results are still the results.
      }
    })()

    return () => { cancelled = true }
  }, [enabled])

  return ids
}
