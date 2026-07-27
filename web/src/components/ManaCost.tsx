import { ManaPip } from './ManaSprite'

/** Renders a Scryfall mana-cost string ("{2}{W}{U/B}") as coloured pips. */

const COLOR_KEYS = new Set(['W', 'U', 'B', 'R', 'G'])

const VAR = (c: string) => `var(--mana-${c.toLowerCase()})`

function Pip({ symbol }: { symbol: string }) {
  const inner = symbol.replace(/[{}]/g, '')

  // The five colours and colourless get their real Magic symbol. Generic
  // numerals and everything else keep the numbered disc.
  if (/^[WUBRGC]$/.test(inner)) {
    return <ManaPip code={inner} />
  }

  // Hybrid and Phyrexian symbols read as two halves.
  if (inner.includes('/')) {
    const [a, b] = inner.split('/')
    return (
      <span
        className="pipn"
        data-c="hybrid"
        style={{
          ['--pip-a' as string]: COLOR_KEYS.has(a) ? VAR(a) : 'var(--mana-c)',
          ['--pip-b' as string]: COLOR_KEYS.has(b) ? VAR(b) : 'var(--mana-c)',
        }}
        title={inner}
      >
        {inner.replace('/', '')}
      </span>
    )
  }

  return (
    <span className="pipn" data-c={COLOR_KEYS.has(inner) ? inner : undefined} title={inner}>
      {inner}
    </span>
  )
}

export function ManaCost({ cost, className }: { cost?: string | null; className?: string }) {
  if (!cost) return null
  const symbols = cost.match(/\{[^}]+\}/g)
  if (!symbols) return null
  return (
    <span className={`mana-cost ${className ?? ''}`} aria-label={`Mana cost ${cost}`}>
      {symbols.map((symbol, i) => (
        <Pip key={`${symbol}-${i}`} symbol={symbol} />
      ))}
    </span>
  )
}

/** Compact colour-identity dots, used in dense list views. */
export function IdentityDots({ identity }: { identity: string }) {
  if (!identity) {
    return (
      <span className="identity-dots" title="Colourless">
        <ManaPip code="c" size={11} />
      </span>
    )
  }
  return (
    <span className="identity-dots" title={`Colour identity ${identity}`}>
      {identity.split('').map((c) => (
        <i key={c} style={{ background: VAR(c) }} />
      ))}
    </span>
  )
}

/**
 * Oracle text with reminder text de-emphasised and mana symbols inlined.
 * Card text is plain text from Scryfall, so it is rendered as text nodes.
 */
export function OracleText({ text }: { text?: string | null }) {
  if (!text) return <span className="faint">No rules text.</span>
  return (
    <>
      {text.split('\n').map((line, i) => (
        <div key={i}>
          {line
            .split(/(\{[^}]+\}|\([^)]*\))/g)
            .filter(Boolean)
            .map((part, j) => {
              if (/^\{[^}]+\}$/.test(part)) return <ManaCost key={j} cost={part} />
              if (/^\([^)]*\)$/.test(part)) {
                return (
                  <span key={j} className="reminder">
                    {part}
                  </span>
                )
              }
              return <span key={j}>{part}</span>
            })}
        </div>
      ))}
    </>
  )
}
