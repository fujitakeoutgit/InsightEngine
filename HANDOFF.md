# Insight Enigma — session handoff

Copy everything below into a new session.

---

I'm continuing work on **Insight Enigma**, a Magic: The Gathering search and
deck-building app at `C:\Users\fujit\source\repos\manafold`. It's a personal
tool, private repo, Windows.

## Running it

- **API**: FastAPI on `127.0.0.1:8787`, venv at `server/.venv`.
  Start with `--reload` — see the traps section, this matters.
- **Web**: Vite + React + TS on `localhost:5173`, proxies `/api`.
- **Tray app**: `tray/insight_tray.py` starts/stops both; default state stopped.
- **Tests**: `cd server && ./.venv/Scripts/python.exe -m pytest -q` (137 pass).
- **Typecheck**: `cd web && npx tsc -b --noEmit`.

## Architecture in brief

Hybrid data model, and it's deliberate: a **local SQLite mirror** of Scryfall's
bulk data (38k paper oracle cards, FTS5, oracle tags, rulings) backs `q:`
semantic search, the `_` wildcard, `otag:` and all deck analysis; ordinary
queries proxy to the **live Scryfall API**. Both engines must agree on
visibility filters or results differ by engine — that's bitten twice.

The `q:` pipeline runs a local llama3.3:70b via ollama with **zero
hallucination as a structural guarantee**: the model only ever emits filters
and integers, never a string field, and cards are rehydrated from SQLite by
oracle_id. Don't loosen that.

`server/app/db.py` has `SCHEMA_VERSION` (currently 5). Bumping it drops and
rebuilds derived tables but preserves user tables (`decks`, `http_cache`).
After a bump, re-ingest with `python -m app.bulk --reingest` (uses the cached
180MB bulk files, works offline).

## Outstanding work, roughly prioritised

### 1. Playtest additions (biggest, fully specced by the user)

In `web/src/components/Playtest.tsx`. The playtester is a full-screen playmat;
cards are absolutely positioned by fractional coordinates.

- **Dice.** A die in the corner *above the deck*. Above that, the play history.
  Above that, buttons: **next turn, shuffle, tutor, reset**. Six-sided, drawn
  with dots, not numerals. Grab and *throw* it to roll (physics-ish animation).
  Double-click puts it in **count mode**: sets to 1, and clicking from there
  iterates upward. Throwing it resets to passive rolling mode.
- **Move graveyard, exile and commander** to sit just left of the deck.
- **The divider between hand and field** should use the same colour as the
  other dividing lines (see `--line-soft` / the `.split-handle` treatment).

### 2. Recent searches: lock/pin

On the search page (`web/src/routes/SearchPage.tsx`, history in
`web/src/lib/history.ts`). Add a lock button per entry; locked searches move to
the top and stack below other locked ones.

### 3. Clicking a recommended card name should search for it

In the Deck Lab search tab.

### 4. Commander legality default on Advanced search

`withCommanderDefault()` in `web/src/lib/query.ts` already does this for the
splash page. The Advanced page (`web/src/routes/AdvancedPage.tsx`) should have
the Commander legality row pre-selected — its state is `formats: [{ status:
'legal', format: '' }]`.

### 5. Clean up three duplicated CSS selectors

`.pt-bar`, `.pt-hand`, `.pt-deck-back` each have an appended override in
`web/src/styles/components.css`. They render correctly today but are the same
landmine described below. Merge each into its original rule.

### 6. Tray doesn't launch at Windows startup

Diagnosed but **not solved**. Verified: the `HKCU\...\Run` entry is correct and
predates the boot; Windows hasn't disabled it (no `StartupApproved` entry); the
files exist; deps import; the named-mutex single-instance guard is sound
(`use_last_error=True` is set); and the exact command runs and stays running
from `System32` as both `python.exe` and `pythonw.exe`. A Startup-folder
shortcut was added as a second path. `main()` now writes to
`data/logs/tray.log` on launch, mutex-exit, crash and clean shutdown — **check
that log after the next reboot**, it's the whole point of it existing.

### 7. Longer-standing features never started

- Combo detection via the Commander Spellbook API, cached locally.
- Deck version history and changelog.

## Traps that cost real time this session — please read

**Vite serves stale transforms.** Rewriting a watched file with
`cat a b > file` lets Vite observe it mid-write and cache the result. It served
`__vite__css = ""` for a 62KB stylesheet once, and a half-updated `.tsx`
another time — every rule silently stopped applying, with no error anywhere.
Write via a temp file and `mv`, and if behaviour doesn't match the file on
disk, `touch` it to force a re-transform. Verify with
`curl -s localhost:5173/src/...` rather than trusting the source.

**Don't append CSS overrides — edit the rule that's already there.** Appending
with `cat >>` left duplicate `.chart svg` and `.curve-chart` rules fighting
each other, which caused two separate "this reverted" reports. Check with
`grep -c "^\.selector" components.css`; anything above 1 is the tell.

**Regex surgery on CSS leaves orphaned selector fragments.** A deletion once
left `.shuffle-pile.yes .shuffle-pile.no` on the line above `.shuffle-foot {`,
so the block parsed as one descendant selector matching nothing. The file
looked fine and the served CSS contained the right text. The diagnostic that
found it: query the element's *matched* rules in the browser — an empty list
distinguishes "rule absent" from "rule losing".

**The API does not hot-reload unless you start it with `--reload`.** A whole
round of "I'm not seeing the updates" was the backend running pre-edit code.

**The browser pane reports `visibilityState: "hidden"`.** Consequences:
`canAnimate()` correctly returns false so entrance tweens are skipped; `rAF`
never fires; **scroll events never fire** even though `window.scrollTo` moves
`scrollY`; and lazy images never load. Animation and scroll behaviour cannot be
verified there — say so rather than claiming it works.

**React StrictMode double-invokes effects on mount.** This broke the deck view
cache twice: a save effect firing in the same commit as a restore wrote
pre-restore state back over the cache, and the *second* restore then read the
blank view it had just written. Guard saves against the restore that shares
their commit.

**Early returns must sit below every hook.** Putting the playtest early return
mid-component crashed with "rendered fewer hooks than expected".

**Custom drag images must be painted to exist.** `setDragImage` with a ghost at
`top: -10000px` silently does nothing — Chrome rasterises from the paint area.
Use `top: 0; left: -10000px`. Also, `<img>` is draggable by default, so card
images need `draggable={false}` or the drag starts on the image and the browser
supplies its own translucent ghost. Both had to be true; fixing one looked like
fixing nothing.

**Both dev servers die often.** Restart detached via `Start-Process`.

**Shell:** PowerShell here-strings mangle embedded quotes — use
`git commit -F <file>`. `Out-File -Encoding utf8` writes a BOM; use `printf`.

## Working style the user expects

Verify claims in the browser or with tests rather than asserting them. When
something can't be verified in this environment, say so plainly instead of
implying it works. Comments should explain *why*, especially where a
non-obvious constraint drove the design — the codebase is written that way
throughout and it has repeatedly paid off. Commit messages are prose explaining
cause and reasoning, not bullet lists of changes.

There's also a pending task chip: **art_series cards are in the mirror and show
up in search** ("Delver of Secrets // Delver of Secrets", layout `art_series`).
The name type-ahead already excludes them via `NOT_DECKABLE` in
`server/app/routers/catalog.py`; general search does not.
