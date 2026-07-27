/**
 * Turn a double-faced card over.
 *
 * Sits in the tile's upper right, below the info control where a tile has one
 * (`.has-info` shifts it down a row). Stops the click from reaching the tile,
 * which would otherwise navigate or open a picker.
 */
export function FlipButton({
  onFlip, faceName, below = false,
}: {
  onFlip: () => void
  /** The face currently showing, so the tooltip says what you are leaving. */
  faceName: string
  /** True when an info control already occupies the corner. */
  below?: boolean
}) {
  return (
    <button
      className={`flip-btn ${below ? 'below' : ''}`}
      title={`Turn over — showing ${faceName}`}
      aria-label="Turn card over"
      onClick={(event) => {
        event.preventDefault()
        event.stopPropagation()
        onFlip()
      }}
    >
      ⟳
    </button>
  )
}
