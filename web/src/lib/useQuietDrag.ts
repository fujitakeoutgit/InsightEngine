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
export function solidDragImage(event: React.DragEvent, source: HTMLElement) {
  const rect = source.getBoundingClientRect()
  const ghost = source.cloneNode(true) as HTMLElement
  ghost.style.position = 'fixed'
  ghost.style.top = '-10000px'
  ghost.style.left = '-10000px'
  ghost.style.margin = '0'
  ghost.style.width = `${rect.width}px`
  ghost.style.height = `${rect.height}px`
  ghost.style.opacity = '1'
  // The source may be mid-tilt; the drag image should not inherit a rotation.
  ghost.style.transform = 'none'
  ghost.style.pointerEvents = 'none'
  document.body.appendChild(ghost)
  event.dataTransfer.setDragImage(ghost, event.clientX - rect.left, event.clientY - rect.top)
  // The browser rasterises it synchronously, so it can go straight back out.
  setTimeout(() => ghost.remove(), 0)
}
