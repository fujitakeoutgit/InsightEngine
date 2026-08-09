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
 * Give a drag a solid picture of the card instead of the browser's washed-out
 * default.
 *
 * Chrome's automatic drag image is a translucent snapshot of the source
 * element, which over a dark background leaves the card barely visible. A clone
 * parked off-screen at full opacity is used instead, and handed to
 * setDragImage with the grab point preserved so the card stays under the
 * pointer where you picked it up.
 */
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
  const ghost = source.cloneNode(true) as HTMLElement
  ghost.style.position = 'fixed'
  // Off-screen horizontally but *within* the viewport vertically. Chrome
  // rasterises the drag image from what it has painted, and an element parked
  // at top:-10000px is outside the paint area -- it silently falls back to its
  // own translucent snapshot, which is the faded card this was meant to fix.
  ghost.style.top = '0'
  ghost.style.left = '-10000px'
  ghost.style.margin = '0'
  // The layout box, not the bounding rect. A card tapped 90 degrees reports a
  // rect with its width and height swapped, and stamping that on the clone
  // squashed the ghost into a card-shaped box lying the wrong way.
  ghost.style.width = `${source.offsetWidth}px`
  ghost.style.height = `${source.offsetHeight}px`
  ghost.style.opacity = '1'
  ghost.style.pointerEvents = 'none'

  const transform = getComputedStyle(source).transform
  const keep = Boolean(options?.keepTransform) && transform !== 'none'
  ghost.style.transform = keep ? transform : 'none'

  document.body.appendChild(ghost)
  // A rotated ghost rasterises into a box whose axes no longer line up with
  // the pointer offset measured against the source, so it is centred instead.
  // Predictable beats subtly wrong, and a tapped card is small enough that
  // centring reads as picking it up.
  const ox = keep ? rect.width / 2 : event.clientX - rect.left
  const oy = keep ? rect.height / 2 : event.clientY - rect.top
  event.dataTransfer.setDragImage(ghost, ox, oy)

  /* Kept alive until the drag ends, not torn down on the next tick.
   *
   * `setTimeout(..., 0)` assumed Chrome rasterises the drag image
   * synchronously inside the dragstart handler. It usually does -- which is
   * why the search grid always looked right -- but not reliably, and when the
   * removal wins the race Chrome silently falls back to its own translucent
   * snapshot of whatever the gesture started on. That is the washed-out
   * "dragging an image" ghost: not our clone rendering badly, our clone never
   * being used.
   *
   * `dragend` fires on the source for every outcome including a cancelled
   * drag, so the ghost cannot leak. */
  const cleanUp = () => {
    ghost.remove()
    source.removeEventListener('dragend', cleanUp)
  }
  source.addEventListener('dragend', cleanUp)
}
