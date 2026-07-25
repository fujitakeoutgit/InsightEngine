import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Two panes with a draggable divider.
 *
 * The ratio is persisted per storage key, because a builder layout is a
 * personal preference you set once. Pointer capture is used so the drag keeps
 * tracking if the cursor outruns the handle, and the grid template is written
 * straight to the DOM during the drag — routing every mouse move through React
 * state makes the divider feel heavy.
 */
export function SplitPane({
  left,
  right,
  storageKey,
  initial = 0.45,
  min = 0.25,
  max = 0.75,
}: {
  left: React.ReactNode
  right: React.ReactNode
  storageKey: string
  initial?: number
  min?: number
  max?: number
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const ratio = useRef<number>(
    Number(localStorage.getItem(storageKey)) || initial,
  )
  // A ref drives the drag, not state: state updates land a render later, so
  // the first pointermove events after pointerdown would be dropped. The state
  // flag exists only to style the handle.
  const dragging = useRef(false)
  const [showDrag, setShowDrag] = useState(false)

  const apply = useCallback((value: number) => {
    ratio.current = Math.min(max, Math.max(min, value))
    if (containerRef.current) {
      containerRef.current.style.gridTemplateColumns =
        `minmax(0, ${ratio.current}fr) auto minmax(0, ${1 - ratio.current}fr)`
    }
  }, [min, max])

  useEffect(() => { apply(ratio.current) }, [apply])

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    dragging.current = true
    setShowDrag(true)
    ;(event.target as HTMLElement).setPointerCapture?.(event.pointerId)
  }

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging.current || !containerRef.current) return
    const rect = containerRef.current.getBoundingClientRect()
    apply((event.clientX - rect.left) / rect.width)
  }

  const onPointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return
    dragging.current = false
    setShowDrag(false)
    ;(event.target as HTMLElement).releasePointerCapture?.(event.pointerId)
    localStorage.setItem(storageKey, String(ratio.current))
  }

  return (
    <div className="split" ref={containerRef}>
      {left}
      <div
        className={`split-handle ${showDrag ? "dragging" : ""}`}
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize panes"
        tabIndex={0}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={() => { apply(initial); localStorage.setItem(storageKey, String(initial)) }}
        onKeyDown={(e) => {
          // Keyboard users get the same control in 5% steps.
          if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
          e.preventDefault()
          apply(ratio.current + (e.key === 'ArrowLeft' ? -0.05 : 0.05))
          localStorage.setItem(storageKey, String(ratio.current))
        }}
        title="Drag to resize · double-click to reset"
      />
      {right}
    </div>
  )
}
