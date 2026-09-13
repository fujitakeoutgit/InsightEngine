import type { RecommendReport } from './api'

/**
 * What the deck page was showing, so returning from a card lands where you
 * left rather than on a reset Analysis tab.
 *
 * Recommendations are the reason this exists: they take real work to produce --
 * the AI pipeline takes minutes -- and clicking a suggestion to read it must
 * not throw the list away. Kept in memory rather than sessionStorage because a
 * full report is large and only useful while the tab is open.
 */
export interface DeckView {
  tab: 'analysis' | 'search' | 'recommendations' | 'pipeline' | 'ai'
  /** What the Recommendations tab is showing. */
  recs: RecommendReport | null
  /* What the AI tab is showing, held separately rather than in `recs` under a
     flag. The two answer different questions and take very different amounts
     of work to produce -- minutes against a second -- so one overwriting the
     other was a real loss: asking the cheap one threw away the expensive one,
     and there was no way back to it but another run. */
  aiRecs: RecommendReport | null
  aiStrategy: string | null
  activeThemes: string[]
}

const views = new Map<string, DeckView>()

/** Only a couple of decks are ever in flight; this stops it growing forever. */
const LIMIT = 4

export function rememberDeckView(deckId: string, view: DeckView) {
  views.delete(deckId)
  views.set(deckId, view)
  while (views.size > LIMIT) {
    const oldest = views.keys().next().value
    if (oldest === undefined) break
    views.delete(oldest)
  }
}

export function recallDeckView(deckId: string): DeckView | undefined {
  return views.get(deckId)
}

