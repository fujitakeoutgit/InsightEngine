import { useEffect } from 'react'

/**
 * Stop the browser painting a "no drop" cursor while a card is being dragged.
 *
 * Chrome draws a red circle-and-slash over any pixel that is not a registered
 * drop target, so dragging a card from one section to another put a prohibition
 * sign under the pointer for most of the journey -- it reads as an error when
 * nothing is wrong. Marking a single container as accepting is not enough,
 * because the gaps between targets are everywhere: panel padding, the splitter,
 * the page background, the header.
 *
 * So the whole document accepts the drag, but only for as long as one of our
 * drags is actually in flight. Text fields are left alone: dropping a card onto
 * one pastes its decklist line, which is a real feature and needs the browser's
 * default behaviour intact.
 */
export function useQuietDrag() {
  useEffect(() => {
    let active = false

    const isTextField = (node: EventTarget | null) => {
      const el = node as HTMLElement | null
      if (!el || !el.tagName) return false
      return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable
    }

    const onStart = () => { active = true }
    const onEnd = () => { active = false }

    const onOver = (event: DragEvent) => {
      if (!active || isTextField(event.target)) return
      // Runs after the section and tab handlers, which have already claimed the
      // drop and set the same effect; this only covers what they did not.
      event.preventDefault()
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
    }

    const onDrop = (event: DragEvent) => {
      if (!active || isTextField(event.target)) return
      // A drop that reached the document landed on nothing. Swallow it, or the
      // browser navigates to the dragged text.
      event.preventDefault()
    }

    // Capture for start/end so they are seen no matter where the drag began.
    document.addEventListener('dragstart', onStart, true)
    document.addEventListener('dragend', onEnd, true)
    document.addEventListener('dragover', onOver)
    document.addEventListener('drop', onDrop)
    return () => {
      document.removeEventListener('dragstart', onStart, true)
      document.removeEventListener('dragend', onEnd, true)
      document.removeEventListener('dragover', onOver)
      document.removeEventListener('drop', onDrop)
    }
  }, [])
}

/**
 * Carry a solid card with the pointer for the length of a drag.
 *
 * Chrome's automatic drag image is a translucent snapshot, which over a dark
 * background leaves the card barely visible. The supported way to replace it —
 * `setDragImage` with an element of our own — turned out not to be usable:
 * Chrome rasterises that element exactly once, at the end of the dragstart
 * dispatch, from whatever it has already painted. An off-screen clone is only
 * painted if nothing disturbs layout first, and the fallback when it isn't is
 * the default ghost, chosen silently. Two unrelated bugs came out of that one
 * behaviour — a clone torn down a tick too early, and a React state update in
 * a dragstart handler reconciling a hundred rows before the snapshot was
 * taken — and neither was visible from the code.
 *
 * So the browser is no longer asked to draw anything. `setDragImage` gets a
 * transparent pixel, and a real element follows the pointer instead: ours, on
 * screen, at full opacity, under our own CSS, for as long as the drag lasts.
 * It cannot wash out and it cannot silently fall back.
 *
 * The drag itself is still a genuine HTML5 drag — same payload, same drop
 * targets, dropping onto a text field still pastes a decklist line. Only the
 * picture changed.
 */

/** Decoded at module load, long before any drag. Chrome ignores an image that
 *  has not loaded and quietly restores its own ghost, which is the entire
 *  failure mode being avoided here. */
const BLANK_PIXEL = new Image()
BLANK_PIXEL.src =
  'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'
export function solidDragImage(
  event: React.DragEvent,
  source: HTMLElement,
  /** Carry the element's own transform into the ghost. For a card that is
   *  tapped, the rotation is what the card *is* right now, so dragging an
   *  upright copy of it is wrong. Off by default because the commoner
   *  transform is the pointer tilt, which the ghost should not inherit. */
  options?: { keepTransform?: boolean },
) {
  const rect = source.getBoundingClientRect()
  const transform = getComputedStyle(source).transform
  const keep = Boolean(options?.keepTransform) && transform !== 'none'

  const card = source.cloneNode(true) as HTMLElement
  card.className = `${source.className} drag-carry`
  // The layout box, not the bounding rect. A card tapped 90 degrees reports a
  // rect with its width and height swapped, and stamping that on the clone
  // squashes it into a card-shaped box lying the wrong way.
  card.style.width = `${source.offsetWidth}px`
  card.style.height = `${source.offsetHeight}px`

  // Where in the card it was picked up, so it stays under that same point
  // rather than snapping a corner to the pointer. A rotated card is centred
  // instead: its axes no longer line up with an offset measured against the
  // upright source, and predictable beats subtly wrong.
  const ox = keep ? rect.width / 2 : event.clientX - rect.left
  const oy = keep ? rect.height / 2 : event.clientY - rect.top

  const place = (x: number, y: number) => {
    const at = `translate3d(${Math.round(x - ox)}px, ${Math.round(y - oy)}px, 0)`
    card.style.transform = keep ? `${at} ${transform}` : at
  }

  // Positioned before it is attached, or it appears at the origin for a frame
  // and flies across the screen to meet the pointer.
  place(event.clientX, event.clientY)
  document.body.appendChild(card)
  event.dataTransfer.setDragImage(BLANK_PIXEL, 0, 0)

  /* `dragover` rather than `drag`: both fire continuously, but `drag` reports
   * 0,0 for its final event, which would fling the card into the top-left
   * corner at the exact moment you let go. Capture phase, so a target that
   * stops propagation cannot strand the card mid-screen. */
  const follow = (e: DragEvent) => {
    if (e.clientX === 0 && e.clientY === 0) return
    place(e.clientX, e.clientY)
  }

  /* Torn down on whichever comes first. `dragend` on the source is the one
   * that always fires -- including for a cancelled drag -- but it cannot fire
   * if a re-render has replaced the node mid-drag, so the document-level
   * listeners are there to make a stuck card impossible rather than unlikely. */
  const done = () => {
    card.remove()
    document.removeEventListener('dragover', follow, true)
    document.removeEventListener('dragend', done, true)
    document.removeEventListener('drop', done, true)
    source.removeEventListener('dragend', done)
  }
  document.addEventListener('dragover', follow, true)
  document.addEventListener('dragend', done, true)
  document.addEventListener('drop', done, true)
  source.addEventListener('dragend', done)
}
