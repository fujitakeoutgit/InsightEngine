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

/**
 * Sleeves the seeded decks arrive wearing, by deck name.
 *
 * A path rather than a data URL: these ship with the app, so there is no
 * reason to spend a megabyte of localStorage on something already on disk —
 * and no reason for a deck you never touched to occupy the store at all.
 *
 * Keyed by name because the id is assigned when the deck is seeded and
 * differs between installs, while the name is what the seed actually fixes.
 * Rename the deck and it keeps whatever sleeve you have set but loses the
 * default, which is the right answer: it is not that deck any more.
 */
const DEFAULT_SLEEVES: Record<string, string> = {
  'Land & Draw': '/sleeves/land-and-draw.png',
}

/* An explicit "no sleeve", as opposed to "never set one".
 *
 * Removing the sleeve from a deck that has a default cannot just delete the
 * entry: the default would answer the next read and the sleeve would come
 * back, which is a Remove button that does not remove. A stored empty string
 * is the record of that decision. */
const NONE = ''

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

/** Every sleeve, keyed by deck id. For backups, which have to re-key them
 *  onto whatever ids a restore hands out. */
export const allSleeves = (): Record<string, string> => read()

/**
 * The sleeve for a deck — a data URL you chose, a bundled path, or null.
 *
 * Pass the deck's name to let a seeded deck fall back to the sleeve it ships
 * with. What you set always wins over that, including setting it to nothing.
 */
export function sleeveFor(
  deckId: string | null | undefined, deckName?: string | null,
): string | null {
  if (!deckId) return null
  const stored = read()[deckId]
  if (stored !== undefined) return stored === NONE ? null : stored
  return (deckName && DEFAULT_SLEEVES[deckName]) ?? null
}

export function setSleeve(deckId: string, dataUrl: string) {
  write({ ...read(), [deckId]: dataUrl })
}

/** Take the sleeve off — including a default one, which is why this records
 *  the removal rather than forgetting the deck. */
export function clearSleeve(deckId: string) {
  write({ ...read(), [deckId]: NONE })
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
