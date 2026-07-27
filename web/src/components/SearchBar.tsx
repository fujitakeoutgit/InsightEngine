import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../lib/api'
import { describe, tokenizeQuery } from '../lib/query'
import { buildSegments, checkWords, extractWords, suggestFor, type Segment } from '../lib/spell'

interface MenuState {
  x: number
  y: number
  word: string
  start: number
  end: number
  suggestions: string[] | null
}

/**
 * The search field.
 *
 * Three things earn their keep: a live token echo that teaches the syntax by
 * showing how the query parses, name autocomplete that only fires when the
 * user is plainly typing a name, and a Magic-aware spell checker.
 *
 * The spell checker draws onto a backdrop element that mirrors the input's
 * text and metrics exactly but renders it transparent, so only the wavy
 * underlines show through beneath the real text. Native spellcheck is off
 * because it flags every operator and knows none of Magic's vocabulary.
 */
export function SearchBar({
  value,
  onChange,
  onSubmit,
  autoFocus = false,
}: {
  value: string
  onChange: (next: string) => void
  onSubmit: (query: string) => void
  autoFocus?: boolean
}) {
  const [focused, setFocused] = useState(false)
  const [suggestions, setSuggestions] = useState<string[]>([])
  const [highlight, setHighlight] = useState(-1)
  const [segments, setSegments] = useState<Segment[]>([{ text: '', bad: false }])
  const [menu, setMenu] = useState<MenuState | null>(null)

  const inputRef = useRef<HTMLInputElement>(null)
  const backdropRef = useRef<HTMLDivElement>(null)

  const tokens = tokenizeQuery(value)

  // --- spell check ------------------------------------------------------
  useEffect(() => {
    let cancelled = false
    const words = extractWords(value)
    if (!words.length) {
      setSegments([{ text: value, bad: false }])
      return
    }
    const timer = setTimeout(async () => {
      const unknown = await checkWords(words.map((w) => w.word))
      if (!cancelled) setSegments(buildSegments(value, unknown))
    }, 260)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [value])

  // Keep the backdrop aligned while the input scrolls horizontally.
  const syncScroll = useCallback(() => {
    if (backdropRef.current && inputRef.current) {
      backdropRef.current.scrollLeft = inputRef.current.scrollLeft
    }
  }, [])

  const openMenu = async (event: React.MouseEvent) => {
    const target = (event.target as HTMLElement).closest('.bad') as HTMLElement | null
    // Only intercept right-clicks that land on a flagged word; everywhere else
    // the normal browser menu is more useful.
    const hit =
      target ??
      [...(backdropRef.current?.querySelectorAll<HTMLElement>('.bad') ?? [])].find((el) => {
        const r = el.getBoundingClientRect()
        return (
          event.clientX >= r.left && event.clientX <= r.right &&
          event.clientY >= r.top && event.clientY <= r.bottom
        )
      })
    if (!hit) return

    event.preventDefault()
    const word = hit.textContent ?? ''
    const start = Number(hit.dataset.start ?? -1)
    const end = Number(hit.dataset.end ?? -1)
    setMenu({ x: event.clientX, y: event.clientY, word, start, end, suggestions: null })
    const found = await suggestFor(word)
    setMenu((m) => (m && m.word === word ? { ...m, suggestions: found } : m))
  }

  const applySuggestion = (replacement: string) => {
    if (!menu || menu.start < 0) return
    const next = value.slice(0, menu.start) + replacement + value.slice(menu.end)
    onChange(next)
    setMenu(null)
    inputRef.current?.focus()
  }

  useEffect(() => {
    if (!menu) return
    const dismiss = () => setMenu(null)
    window.addEventListener('click', dismiss)
    window.addEventListener('scroll', dismiss, true)
    return () => {
      window.removeEventListener('click', dismiss)
      window.removeEventListener('scroll', dismiss, true)
    }
  }, [menu])

  // --- name autocomplete ------------------------------------------------
  useEffect(() => {
    const tail = value.split(/\s+/).pop() ?? ''
    const looksLikeOperator = tail.includes(':') || /[<>=]/.test(tail) || tail.startsWith('-')
    if (looksLikeOperator || tail.length < 2 || !focused) {
      setSuggestions([])
      return
    }
    const timer = setTimeout(() => {
      api
        .autocomplete(tail)
        .then((r) => setSuggestions(r.suggestions.slice(0, 8)))
        .catch(() => setSuggestions([]))
    }, 180)
    return () => clearTimeout(timer)
  }, [value, focused])

  const applyName = (name: string) => {
    const parts = value.split(/\s+/)
    parts[parts.length - 1] = `!"${name}"`
    const next = parts.join(' ')
    onChange(next)
    setSuggestions([])
    onSubmit(next)
  }

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (suggestions.length && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      event.preventDefault()
      setHighlight((h) => {
        const next = event.key === 'ArrowDown' ? h + 1 : h - 1
        return (next + suggestions.length) % suggestions.length
      })
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      if (highlight >= 0 && suggestions[highlight]) applyName(suggestions[highlight])
      else {
        setSuggestions([])
        onSubmit(value)
      }
      inputRef.current?.blur()
      return
    }
    if (event.key === 'Escape') {
      setSuggestions([])
      setHighlight(-1)
      setMenu(null)
    }
  }

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement
      const typing = ['INPUT', 'TEXTAREA'].includes(target.tagName) || target.isContentEditable
      if (event.key === '/' && !typing) {
        event.preventDefault()
        inputRef.current?.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Offsets are recomputed here so each flagged span can rewrite the exact
  // slice of the query it came from.
  let offset = 0

  return (
    <div className={`searchbar ${focused ? 'focused' : ''}`}>
      <div className="searchbar-shell">
        <div className="search-input-wrap" onContextMenu={openMenu}>
          <div className="spell-backdrop mono" ref={backdropRef} aria-hidden>
            {segments.map((segment, i) => {
              const start = offset
              offset += segment.text.length
              return segment.bad ? (
                <span
                  key={i}
                  className="bad"
                  data-start={start}
                  data-end={start + segment.text.length}
                >
                  {segment.text}
                </span>
              ) : (
                <span key={i}>{segment.text}</span>
              )
            })}
          </div>
          <input
            ref={inputRef}
            value={value}
            autoFocus={autoFocus}
            spellCheck={false}
            autoComplete="off"
            placeholder='c:red t:creature mv<=3   ·   q:"cards that sacrifice for value"'
            aria-label="Search query"
            onChange={(e) => {
              onChange(e.target.value)
              setHighlight(-1)
            }}
            onScroll={syncScroll}
            onFocus={() => setFocused(true)}
            onBlur={() => setTimeout(() => setFocused(false), 140)}
            onKeyDown={onKeyDown}
          />
        </div>
        <div className="searchbar-actions">
          {value && (
            <button className="btn btn-ghost sm" onClick={() => onChange('')} aria-label="Clear">
              ✕
            </button>
          )}
          <button className="btn btn-primary" onClick={() => onSubmit(value)}>
            Search
          </button>
        </div>
      </div>

      {menu && (
        <div
          className="spell-menu"
          style={{ left: menu.x, top: menu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="head">Did you mean</div>
          {menu.suggestions === null && <button className="none">Looking…</button>}
          {menu.suggestions?.length === 0 && <button className="none">No suggestions</button>}
          {menu.suggestions?.map((s) => (
            <button key={s} onClick={() => applySuggestion(s)}>
              {s}
            </button>
          ))}
        </div>
      )}

      {focused && suggestions.length > 0 && (
        <div className="suggestions">
          {suggestions.map((name, i) => (
            <button
              key={name}
              className={i === highlight ? 'active' : ''}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => applyName(name)}
            >
              {name}
            </button>
          ))}
        </div>
      )}

      {tokens.length > 0 && (
        <div className="syntax-echo" aria-hidden>
          {tokens
            .filter((t) => t.kind !== 'group')
            .map((token, i) => (
              <span
                key={i}
                className={[
                  'token',
                  token.semantic && 'semantic',
                  token.wildcard && 'wildcard',
                  token.negated && 'negated',
                  !token.known && 'invalid',
                ]
                  .filter(Boolean)
                  .join(' ')}
                title={describe(token)}
              >
                {token.key && <span className="k">{describe(token)}</span>}
                {token.key && <span className="faint"> {token.op} </span>}
                <span className="v">{token.value}</span>
              </span>
            ))}
        </div>
      )}
    </div>
  )
}
