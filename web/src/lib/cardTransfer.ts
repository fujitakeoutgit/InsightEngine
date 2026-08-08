/**
 * Handing a card from the deck editor to the Cards tray.
 *
 * The two are in different trees — the tray lives in the layout so it can open
 * over any page, the editor lives in a route — so a drag between them cannot
 * be resolved by passing a callback down. The drag itself carries the entry's
 * uid, and the tray announces here what it took; the editor listens and drops
 * that entry. A tiny bus rather than a window CustomEvent so both ends are
 * typed and the subscription is a plain function to call on unmount.
 */

/** Extra drag type carried by a card dragged out of the deck editor. Its
 *  presence is also how the editor's own drop targets tell an internal move
 *  from a card arriving from somewhere else. */
export const DECK_UID_TYPE = 'application/x-insight-deck-uid'

type Listener = (uid: string) => void

const listeners = new Set<Listener>()

/** The tray took a card that came out of a deck. */
export function announceTaken(uid: string) {
  listeners.forEach((fn) => fn(uid))
}

export function onCardTaken(fn: Listener) {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}
