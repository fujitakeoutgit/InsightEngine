/**
 * Deck sleeves: the art behind a deck's cards.
 *
 * Kept on this machine rather than on the deck, because a sleeve is how *your*
 * copy of a deck looks. The decklist is the deck — it is what you export, what
 * you paste to a friend, and what the resolver reads — and a megabyte of
 * base64 riding inside it would make every save, every analysis and every
 * export carry an image nobody asked for.
 *
 * The consequence is honest and worth knowing: sleeves do not travel with an
 * exported list, and they do not follow you to another machine. If that turns
 * out to be wanted, the fix is a sleeves table keyed by deck id, not a blob
 * inside the list.
 */

const KEY = 'insight-enigma:sleeves'

/** Bigger than this and it is not a sleeve, it is a photograph.
 *
 * localStorage is a few megabytes in total and shared with saved searches,
 * view preferences and the lesson ticks. One oversized upload could take the
 * lot, and the failure would surface somewhere else entirely. */
export const MAX_SLEEVE_BYTES = 1_500_000

type Store = Record<string, string>

function read(): Store {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}')
    return raw && typeof raw === 'object' ? (raw as Store) : {}
  } catch {
    return {}
  }
}

function write(store: Store) {
  try { localStorage.setItem(KEY, JSON.stringify(store)) } catch { /* full or private */ }
}

/** The sleeve for a deck, as a data URL, or null. */
export function sleeveFor(deckId: string | null | undefined): string | null {
  if (!deckId) return null
  return read()[deckId] ?? null
}

export function setSleeve(deckId: string, dataUrl: string) {
  write({ ...read(), [deckId]: dataUrl })
}

export function clearSleeve(deckId: string) {
  const store = read()
  delete store[deckId]
  write(store)
}

/**
 * Read a chosen file into a data URL, refusing what is not usable.
 *
 * Rejects rather than silently shrinking: quietly re-encoding someone's art at
 * a size they did not choose is a worse surprise than being told the file is
 * too big.
 */
export function readSleeveFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!file.type.startsWith('image/')) {
      reject(new Error('That is not an image.'))
      return
    }
    if (file.size > MAX_SLEEVE_BYTES) {
      reject(new Error(`Too large — keep it under ${Math.round(MAX_SLEEVE_BYTES / 1000)}KB.`))
      return
    }
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('Could not read that file.'))
    reader.onload = () => resolve(String(reader.result))
    reader.readAsDataURL(file)
  })
}
