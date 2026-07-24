import { useEffect, useRef, useState } from 'react'
import { api } from '../lib/api'
import { EXAMPLE_QUERIES, describe, tokenizeQuery } from '../lib/query'

/**
 * The search field.
 *
 * Two things earn their keep here: a live token echo that teaches the syntax
 * by showing how the query parses, and name autocomplete that only fires when
 * the user is plainly typing a name rather than an operator.
 */
export function SearchBar({
  value,
  onChange,
  onSubmit,
  showExamples = false,
  autoFocus = false,
}: {
  value: string
  onChange: (next: string) => void
  onSubmit: (query: string) => void
  showExamples?: boolean
  autoFocus?: boolean
}) {
  const [focused, setFocused] = useState(false)
  const [suggestions, setSuggestions] = useState<string[]>([])
  const [highlight, setHighlight] = useState(-1)
  const inputRef = useRef<HTMLInputElement>(null)

  const tokens = tokenizeQuery(value)

  // Autocomplete only when the tail looks like a bare name fragment.
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

  const applySuggestion = (name: string) => {
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
      if (highlight >= 0 && suggestions[highlight]) {
        applySuggestion(suggestions[highlight])
      } else {
        setSuggestions([])
        onSubmit(value)
      }
      inputRef.current?.blur()
      return
    }
    if (event.key === 'Escape') {
      setSuggestions([])
      setHighlight(-1)
    }
  }

  // "/" focuses the field from anywhere, as long as you are not already typing.
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

  return (
    <div className={`searchbar ${focused ? 'focused' : ''}`}>
      <div className="searchbar-shell">
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
          onFocus={() => setFocused(true)}
          onBlur={() => setTimeout(() => setFocused(false), 140)}
          onKeyDown={onKeyDown}
        />
        <div className="searchbar-actions">
          {value && (
            <button className="btn btn-ghost" onClick={() => onChange('')} aria-label="Clear">
              ✕
            </button>
          )}
          <button className="btn btn-primary" onClick={() => onSubmit(value)}>
            Search
          </button>
        </div>
      </div>

      {focused && suggestions.length > 0 && (
        <div className="suggestions">
          {suggestions.map((name, i) => (
            <button
              key={name}
              className={i === highlight ? 'active' : ''}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => applySuggestion(name)}
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

      {showExamples && (
        <div className="examples">
          {EXAMPLE_QUERIES.map((example) => (
            <button
              key={example}
              onClick={() => {
                onChange(example)
                onSubmit(example)
              }}
            >
              {example}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
