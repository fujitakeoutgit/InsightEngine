/** Typed client for the Insight Enigma API. Requests go through Vite's proxy. */

import { addToSection, type Section } from './deckModel'

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
  stats: DeckStats
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

export interface DeckTheme {
  slug: string
  in_deck: number
  corpus: number
  score: number
  /** Signature themes distinguish the deck; supporting ones are generic
   *  functions it happens to run. Only signature themes qualify a card. */
  signature: boolean
  /** The deck description named this theme, so it was ranked up. */
  described: boolean
}

export interface Recommendation {
  card: Card
  because: string[]
  score: number
}

export interface RecommendReport {
  themes: DeckTheme[]
  color_identity?: string
  format?: string | null
  recommendations: Recommendation[]
  note: string | null
}

export interface SavedDeck {
  id: number
  name: string
  description?: string | null
  commander: string | null
  format: string | null
  created_at: string
  updated_at: string
  text?: string
  lines?: number
  /** Joined from the commander's card row; the gallery renders these. */
  commander_art?: string | null
  commander_image?: string | null
  color_identity?: string | null
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

  recommendDeck: (
    text: string, format?: string | null, description?: string | null, limit = 150,
  ) =>
    post<RecommendReport>('/api/deck/recommend', {
      text, commander: null, format: format || null, limit,
      description: description || null,
    }),

  prepareAiRecommendations: (text: string, format?: string | null, description?: string | null) =>
    post<{ run_id: string; cards: number }>("/api/deck/recommend/prepare", {
      text, commander: null, format: format || null, description: description || null,
    }),

  savedDecks: () => get<{ decks: SavedDeck[] }>('/api/deck/saved'),

  saveDeck: (deck: { name: string; text: string; id?: number; format?: string | null ; description?: string | null }) =>
    post<{ deck: SavedDeck }>('/api/deck/saved', {
      name: deck.name, text: deck.text, id: deck.id ?? null, format: deck.format ?? null,
      description: deck.description ?? null,
    }),

  loadDeck: (id: number) => get<{ deck: SavedDeck }>(`/api/deck/saved/${id}`),

  /** Add a card to a saved deck without opening it. Read-modify-write on the
   *  decklist text, which is the deck's source of truth. */
  addToDeck: async (id: number, name: string, section: Section = 'maybeboard') => {
    const { deck } = await get<{ deck: SavedDeck }>(`/api/deck/saved/${id}`)
    return post<{ deck: SavedDeck }>('/api/deck/saved', {
      id,
      name: deck.name,
      text: addToSection(deck.text ?? '', name, section),
      format: deck.format ?? null,
      description: deck.description ?? null,
    })
  },

  deleteDeck: async (id: number) => {
    const resp = await fetch(`/api/deck/saved/${id}`, { method: 'DELETE' })
    if (!resp.ok) throw new ApiError(resp.status, 'Could not delete deck')
    return resp.json() as Promise<{ deleted: number }>
  },

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
/** Stream the AI deck-recommendation pipeline. Same framing as `q:` search. */
export function streamDeckRecommendations(
  runId: string,
  handlers: {
    onStage: (stage: SemanticStage) => void
    onComplete: (stage: SemanticStage) => void
    onError: (message: string) => void
    onCancelled?: () => void
  },
): { stop: () => void } {
  const source = new EventSource(`/api/deck/recommend/stream?run_id=${runId}`)
  let finished = false

  source.addEventListener('stage', (event) => {
    handlers.onStage(JSON.parse((event as MessageEvent).data))
  })
  source.addEventListener('complete', (event) => {
    finished = true
    source.close()
    handlers.onComplete(JSON.parse((event as MessageEvent).data))
  })
  source.addEventListener('cancelled', () => {
    finished = true
    source.close()
    handlers.onCancelled?.()
  })
  source.addEventListener('error', (event) => {
    const data = (event as MessageEvent).data
    if (data) {
      finished = true
      source.close()
      handlers.onError(JSON.parse(data).message)
      return
    }
    if (finished) { source.close(); return }
    if (source.readyState === EventSource.CLOSED) {
      source.close()
      handlers.onError('Connection to the recommendation engine was lost.')
    }
  })

  return {
    stop: () => {
      finished = true
      source.close()
      void fetch(`/api/semantic/cancel/${runId}`, { method: 'POST' }).catch(() => {})
    },
  }
}

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

  // close() runs *before* the handler on every terminal event. EventSource
  // reconnects automatically when a stream ends without close(), so if a
  // handler throws while closing came after it, the browser silently starts
  // the whole eight-minute run again.
  source.addEventListener('complete', (event) => {
    finished = true
    source.close()
    handlers.onComplete(JSON.parse((event as MessageEvent).data))
  })
  source.addEventListener('cancelled', () => {
    finished = true
    source.close()
    handlers.onCancelled?.()
  })
  source.addEventListener('error', (event) => {
    const data = (event as MessageEvent).data
    if (data) {
      finished = true
      source.close()
      handlers.onError(JSON.parse(data).message)
      return
    }
    if (finished) {
      source.close() // terminal event already handled; never let it reconnect
      return
    }
    if (source.readyState === EventSource.CLOSED) {
      source.close()
      handlers.onError('Connection to the search engine was lost.')
    }
    // Otherwise transient: EventSource is mid-reconnect on a run still going.
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

export interface DeckStats {
  empty: boolean
  total_cards: number
  lands: number
  untapped_lands: number
  mana_rocks: number
  mana_dorks: number
  other_mana_sources: number
  nonland_sources: number
  avg_cmc: number
  pips: Record<string, number>
  produced: Record<string, number>
  balance: {
    color: string; pips: number; pip_share: number
    sources: number; source_share: number; gap: number
  }[]
  types: Record<string, number>
  rarity: { main: Record<string, number>; sideboard: Record<string, number> }
  curve: Record<string, Record<string, number>>
  tokens: {
    oracle_id: string; name: string; type_line: string | null
    pt: string | null; color_identity: string | null
    image: string | null; is_emblem: boolean
  }[]
}
