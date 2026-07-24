# Manafold

A Magic: The Gathering search engine. Scryfall's capability, original interface,
plus a local-LLM semantic search that is structurally incapable of inventing a card.

> **Data source:** card data and images are provided by
> [Scryfall](https://scryfall.com) under their API terms. Manafold is unofficial
> Fan Content permitted under the Wizards of the Coast Fan Content Policy, and is
> not affiliated with or endorsed by Scryfall or Wizards of the Coast.

---

## What it does

| | |
|---|---|
| **Search** | Full operator syntax — `c:red t:creature mv<=3`, `o:"draw a card"`, `legal:commander`, grouping, negation, `!"exact name"` |
| **Wildcards** | `o:"Elf_creature"` — `_` matches any run of text. No API equivalent; runs locally |
| **Semantic** | `q:"cards that sacrifice for value"` — a local Llama 3.3 70B pipeline, combinable with normal filters |
| **Card detail** | Oracle text, rulings, full legality table, every printing, prices from multiple vendors |
| **Advanced search** | Filter builder that writes query syntax as you click |
| **Deck Lab** | Paste any list — quantities, set codes, split cards and typos all resolve; per-format legality and total cost |
| **Reference** | Set browser, mana symbols, keyword frequencies, and the oracle-tag vocabulary |

---

## Architecture

```
Browser ──► Vite/React (5173) ──proxy──► FastAPI (8787) ──► SQLite mirror  (local, exhaustive)
                                                        ├─► api.scryfall.com (live, rate-limited, cached)
                                                        └─► Ollama (llama3.3:70b)
```

**Why a local mirror when the API exists.** The two stated goals conflict: an
exhaustive sweep of the corpus cannot be done over a paginated, rate-limited
API without hammering it. Scryfall publish daily bulk files for exactly this
case. So Manafold splits the difference:

- **Live API** for ordinary queries — full operator fidelity and current prices.
- **Local mirror** for `q:`, `_` wildcards and `otag:` — syntax the API cannot
  express, and the only way to guarantee a complete scan.

Both paths return the identical card shape, and both apply the same default
hygiene (digital-only Alchemy rebalances and joke sets hidden unless asked for),
so results never disagree depending on which engine answered.

---

## The `q:` pipeline

Six stages. Only three involve the model, and none of those three let it author
card data.

| # | Stage | Who | What |
|---|-------|-----|------|
| 1 | Interpret | model | Prose → search concepts + literal rules-text phrases |
| 2 | Vocabulary | **code** | Concepts → real oracle-tag slugs, via FTS + hierarchy expansion |
| 3 | Plan | model | Concepts + tag menu → several complementary filter sets |
| 4 | Query | **code** | Plans → SQL → union of real rows — *the only source of card data* |
| 5 | Evaluate | model | Numbered batches → **indices** of relevant candidates |
| 6 | Analyse | model | Themes and counts → prose, then name-scanned |

### How "zero hallucinations" is enforced

Not by asking the model nicely. By three mechanical properties:

1. **The model never emits card data.** It emits filter objects and integer
   indices. Every displayed field is rehydrated from SQLite by `oracle_id`. A
   fabricated id matches no row and vanishes.
2. **Indices are range-checked** against the exact batch shown to the model.
   Out-of-range selections are dropped and counted.
3. **Prose is scanned against all 38k card names.** The prompts forbid naming
   cards; if the model names one anyway, the analysis is discarded and replaced
   with a summary computed from the data. The UI always reports whether the
   guard fired.

Additionally, decoding is constrained by JSON Schema at temperature 0, so the
model cannot free-associate its way out of the response shape.

### How "zero missed cards" is pursued

- **Bulk mirror**, not paged API — the whole corpus is in scope.
- **Curated tags as a closed vocabulary.** Scryfall Tagger's 4,496 functional
  tags (229k card links) catch cards sharing no common substring —
  `sacrifice-outlet-creature` finds cards whose text never says "sacrifice
  outlet". The model picks from tags *retrieved from the database*, so it cannot
  invent a slug that matches nothing.
- **Hierarchy expansion.** Selecting `tutor` deterministically expands to every
  descendant tag.
- **Multiple complementary plans, unioned.** Breadth beats precision at this stage.
- **An unconditional tag sweep.** Every run also queries the retrieved tags
  directly, independent of what the planner wrote. This was added after two runs
  of the same query returned different gaps — one missed every sacrifice *land*
  because its plans were creature-shaped. It costs one SQL query and no model
  call, so recall does not depend on the planner having a good day.
- **Automatic AND→OR rescue.** Planners reliably over-constrain: requiring both
  `"sacrifice a creature"` and `"when this creature dies"` on one card matches
  **zero**; the same phrases ORed match **thousands**. Any plan returning nothing
  is retried relaxed, in code, with no extra model call.
- **Every candidate is examined.** The candidate set is evaluated in batches
  rather than truncated to fit a context window. This is the deliberate
  thoroughness-over-speed trade: a run takes minutes, not seconds.

---

## Setup

### Prerequisites

- Python 3.11 · Node 18+ · [Ollama](https://ollama.com)
- ~2 GB disk for the mirror; ~43 GB for the model

```bash
ollama pull llama3.3:70b
```

> On a 32 GB card, Q4 llama3.3:70b (~43 GB) splits roughly 65/35 GPU/CPU and
> runs at a few tokens/sec. That is expected and acceptable here — the pipeline
> is built for thoroughness. To trade accuracy for speed, point
> `MANAFOLD_OLLAMA_MODEL` at a model that fits entirely in VRAM.

### Backend

```bash
cd server
py -3.11 -m venv .venv
.venv/Scripts/python -m pip install -r requirements.txt
.venv/Scripts/python -m app.bulk          # ~230 MB download, builds the mirror
.venv/Scripts/python -m uvicorn app.main:app --port 8787
```

### Frontend

```bash
cd web
npm install
npm run dev                                # http://localhost:5173
```

### Refreshing card data

```bash
.venv/Scripts/python -m app.bulk           # re-downloads only what changed
.venv/Scripts/python -m app.bulk --reingest  # re-parse cached files, no download
```

---

## Configuration

Environment variables, or a `server/.env`. All are prefixed `MANAFOLD_`.

| Variable | Default | Notes |
|---|---|---|
| `OLLAMA_MODEL` | `llama3.3:70b` | Any Ollama model that honours JSON Schema |
| `OLLAMA_BASE` | `http://localhost:11434` | |
| `OLLAMA_NUM_CTX` | `16384` | |
| `OLLAMA_TIMEOUT` | `900` | Seconds. A cold 70B needs the headroom |
| `SEMANTIC_MAX_PLANS` | `8` | More plans → better recall, longer runs |
| `SEMANTIC_CANDIDATE_CAP` | `400` | Rows handed to the evaluation stage |
| `SCRYFALL_MIN_INTERVAL` | `0.1` | 10 req/s, per Scryfall's guidance |
| `DB_PATH` | `../data/manafold.sqlite3` | |

---

## Rate limiting and caching

All Scryfall traffic goes through one client that enforces a ≥100 ms gap
between requests (10 req/s), caps concurrency, sends a descriptive
`User-Agent`, backs off on 429, and caches every response in memory and in
SQLite. Nothing else in the codebase may call Scryfall directly.

---

## Tests

```bash
cd server
.venv/Scripts/python -m pytest tests/ -q
```

68 tests covering the query grammar and SQL compiler, `_` wildcard semantics,
the decklist ladder (`fire/fall` ≡ `fire fall` ≡ `firefall`), format legality
including commander colour identity, and the hallucination guard.

The guard tests deliberately run without a model — they assert the properties
that hold *even if the model misbehaves*: invented ids resolve to nothing,
out-of-range indices are dropped, and a card name in prose is caught and
replaced.

---

## Layout

```
manafold/
├── data/                      mirror + cached bulk files (gitignored)
├── server/
│   ├── app/
│   │   ├── bulk.py            bulk download + ingest
│   │   ├── db.py              schema, versioned rebuilds, name folding
│   │   ├── scryfall.py        rate-limited cached client
│   │   ├── search_local.py    search_mtg_database — the model's only tool
│   │   ├── tags.py            oracle-tag retrieval + hierarchy
│   │   ├── query/             lexer → AST → SQL, and the filter schema
│   │   ├── llm/               ollama client, prompts, pipeline, guard
│   │   ├── deck/              decklist parser, resolver, legality
│   │   └── routers/
│   └── tests/
└── web/
    └── src/
        ├── lib/               api client, motion primitives, syntax echo
        ├── components/        search bar, card grid, semantic console
        └── routes/            search, card, advanced, deck, sets, glossary
```
