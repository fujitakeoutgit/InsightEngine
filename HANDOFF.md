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
- **Tests**: `cd server && ./.venv/Scripts/python.exe -m pytest -q` (148 pass).
- **Typecheck**: `cd web && npx tsc -b --noEmit`.

## Architecture in brief

Hybrid data model, and it's deliberate: a **local SQLite mirror** of Scryfall's
bulk data (38k paper oracle cards, FTS5, oracle tags, rulings) backs `q:`
semantic search, the `_` wildcard, `otag:` and all deck analysis; ordinary
queries proxy to the **live Scryfall API**. Both engines must agree on
visibility filters or results differ by engine — that's bitten three times now.

`visibility_clause()` in `server/app/search_local.py` is the single choke point
for that agreement: digital, funny and **non-deckable extras** (tokens,
emblems, art series, vanguards — the `NOT_DECKABLE` tuple) are excluded by
default, matching what Scryfall hides unless a query says otherwise. A query
that names a `layout` drops the extras default, which is safe because the
constraint then does the filtering itself. `CardNameResolver` filters on the
same list via `deckable_clause()` — an art print carries its card's name
verbatim, so without it a decklist line resolves to a picture of the card.

The `q:` pipeline runs a local llama3.3:70b via ollama with **zero
hallucination as a structural guarantee**: the model only ever emits filters
and integers, never a string field, and cards are rehydrated from SQLite by
oracle_id. Don't loosen that.

`server/app/db.py` has `SCHEMA_VERSION` (currently 5). Bumping it drops and
rebuilds derived tables but preserves user tables (`decks`, `http_cache`).
After a bump, re-ingest with `python -m app.bulk --reingest` (uses the cached
180MB bulk files, works offline).

## Outstanding work, roughly prioritised

### 1. Tray doesn't launch at Windows startup

Diagnosed but **not solved**. Verified: the `HKCU\...\Run` entry is correct and
predates the boot; Windows hasn't disabled it (no `StartupApproved` entry); the
files exist; deps import; the named-mutex single-instance guard is sound
(`use_last_error=True` is set); and the exact command runs and stays running
from `System32` as both `python.exe` and `pythonw.exe`. A Startup-folder
shortcut was added as a second path. `main()` now writes to
`data/logs/tray.log` on launch, mutex-exit, crash and clean shutdown — **check
that log after the next reboot**, it's the whole point of it existing.

New evidence: as of 2026-07-31 `data/logs/` holds `api.log` and `web.log` dated
Jul 28 and **no `tray.log` at all**. The tray appends to it on all four paths,
so its absence means `main()` has not run once since the logging was added —
which rules out the mutex guard and the crash paths, and points at the Run
entry never invoking the interpreter. (Servers running on 8787/5173 are not
evidence either way; the tray truncates those two logs with `"w"` on start, so
anything currently up was started by hand.)

### 2. Longer-standing features never started

- Combo detection via the Commander Spellbook API, cached locally.
- Deck version history and changelog.

### 3. Smaller things noticed but not done

- **Copy to clipboard is unverified.** Both the deck page and the Cards page
  call `navigator.clipboard.writeText` and handle rejection with a visible
  message. The browser pane denies clipboard writes outright (`NotAllowedError`
  for a bare `writeText`), so the success path has never run — needs a real
  browser.
- `count_matches()` in `search_local.py` applies no visibility clause at all.
  It only feeds the "plan too broad" check, so it is not wrong today, but it is
  the one local count that disagrees with every other.

## Traps that have cost real time here — please read

**Vite serves stale transforms.** Rewriting a watched file with
`cat a b > file` lets Vite observe it mid-write and cache the result. It served
`__vite__css = ""` for a 62KB stylesheet once, and a half-updated `.tsx`
another time — every rule silently stopped applying, with no error anywhere.
Write via a temp file and `mv`, and if behaviour doesn't match the file on
disk, `touch` it to force a re-transform. Verify with
`curl -s localhost:5173/src/...` rather than trusting the source.

**Don't append CSS overrides — edit the rule that's already there.** Appending
with `cat >>` left duplicate `.chart svg` and `.curve-chart` rules fighting
each other, which caused two separate "this reverted" reports.

`grep -c "^\.selector"` is *not* a reliable tell — it counts `.modal h3` as a
`.modal` duplicate and misses `.a, .b {` groups, which cost a wrong count in
both directions. Track brace depth and skip `@media` instead:

```sh
awk '{n=gsub(/\{/,"{"); m=gsub(/\}/,"}"); h=$0; sub(/\{.*/,"",h); gsub(/^[ \t]+|[ \t]+$/,"",h);
 if ($0 ~ /\{/ && d==0 && h !~ /^@/ && h!="") print h; d+=n-m}' components.css |
 sort | uniq -c | awk '$1>1'
```

All known duplicates were merged on 2026-07-31; that command returns nothing
now, so anything it prints is new.

**Merged CSS must be checked by computed style, not by reading.** When rules
are collapsed the question is whether the *final* value survived, and the file
cannot answer it. `getComputedStyle(el)` — and `getComputedStyle(el, '::after')`
for pseudo-elements — is the check. `.pt-deck-back` was three rules deep with
the third cancelling the second's `box-shadow` and `::after`.

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

**Reading the DOM straight after a synthetic click reads the previous render.**
React has not re-rendered yet, so a loop of `el.click()` with assertions
in between measures nothing and looks like a broken feature. Await a short
timeout between click and read. This masked a real bug once and invented an
imaginary one once, in the same afternoon.

**State that a fast interaction reads back must live in a ref.** The die's
count mode computed the next face from the `value` in its render closure, so
clicks landing faster than a re-render all saw the same number. Mirror it in a
ref and write both. A functional updater is the other fix, but not when the new
value also has to be reported somewhere — StrictMode invokes updaters twice.

**Navigation the page performs itself must bypass its own unsaved-changes
guard.** Saving a new deck and deleting one both settle the deck and navigate
in the same tick, so the `dirty` the blocker closes over is still the old
value. `DeckPage` keeps a `leaving` ref for exactly this, cleared when the next
deck loads.

**Undo has to snapshot the decklist text, not just the card list.** In Text
mode the card list may not describe what is being edited, and where it is still
empty, rebuilding the text with `serialize()` erases the file. Snapshots are
`{cards, text}` pairs.

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

## What changed on 2026-07-31

An audit of the interface against what the API and typed client already
implement turned up fifteen gaps; all are closed, on branch
`missing-interactions`. Saved decks can be deleted, renamed and duplicated;
the deck page exports and copies; an unsaved-changes guard covers both in-app
navigation and tab close; Commander is an editor section again; name-resolution
alternatives rewrite the line they belong to; results and the card page reach a
deck through a `⋯` menu; `/` works on every page; recent searches pin and
delete; a bad URL gets a 404 page; playtest games survive closing the mat; and
the playtest corner now holds the piles, a thrown die, the history and four
actions.

The old note here said art-series cards were leaking into search. That premise
was wrong and worth recording: all 2243 `art_series` rows carry `is_funny = 1`,
so the existing joke-set default already excluded them and the named example
never reached a result grid. The real leak was 1012 rows that are *not* funny —
814 tokens, 87 emblems, 79 double-faced tokens, 32 vanguards — and, worse, the
name resolver, which indexed the cards table whole and offered art prints as
suggested corrections for misspelled decklist lines.
