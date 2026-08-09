# Open items

Everything asked for and not yet built, as of 2026-08-08. Grouped by area
rather than by the order it was asked in, because several of these touch the
same files and are cheaper done together.

Nothing here is started unless it says so.

---

## Answers to the four questions

**When does it check for new cards? When does it sync?**
Right now: never, after the first build. `app.bulk` does compare Scryfall's
`updated_at` against what was ingested and skips anything current — so the
*logic* for an incremental refresh is there — but nothing ever calls it again.
The only triggers are running `python -m app.bulk` by hand, or the packaged
launcher building the mirror when there is none. A machine installed today
will still be on today's card data in a year. See **D1**.

**Can you rename the repo?**
The GitHub side, yes — `gh repo rename insight-engine` — but it is your
account and renaming breaks every existing clone and link, so it needs your
say-so rather than my judgement. The local folder, no: the session is running
inside `…\repos\manafold`, and the shared `.claude/launch.json` hard-codes
that absolute path. Rename it yourself when nothing is running and I will fix
the launch config and the remaining references. See **N1**, **N2**.

**Can we do a proper d20?**
Yes, but not the way the d6 is done. A cube is six squares; an icosahedron is
twenty triangles, and CSS 3D has no triangle — each face needs a clip-path and
its own transform, and the maths for the dihedral angles is unforgiving.
Two honest options: build it properly (a day's fiddling, genuinely nice), or
render the silhouette you sent as an SVG and tumble that in 3D, which reads as
a d20 from any angle without twenty real faces. I would start with the SVG.
See **P6**.

**Does EDHREC have an API?**
No official, documented one. There are undocumented JSON endpoints people
scrape, and community wrappers built on them, but nothing EDHREC publishes or
supports — so it can change without notice and there are no stated terms
permitting redistribution. For a tool you are handing to friends I would not
build a feature on it. Scryfall already gives us `edhrec_rank`, which is what
most of the value would have been anyway.

---

## Tray and first run

- **T1 — Packaged tray.** The installed build is a console window with no tray
  icon; the existing tray only supervises the two dev servers and does not
  apply. Build a small one for the packaged model: Open, Open data folder,
  Rebuild card data, Quit. *Agreed approach, not started.*
- **T2 — First-run handling.** If the tray can appear *during* the first-run
  index and the console can hide itself afterwards, do that and nothing else
  is needed. Only if it cannot: show a "setting up" state, then close and
  relaunch so the tray is present from the second launch. Decide by trying the
  simple version first.

## Naming

- **N1 — Rename the GitHub repo** to `insight-engine`. Needs your go-ahead.
- **N2 — Rename the local folder** to `insight-engine`. You do it; I follow up
  with `.claude/launch.json` and any remaining path references.

## Data

- **D1 — Automatic card sync.** Decide the trigger (on launch, daily, manual
  button in Settings) and wire it to the refresh that already works. A "last
  synced" line in Settings with a Refresh button is the minimum.

## Playtest

- **P1 — Dice start and spawn in the wrong place.** Still wrong despite the
  tray-measurement fix; the screenshots show them stacked oddly against the
  slots. Needs re-diagnosing against the real layout, not the pane.
- **P2 — d20 drifts down on every throw.** Each throw spawns its replacement
  lower than the last.
- **P3 — Dice must not rotate while held.** Only a throw should tumble them;
  dragging should carry them flat.
- **P4 — Reset needs a confirmation** — it discards a whole board.
- **P5 — Reset must also reset the dice** back to their trays.
- **P6 — Proper d20.** See the answer above; SVG silhouette first.
- **P7 — Bin for dice.** While dragging a die, show a small trash target above
  the d20 slot; releasing over it removes that die.
- **P8 — Coin gold, and on the top layer** above everything else.
- **P9 — Life counter.** A bar in the deck's row, above Next turn / Tutor /
  Reset, with up and down arrows.
- **P10 — Fetch lands.** Tapping one opens the tutor filtered to just the land
  types that fetch can find.
- **P11 — Dragging a card in playtest still behaves like an image.**
- **P12 — Dragging a card from hand behaves like an image.** P11 and P12 are
  probably one bug; the `draggable={false}` fix was applied to the deck editor
  and not to the playtest surfaces.

## Deck builder

- **B1 — Commander colour pips.** In the same row as `# cards · $cost`, a
  `Commander:` label then the pips. Clicking one toggles it, shown by
  lightness. All start active. The row must not grow taller.
- **B2 — Remove** the manabase panel, "Card costs (outer) / Land mana (inner)",
  "How this deck works", the format control and the deck-name field.
- **B3 — Printing picker.** Drop Commander / Maybe / Sideboard from the tile
  hover and put **Printing** there instead: a dark full-screen gallery of that
  card's editions, set name under each, click a printing to choose it, click
  anywhere else to dismiss.
- **B4 — Images by default** everywhere that currently defaults to text.
- **B5 — Recommendations follow the deck's grouping and sort.**
- **B6 — Editor default grouping: none.**
- **B7 — Move the group/sort control** to the top of the list, above
  `Group: type`.
- **B8 — Splitter minimum.** The left side needs a larger minimum width; it
  currently clips into content when dragged far left.
- **B9 — Splitter default position: far right.** The existing right-hand limit
  is right.
- **B10 — Basic lands must not appear in shuffle triage.**

## Binder

- **B11 — New Binder tab, right of Glossary.** A deck in every mechanical
  sense, but singular, never listed among decks, and titled Binder. Hide
  Commander, Recommendations, Pipeline and AI recommend. Ramp / Removal /
  Counters / Draw stay where they are but act as filters over the list below.
  Sections are **Bulk, Trades, Fav** rather than commander/deck/sideboard/
  maybeboard.

## Settings

- **S1 — Backup and restore.** Export decks (and the Binder, and collected
  cards) to a local file and read it back. JSON unless there is a reason not
  to.

## Documentation

- **R1 — A thorough README**, with a section teaching the search syntax and a
  section on the tray icon.
