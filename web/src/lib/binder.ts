import { type Section } from './deckModel'

/**
 * The Binder.
 *
 * Mechanically a deck — same model, same storage, same editor — but singular:
 * there is exactly one of it, it is never listed among your decks, and it is
 * reached by its own tab rather than by opening something.
 *
 * It is stored as an ordinary saved deck under a reserved name. That is the
 * whole trick, and it is deliberate: a second storage path would need its own
 * save, load, serialise and migrate, all to hold the same shape the deck
 * store already holds. The only cost is that the name is spoken for, which is
 * why it is unusual enough not to collide with a deck someone would name.
 */
export const BINDER_NAME = '__binder__'

/** Is this saved deck the binder? Used to keep it out of the gallery. */
export const isBinder = (deck: { name?: string | null }) => deck.name === BINDER_NAME

/**
 * The binder's sections.
 *
 * The keys are the deck model's own, unchanged, so what is written to storage
 * is a perfectly ordinary decklist and every mechanism that reads one keeps
 * working. Only the labels differ — a binder holds bulk, things you will
 * trade, and things you are keeping, which is the same three-way split a deck
 * makes between its main, its sideboard and its maybeboard.
 *
 * Commander is absent: a binder does not have one.
 */
export const BINDER_SECTIONS: { key: Section; label: string }[] = [
  { key: 'main', label: 'Bulk' },
  { key: 'sideboard', label: 'Trades' },
  { key: 'maybeboard', label: 'Fav' },
]
