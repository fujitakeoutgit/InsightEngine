/** Typed client for the Insight Enigma API. Requests go through Vite's proxy. */

export interface Card {
  oracle_id: string
  scryfall_id: string | null
  name: string
  mana_cost: string | null
  cmc: number | null
  type_line: string | null
  oracle_text: string | null
  power: string | null
  toughness: string | null
  loyalty: string | null
  colors: string
  color_identity: string
  keywords: string[] | null
  set_code: string | null
  set_name: string | null
  collector_number: string | null
  rarity: string | null
  artist: string | null
  released_at: string | null
  edhrec_rank: number | null
  reserved: boolean
  game_changer: boolean
  legalities: Record<string, string> | null
  prices: Record<string, string | null> | null
  usd: number | null
  image_small: string | null
  image_normal: string | null
  image_art_crop: string | null
  scryfall_uri: string | null
  card_faces: CardFace[] | null
  layout: string | null
}

export interface CardFace {
  name: string
  mana_cost?: string
  type_line?: string
  oracle_text?: string
  power?: string
  toughness?: string
  image_uris?: Record<string, string>
}

export interface SearchResponse {
  cards: Card[]
  total: number
  page: number
  per_page: number
  has_more: boolean
  engine: 'local' | 'scryfall' | 'semantic' | 'none'
  warnings: string[]
  needs_semantic?: boolean
  prompts?: string[]
}

export interface CardDetail {
  card: Card
  rulings: { published_at: string; comment: string; source: string }[]
  tags: string[]
  printings: Card[]
  vendors: Record<string, string | null>
}

export interface SetInfo {
  code: string
  name: string
  set_type: string | null
  released_at: string | null
  card_count: number | null
  digital: number
  icon_svg_uri: string | null
  parent_code: string | null
}

export interface Resolution {
  raw_name: string
  quantity: number
  section: string
  match: 'exact' | 'face' | 'prefix' | 'fuzzy' | 'ambiguous' | 'unresolved'
  score: number
  alternatives: string[]
  line_number: number
  card: Card | null
}

export interface FormatVerdict {
  format: string
  label: string
  legal: boolean
  issues: string[]
  problem_cards: { name: string; reason: string }[]
}

export interface DeckReport {
  total_cards: number
  sideboard_cards: number
  unique_cards: number
  unresolved_count: number
  price_usd: number
  cards_missing_price: number
  curve: Record<string, number>
  colors: Record<string, number>
  formats: FormatVerdict[]
  entries: Resolution[]
  ignored_lines: string[]
  unresolved: { raw_name: string; line_number: number; alternatives: string[] }[]
}

export interface GuardReport {
  clean: boolean
  invalid_indices: number[]
}

export interface SemanticStage {
  stage: string
  message: string
  detail: {
    concepts?: string[]
    oracle_phrases?: string[]
    tags?: { slug: string; count: number }[] | string[]
    rationales?: string[]
    plans?: { rationale: string; matched: number; error?: string }[]
    warnings?: string[]
    cards?: Card[]
    guard?: GuardReport
    candidate_count?: number
    interpretation?: string
    batch?: number
    batches?: number
    prompt?: string
    run_id?: string
  }
}

class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message)
  }
}

async function get<T>(path: string, params?: Record<string, unknown>): Promise<T> {
  const url = new URL(path, window.location.origin)
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== '') {
        url.searchParams.set(key, String(value))
      }
    }
  }
  const resp = await fetch(url)
  if (!resp.ok) {
    const detail = await resp.json().catch(() => ({ detail: resp.statusText }))
    throw new ApiError(resp.status, detail.detail ?? resp.statusText)
  }
  return resp.json()
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const resp = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!resp.ok) {
    const detail = await resp.json().catch(() => ({ detail: resp.statusText }))
    throw new ApiError(resp.status, detail.detail ?? resp.statusText)
  }
  return resp.json()
}

export const api = {
  search: (params: {
    q: string
    page?: number
    per_page?: number
    sort?: string
    order?: string
    engine?: string
    include_funny?: boolean
    include_digital?: boolean
  }) => get<SearchResponse>('/api/search', params),

  autocomplete: (q: string) => get<{ suggestions: string[] }>('/api/autocomplete', { q }),

  card: (oracleId: string) => get<CardDetail>(`/api/cards/${oracleId}`),

  cardByName: (name: string) =>
    get<{ card: Card; match: string; score: number; alternatives: string[] }>(
      `/api/cards/named/${encodeURIComponent(name)}`,
    ),

  sets: () => get<{ sets: SetInfo[] }>('/api/sets'),

  glossary: () =>
    get<{
      symbols: { symbol: string; english: string; svg_uri: string; represents_mana: boolean }[]
      keywords: Record<string, string[]>
      frequency: Record<string, number>
      warnings: string[]
    }>('/api/glossary'),

  tags: (q = '', limit = 60) =>
    get<{ tags: { slug: string; label: string; description: string; card_count: number }[] }>(
      '/api/tags',
      { q, limit },
    ),

  analyzeDeck: (text: string, commander?: string) =>
    post<DeckReport>('/api/deck/analyze', { text, commander: commander ?? null }),

  health: () =>
    get<{
      status: string
      cards: number
      paper_cards: number
      mirror_built_at: string | null
      model: string
    }>('/api/health'),

  semanticStatus: () =>
    get<{
      available: boolean
      model: string
      model_installed: boolean
      models: string[]
      endpoint: string
    }>('/api/semantic/status'),
}

/**
 * Stream the q: pipeline.
 *
 * EventSource is used rather than fetch+ReadableStream because the run is long
 * and EventSource reconnects and parses framing for free. Returns a closer.
 */
export function streamSemantic(
  query: string,
  handlers: {
    onStage: (stage: SemanticStage) => void
    onComplete: (stage: SemanticStage) => void
    onError: (message: string) => void
    onCancelled?: () => void
  },
): { stop: () => void; runId: string } {
  const runId =
    globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`
  const url = `/api/semantic/stream?q=${encodeURIComponent(query)}&run_id=${runId}`
  const source = new EventSource(url)
  // EventSource also emits `error` when a stream closes normally. Without this
  // flag a successful run ends by flashing a spurious connection failure.
  let finished = false

  source.addEventListener('stage', (event) => {
    handlers.onStage(JSON.parse((event as MessageEvent).data))
  })
  source.addEventListener('complete', (event) => {
    finished = true
    handlers.onComplete(JSON.parse((event as MessageEvent).data))
    source.close()
  })
  source.addEventListener('cancelled', () => {
    finished = true
    handlers.onCancelled?.()
    source.close()
  })
  source.addEventListener('error', (event) => {
    const data = (event as MessageEvent).data
    if (data) {
      finished = true
      handlers.onError(JSON.parse(data).message)
    } else if (!finished && source.readyState === EventSource.CLOSED) {
      handlers.onError('Connection to the search engine was lost.')
    } else if (!finished) {
      return // transient; EventSource will reconnect on its own
    }
    source.close()
  })

  const stop = () => {
    finished = true
    source.close()
    // Closing the stream is not enough on its own: the server needs to cancel
    // the task so the model is actually released rather than left generating.
    void fetch(`/api/semantic/cancel/${runId}`, { method: 'POST' }).catch(() => {})
  }

  return { stop, runId }
}
