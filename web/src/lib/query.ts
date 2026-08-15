/** Client-side view of the query syntax.
 *
 * This mirrors the server's lexer for *display* only -- the server remains the
 * single authority on what a query means. It exists so the search bar can echo
 * a parsed, color-coded reading of what the user typed, which is the fastest
 * way to teach the syntax.
 */

export interface QueryToken {
  raw: string
  key?: string
  op?: string
  value?: string
  kind: 'pair' | 'word' | 'phrase' | 'group'
  negated: boolean
  semantic: boolean
  wildcard: boolean
  known: boolean
}

export const FIELDS: Record<string, string> = {
  c: 'color', color: 'color', colors: 'color',
  id: 'identity', ci: 'identity', identity: 'identity', commander: 'identity',
  t: 'type', type: 'type',
  o: 'oracle', oracle: 'oracle', text: 'oracle',
  fo: 'full oracle', fulloracle: 'full oracle',
  n: 'name', name: 'name',
  mv: 'mana value', cmc: 'mana value', manavalue: 'mana value',
  m: 'mana cost', mana: 'mana cost',
  pow: 'power', power: 'power',
  tou: 'toughness', toughness: 'toughness',
  loy: 'loyalty', loyalty: 'loyalty',
  r: 'rarity', rarity: 'rarity',
  s: 'set', set: 'set', e: 'set', edition: 'set',
  legal: 'legal in', banned: 'banned in', restricted: 'restricted in',
  f: 'legal in', format: 'legal in',
  is: 'is', has: 'is',
  kw: 'keyword', keyword: 'keyword',
  a: 'artist', artist: 'artist',
  usd: 'price usd', price: 'price usd', eur: 'price eur', tix: 'price tix',
  year: 'year', date: 'year',
  rank: 'edhrec rank', edhrec: 'edhrec rank',
  layout: 'layout', produces: 'produces',
  otag: 'oracle tag', function: 'oracle tag', tag: 'oracle tag',
  binder: 'in your binder',
  q: 'ask the model', ask: 'ask the model',
}

const TOKEN_RE =
  /(-?)([A-Za-z][A-Za-z0-9]*)(!=|<=|>=|:|=|<|>)("[^"]*"|'[^']*'|[^\s()]+)|(-?)("[^"]*"|'[^']*')|(-?)([^\s()]+)|([()])/g

export function tokenizeQuery(source: string): QueryToken[] {
  const tokens: QueryToken[] = []
  for (const m of source.matchAll(TOKEN_RE)) {
    const [raw] = m
    if (m[9]) {
      tokens.push({ raw, kind: 'group', negated: false, semantic: false, wildcard: false, known: true })
      continue
    }
    if (m[2]) {
      const key = m[2].toLowerCase()
      const value = stripQuotes(m[4])
      const quoted = m[4] !== value
      tokens.push({
        raw,
        key,
        op: m[3],
        value,
        kind: 'pair',
        negated: m[1] === '-',
        semantic: key === 'q' || key === 'ask',
        wildcard: quoted && value.includes('_'),
        known: key in FIELDS,
      })
      continue
    }
    if (m[6]) {
      tokens.push({
        raw, value: stripQuotes(m[6]), kind: 'phrase',
        negated: m[5] === '-', semantic: false,
        wildcard: stripQuotes(m[6]).includes('_'), known: true,
      })
      continue
    }
    if (m[8]) {
      const word = m[8]
      if (/^(or|and)$/i.test(word)) {
        tokens.push({ raw, kind: 'group', negated: false, semantic: false, wildcard: false, known: true })
        continue
      }
      tokens.push({
        raw, value: word, kind: 'word',
        negated: m[7] === '-', semantic: false, wildcard: false, known: true,
      })
    }
  }
  return tokens
}

function stripQuotes(value: string): string {
  if (value.length >= 2 && value[0] === value[value.length - 1] && /["']/.test(value[0])) {
    return value.slice(1, -1)
  }
  return value
}

export function hasSemantic(source: string): boolean {
  return tokenizeQuery(source).some((t) => t.semantic)
}

/** Human-readable name for a field key, for the syntax echo tooltip. */
export function describe(token: QueryToken): string {
  if (token.kind !== 'pair' || !token.key) return 'card name'
  return FIELDS[token.key] ?? `unknown filter "${token.key}"`
}

export const EXAMPLE_QUERIES = [
  'c:red t:creature mv<=3',
  'o:"draw a card" legal:commander',
  'o:"Elf_creature"',
  'q:"cards that punish opponents for drawing"',
  'id<=bg t:creature usd<=1 sort:edhrec',
  'otag:sacrifice-outlet-creature legal:pauper',
  't:planeswalker r:mythic year>=2023',
  'q:"graveyard recursion" id<=wb mv<=4',
]

/** Quote a value if it needs it, for the advanced-search generator. */
export function quoteIfNeeded(value: string): string {
  return /[\s"']/.test(value) ? `"${value.replace(/"/g, '')}"` : value
}

/** Any operator that already states which format the search is about. */
const NAMES_A_FORMAT = /\b(legal|banned|restricted|format)\s*:/i

/**
 * Add `legal:commander` to a query that does not already name a format.
 *
 * Commander is the format this app is used for, and a search without it
 * returns cards you cannot play alongside ones you can, with nothing to tell
 * them apart. Anything that already says `legal:`, `banned:` or `restricted:`
 * is left alone -- it has stated its own opinion about legality, and adding a
 * second one would silently contradict it.
 */
export function withCommanderDefault(query: string): string {
  const trimmed = query.trim()
  if (!trimmed || NAMES_A_FORMAT.test(trimmed)) return trimmed
  return `${trimmed} legal:commander`
}
