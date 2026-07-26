import { useEffect, useRef, useState } from 'react'

/**
 * A field whose values must match exactly, so it suggests as you type.
 *
 * Enter commits the highlighted suggestion and clears the box for the next
 * word, because these fields take several values and retyping the whole line
 * to add one more is the thing that makes them tedious. Committed values show
 * as tokens; backspace on an empty box removes the last one.
 */
export function TypeAhead({
  kind,
  value,
  onChange,
  placeholder,
  multi = true,
  transform,
}: {
  /** Catalog name on the server: types, keywords, artists, sets, tags, criteria. */
  kind: string
  /** Space-separated committed values. */
  value: string
  onChange: (next: string) => void
  placeholder?: string
  multi?: boolean
  /** Map a catalog entry to the value stored, e.g. "mh3 — Modern Horizons 3" -> "mh3". */
  transform?: (entry: string) => string
}) {
  const [draft, setDraft] = useState('')
  const [options, setOptions] = useState<string[]>([])
  const [highlight, setHighlight] = useState(0)
  const [open, setOpen] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const tokens = value.split(/\s+/).filter(Boolean)

  useEffect(() => {
    if (!draft.trim()) { setOptions([]); return }
    let cancelled = false
    const timer = setTimeout(async () => {
      try {
        const resp = await fetch(
          `/api/catalog/${kind}?q=${encodeURIComponent(draft)}&limit=10`,
        )
        if (!resp.ok) return
        const data = (await resp.json()) as { values: string[] }
        if (!cancelled) { setOptions(data.values); setHighlight(0) }
      } catch { /* offline: no suggestions, typing still works */ }
    }, 140)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [draft, kind])

  const commit = (entry: string) => {
    const cleaned = (transform ? transform(entry) : entry).replace(/\s+/g, '-')
    const next = multi ? [...tokens, cleaned] : [cleaned]
    onChange(next.join(' '))
    setDraft('')
    setOptions([])
    setOpen(false)
    inputRef.current?.focus()
  }

  const removeToken = (index: number) =>
    onChange(tokens.filter((_, i) => i !== index).join(' '))

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (!options.length) return
      event.preventDefault()
      setHighlight((h) => (h + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length)
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      // The highlighted suggestion if there is one, otherwise what was typed —
      // so an unlisted value is still enterable.
      const chosen = options[highlight] ?? draft.trim()
      if (chosen) commit(chosen)
      return
    }
    if (event.key === 'Backspace' && !draft && tokens.length) {
      event.preventDefault()
      removeToken(tokens.length - 1)
      return
    }
    if (event.key === 'Escape') { setOptions([]); setOpen(false) }
  }

  return (
    <div className="typeahead">
      <div className="ta-shell" onClick={() => inputRef.current?.focus()}>
        {tokens.map((token, i) => (
          <span className="ta-token" key={`${token}-${i}`}>
            {token}
            <button onClick={(e) => { e.stopPropagation(); removeToken(i) }} aria-label={`Remove ${token}`}>
              ✕
            </button>
          </span>
        ))}
        <input
          ref={inputRef}
          value={draft}
          placeholder={tokens.length ? '' : placeholder}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => { setDraft(e.target.value); setOpen(true) }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 140)}
          onKeyDown={onKeyDown}
          aria-label={placeholder}
        />
      </div>

      {open && options.length > 0 && (
        <div className="ta-options">
          {options.map((entry, i) => (
            <button
              key={entry}
              className={i === highlight ? 'active' : ''}
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => setHighlight(i)}
              onClick={() => commit(entry)}
            >
              {entry}
            </button>
          ))}
          <div className="ta-hint mono">Enter to add · Backspace to remove</div>
        </div>
      )}
    </div>
  )
}
