# Insight Engine

A Magic: The Gathering search engine. Scryfall's capability, original interface,
plus a local-LLM semantic search that is structurally incapable of inventing a card.

> **Data source:** card data and images are provided by
> [Scryfall](https://scryfall.com) under their API terms. Insight Engine is unofficial
> Fan Content permitted under the Wizards of the Coast Fan Content Policy, and is
> not affiliated with or endorsed by Scryfall or Wizards of the Coast.

---

## Install

Download the latest `InsightEngine-Setup.exe` from
[Releases](https://github.com/fujitakeoutgit/InsightEngine/releases) and run it.

**That is the whole requirement.** Python and the web interface are inside the
installer, so there is nothing to install first and nothing to configure. The
app runs as one program, serves itself, and sits in the notification area.

On first run it downloads the card database from Scryfall — a few minutes,
once. The tray icon says what it is doing while it works.

The installer is unsigned, so Windows SmartScreen warns until the download
builds reputation: **More info → Run anyway**.

> **Optional:** `q:` searches — asking for cards in plain English — need
> [Ollama and a model](#the-local-model). Nothing else does. Search,
> deckbuilding, the binder, playtest and simulation all work without it.

*Building from source instead? See [Setup](#setup).*

---

## The local model

`q:` searches are answered by a model running on your own machine. Nothing is
sent anywhere. Ordinary searches, deckbuilding, the binder, playtest and
simulation never touch it, so you can skip this section entirely and add a
model later.

### Installing Ollama

1. Download it from [ollama.com](https://ollama.com) and run the installer.
2. It starts a background service and puts an icon in the notification area.
   Nothing else is needed — Insight Engine talks to it at
   `http://localhost:11434`.
3. Check it is up:

   ```bash
   ollama list
   ```

   An empty list is the correct answer before you have pulled anything. An
   error means the service is not running.

### Choosing a model for your PC

**Match the model to your graphics card's VRAM, not to your system RAM.** A
model that fits on the card answers in seconds. One that does not still runs —
Ollama spills the remainder into system memory — but a single search can take
minutes, which is the difference between a feature you use and one you avoid.

Find your VRAM: Task Manager → Performance → GPU → *Dedicated GPU memory*.

| Your VRAM | Model | Pull |
|---|---|---|
| 4 GB, or integrated graphics | Tier 1 — 3B | `ollama pull llama3.2:3b` |
| 8 GB | Tier 2 — 8B | `ollama pull llama3.1:8b` |
| 12 GB | Tier 3 — 14B | `ollama pull qwen2.5:14b` |
| 24 GB | Tier 4 — 32B | `ollama pull qwen2.5:32b` |
| 48 GB or more | Tier 5 — 70B | `ollama pull llama3.3:70b` |

What the rungs actually buy you:

- **3B** runs on almost anything and is the weakest at turning a vague sentence
  into good filters.
- **8B** is the smallest size that reliably plans a multi-part query, and a
  sensible floor for everyday use.
- **14B** is noticeably better at oracle-text phrasing than 8B.
- **32B** gets close to the 70B's reading of intent for a fraction of the wait.
  On a 24 GB card it is the best trade available.
- **70B** is the most faithful interpreter of an awkward sentence, and wants
  48 GB to stay resident.

Pick the largest row your card can hold. If you are between two rows, take the
smaller one — a fast answer you actually wait for beats a better answer you
cancel.

> **Two cards, or an unusual amount of VRAM?** Ollama uses one GPU by default.
> Size against the card it will pick, not the total.

### Selecting it in the app

**Settings → Local model → Model.** The dropdown lists the five tiers with the
video memory each wants, and shows which are installed. Press **Save**. If the
model is not on the machine yet, the panel prints the exact `ollama pull`
command to run first.

A model set by hand in `INSIGHT_OLLAMA_MODEL` is honoured and shown in the
list rather than silently replaced, so you can point at any Ollama tag —
including one not listed here.

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
case. So Insight Engine splits the difference:

- **Live API** for ordinary queries — full operator fidelity and current prices.
- **Local mirror** for `q:`, `_` wildcards and `otag:` — syntax the API cannot
  express, and the only way to guarantee a complete scan.

Both paths return the identical card shape, and both apply the same default
hygiene (digital-only Alchemy rebalances and joke sets hidden unless asked for),
so results never disagree depending on which engine answered.

---

## The `q:` pipeline

Five stages. Only three involve the model, and none of those three let it author
card data.

| # | Stage | Who | What |
|---|-------|-----|------|
| 1 | Interpret | model | Prose → search concepts + literal rules-text phrases |
| 2 | Vocabulary | **code** | Concepts → real oracle-tag slugs, via FTS + hierarchy expansion |
| 3 | Plan | model | Concepts + tag menu → several complementary filter sets |
| 4 | Query | **code** | Plans → SQL → union of real rows — *the only source of card data* |
| 5 | Evaluate | model | Numbered batches → **indices** of relevant candidates |

A run can be stopped at any point. The pipeline executes as its own
`asyncio.Task`, so cancelling it interrupts the HTTP call to Ollama, closes the
connection, and stops generation — the model is released rather than left
running for a result nobody will read.

### How "zero hallucinations" is enforced

Not by asking the model nicely. By two mechanical properties:

1. **The model never emits card data, and never emits prose.** Its response
   schemas contain only filter objects and integer arrays. Every displayed
   field is rehydrated from SQLite by `oracle_id`, so a fabricated id matches
   no row and vanishes.
2. **Indices are range-checked** against the exact batch shown to the model.
   Out-of-range selections are dropped and counted, and the UI reports it.

An earlier version added a third property: scanning model-written prose for
card names. That scanner is gone because its input is. Removing the
summarisation stage removed the only channel through which model-authored text
reached the user — a stronger guarantee than policing that text was.

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

Everything below is for **working on Insight Engine**. To just use it, see
[Install](#install) — the released build needs none of this.

### Prerequisites

- Python 3.11 · Node 18+ — build-time only. Python is frozen into the
  installer and the interface ships as static files, so a released copy needs
  neither.
- ~2 GB disk for the card mirror
- [Ollama](https://ollama.com) and a model, if you want `q:` to work

### First-time install

```bash
py -3.11 -m venv server/.venv
server/.venv/Scripts/python -m pip install -r server/requirements.txt
npm --prefix web install
cd server && .venv/Scripts/python -m app.bulk    # ~230 MB, builds the mirror
```

### Running it

```powershell
.\start.ps1
```

Checks the environment, the mirror and the model, starts both servers, waits
for the web server to bind, and opens a browser. `-NoBrowser` to skip opening
one, `-SkipChecks` to skip the preflight.

Or start the two halves yourself:

```bash
cd server && .venv/Scripts/python -m uvicorn app.main:app --port 8787
cd web    && npm run dev                          # http://localhost:5173
```

Ollama only needs to be running for `q:` searches — everything else works
without it.

### Sharing it on your LAN

```powershell
.\start.ps1 -Lan
```

Binds both servers to all interfaces and prints the address other machines
should use. CORS already allows the private IPv4 ranges, so a second PC only
needs `http://<your-ip>:5173`.

**Understand what you are exposing.** There is no authentication of any kind,
so on a shared network:

| Risk | Reality |
|---|---|
| Anyone can search | Harmless — it's card data. |
| Anyone can queue GPU work | A `q:` run pins the card for minutes. Capped at one concurrent run (`INSIGHT_SEMANTIC_MAX_CONCURRENT`), so the worst case is a queue, not a meltdown. |
| Anyone can edit saved decks | `/api/deck/saved` allows create, overwrite and delete with no identity. Treat saved decks as shared, not private. |
| Traffic is plaintext HTTP | Fine on a home LAN. Not fine on café or office Wi-Fi. |

This is a trusted-LAN tool. **Do not port-forward it or expose it to the
internet** — an unauthenticated endpoint that runs a local LLM on demand is
exactly the kind of thing that gets abused. If you need it off-network, put it
behind a VPN (Tailscale is the least effort) rather than opening a port.

### From the system tray

For a **source checkout**. The installed build has its own tray
built in and needs none of this.

```powershell
server\.venv\Scripts\python -m pip install -r tray\requirements.txt
start "" server\.venv\Scripts\pythonw.exe tray\insight_tray.py
```

Sits in the notification area and starts on login, but **idle by default** —
nothing listens until you pick *Start server*. The menu also opens the app,
tails the logs, and toggles autostart. Two details it handles that a naive
launcher does not: `npm run dev` reaches Vite through four nested processes, so
stopping walks the whole tree rather than orphaning the one holding port 5173;
and if the servers are already running from `start.ps1`, the tray adopts them
instead of binding a second copy.

### Refreshing card data

```bash
.venv/Scripts/python -m app.bulk           # re-downloads only what changed
.venv/Scripts/python -m app.bulk --reingest  # re-parse cached files, no download
```

---

## Configuration

Environment variables, or a `server/.env`. All are prefixed `INSIGHT_`.

| Variable | Default | Notes |
|---|---|---|
| `OLLAMA_MODEL` | `llama3.3:70b` | Any Ollama model that honours JSON Schema |
| `OLLAMA_BASE` | `http://localhost:11434` | |
| `OLLAMA_NUM_CTX` | `16384` | |
| `OLLAMA_TIMEOUT` | `900` | Seconds. A cold 70B needs the headroom |
| `SEMANTIC_MAX_PLANS` | `8` | More plans → better recall, longer runs |
| `SEMANTIC_CANDIDATE_CAP` | `400` | Rows handed to the evaluation stage |
| `SEMANTIC_MAX_CONCURRENT` | `1` | One GPU; a second run makes both slower |
| `SCRYFALL_MIN_INTERVAL` | `0.1` | 10 req/s, per Scryfall's guidance |
| `HOST` / `PORT` | `127.0.0.1` / `8787` | Set host to `0.0.0.0` for LAN |
| `EXTRA_CORS_ORIGINS` | — | Comma-separated; `*` allows any |
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
including commander color identity, plan isolation, and the guard.

These deliberately run without a model — they assert the properties that hold
*even if the model misbehaves*: invented ids resolve to nothing, out-of-range
indices are dropped, the selection schema is structurally incapable of carrying
text, and a plan set containing a regex-as-color still returns cards from the
plans that were valid.

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
