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
    return false
  }
}
