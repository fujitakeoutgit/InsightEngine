/** Copying text out of the app.
 *
 * One helper because there are three places that do it — the Cards pile, a
 * decklist, and the query the Advanced builder just assembled — and they had
 * drifted into three behaviours: two spellings of the same try/catch and one
 * bare call with no `await` and no catch, which failed silently.
 *
 * The failure is worth reporting rather than swallowing. A browser refuses the
 * write whenever the document is not focused, which is not rare and looks
 * exactly like a dead button.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    // Refused, not unavailable. Fall through and copy the old way.
  }
  return selectAndCopy(text)
}

/**
 * The pre-Clipboard-API way: put the text in a field, select it, copy.
 *
 * `navigator.clipboard.writeText` is the right call and fails for reasons that
 * have nothing to do with the text — the document not being focused is the
 * common one, and it rejects with NotAllowedError exactly as if permission had
 * been denied. From the outside that is a button that does nothing.
 *
 * `document.execCommand` is deprecated and every browser still implements it,
 * because this is what the whole web did before. It has no permission model:
 * it copies the current selection during a user gesture, which a click on a
 * Copy button is.
 */
function selectAndCopy(text: string): boolean {
  const field = document.createElement('textarea')
  field.value = text
  // Off-screen, but in the document and not `display: none` -- a selection
  // cannot be made in an element the browser is not laying out. Readonly so a
  // phone does not open its keyboard for the instant this exists.
  field.setAttribute('readonly', '')
  field.style.position = 'fixed'
  field.style.top = '0'
  field.style.left = '-9999px'
  document.body.appendChild(field)

  const previous = document.activeElement as HTMLElement | null
  try {
    field.select()
    field.setSelectionRange(0, text.length)
    return document.execCommand('copy')
  } catch {
    return false
  } finally {
    field.remove()
    // Selecting moved focus. Put it back, or the next keystroke goes nowhere.
    previous?.focus?.()
  }
}
