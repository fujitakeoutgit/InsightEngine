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

/* Whether the drag in flight was thrown away.
 *
 * A card leaving the tray is destroyed when the drag ends, on the grounds that
 * it went somewhere. `dropEffect` used to be the evidence for that — 'none'
 * meaning abandoned — and it is not evidence at all once `useQuietDrag` is
 * mounted: that hook preventDefaults `dragover` across the whole document so
 * the cursor stops showing a prohibition sign over the gaps between drop
 * targets, and a side effect is that every drop is "allowed" and reports
 * 'move'. Let go over empty page and the tray concluded it had handed the card
 * over, and deleted it.
 *
 * So the abandonment is recorded where it is actually known. A drop that
 * reaches the document without anyone having called `preventDefault` on it is
 * a drop nothing accepted; `useQuietDrag` sees exactly that and says so here.
 *
 * A single flag rather than a subscription: one drag is in flight at a time,
 * and `drop` always precedes `dragend`. */
let abandoned = false

/** Called by the card leaving, as the drag starts. */
export function beginTransfer() { abandoned = false }

/** Called when a drop landed on nothing at all. */
export function markAbandoned() { abandoned = true }

/** Read by the card leaving, as the drag ends. */
export function wasAbandoned() { return abandoned }
