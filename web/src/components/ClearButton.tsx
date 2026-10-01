/** The small ✕ at the right end of a text field, there only while the field
 *  has something in it. Sits inside a `.fld-clearable` wrapper, over the
 *  field's own padding. */
export function ClearButton({ shown, onClear, label }: {
  shown: boolean
  onClear: () => void
  /** What it clears, for a screen reader: "Clear filter". */
  label: string
}) {
  if (!shown) return null
  return (
    <button
      type="button"
      className="fld-clear"
      // Mouse down would take focus from the field, and blur closes what the
      // field has open; the click is all that is wanted.
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClear}
      aria-label={label}
      title={label}
    >
      ✕
    </button>
  )
}
