/** Client half of the search-bar spell checker.
 *
 * The browser's own checker is disabled on the query field: it does not know
 * Magic's vocabulary and it underlines every operator. This finds the words
 * worth judging, asks the server which are unknown, and produces the segments
 * the backdrop renders.
 */

const WORD_RE = /[A-Za-z][A-Za-z'’-]*/g
/** A word directly followed by one of these is an operator key, not prose. */
const OPERATOR_NEXT = /[:=<>!]/

export interface Segment {
  text: string
  bad: boolean
}

export interface FoundWord {
  word: string
  start: number
  end: number
}

/** Word runs in a query that are worth spell checking. */
export function extractWords(query: string): FoundWord[] {
  const found: FoundWord[] = []
  for (const match of query.matchAll(WORD_RE)) {
    const start = match.index ?? 0
    const end = start + match[0].length
    // `c:` / `mv<=` -- the part before the operator is a field name.
    if (OPERATOR_NEXT.test(query[end] ?? '')) continue
    if (match[0].length < 3) continue
    found.push({ word: match[0], start, end })
  }
  return found
}

/** Split the query into runs so unknown words can be underlined in place. */
export function buildSegments(query: string, unknown: Set<string>): Segment[] {
  if (!unknown.size) return [{ text: query, bad: false }]

  const words = extractWords(query).filter((w) => unknown.has(w.word.toLowerCase()))
  if (!words.length) return [{ text: query, bad: false }]

  const segments: Segment[] = []
  let cursor = 0
  for (const { start, end } of words) {
    if (start > cursor) segments.push({ text: query.slice(cursor, start), bad: false })
    segments.push({ text: query.slice(start, end), bad: true })
    cursor = end
  }
  if (cursor < query.length) segments.push({ text: query.slice(cursor), bad: false })
  return segments
}

const checked = new Map<string, boolean>()

/**
 * Ask the server which words are unknown, consulting a per-session memo first
 * so typing a long query does not re-check every word on every keystroke.
 */
export async function checkWords(words: string[]): Promise<Set<string>> {
  const lowered = [...new Set(words.map((w) => w.toLowerCase()))]
  const unresolved = lowered.filter((w) => !checked.has(w))

  if (unresolved.length) {
    try {
      const resp = await fetch('/api/spell/check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ words: unresolved }),
      })
      if (resp.ok) {
        const data = (await resp.json()) as { unknown: string[]; ready: boolean }
        if (data.ready) {
          const bad = new Set(data.unknown.map((w) => w.toLowerCase()))
          for (const word of unresolved) checked.set(word, bad.has(word))
        }
      }
    } catch {
      // Offline or server down: treat everything as spelled correctly rather
      // than underlining the whole query.
      for (const word of unresolved) checked.set(word, false)
    }
  }

  return new Set(lowered.filter((w) => checked.get(w)))
}

export async function suggestFor(word: string): Promise<string[]> {
  try {
    const resp = await fetch(`/api/spell/suggest?word=${encodeURIComponent(word)}`)
    if (!resp.ok) return []
    const data = (await resp.json()) as { suggestions: string[] }
    return data.suggestions
  } catch {
    return []
  }
}
