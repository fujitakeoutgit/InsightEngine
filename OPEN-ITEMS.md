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

- **D1 — Automatic card sync.** On startup, in a background task, compare
  Scryfall's per-file `updated_at` against what was ingested and refresh if it
  has moved. Drive it off `updated_at`, *not* the card count: a banlist
  update, errata, or a new printing of an existing card all leave the count
  identical, because `oracle_cards` is keyed by oracle_id. A "last synced"
  line in Settings with a Refresh button is the minimum surface.

- **D2 — Make the refresh safe to fail.** Ingest currently truncates `cards`
  and refills it in place, so a download that dies halfway leaves the app with
  no cards. Three ways out, in ascending order of both cost and payoff:

  1. *Temp table, then rename.* Cheapest, and does not actually solve it:
     `cards_fts` is external-content (`content='cards', content_rowid='rowid'`),
     so it stores an index resolved against the content table by rowid rather
     than storing the text. Swap the table underneath and every mapping is
     stale until the FTS is rebuilt — which is the slow part of ingest. The
     swap is atomic and is immediately followed by a broken window.
  2. *Temp file, then merge.* Build the derived side complete — schema,
     ingest, FTS rebuild — into `mirror.new.sqlite3` while the live database
     keeps serving, then ATTACH and copy the tables across in one transaction.
     Failure at any point means deleting a file.
  3. **Split the database** (preferred). Derived data in one file, user data
     (`decks`, `meta`) in another. Refreshing the mirror becomes a file
     rename: no table surgery, no FTS wrinkle, no merge. It also makes the
     distinction `DERIVED_TABLES` already asserts a physical one rather than a
     comment, and it makes **S1** trivial — back up a few KB of user file
     instead of filtering 220MB of rebuildable data out of a dump.

     One cost: `storage.listing` joins `decks` against `cards` for the
     commander art, so the connection has to `ATTACH` both files. SQLite does
     cross-database joins fine; it is a line at connect time.

## Playtest

- ~~**P1 / P2** — Dice spawned in the wrong place; the d20 drifted lower on
  every throw.~~ DONE, and they were one bug, not two. `PlayD20.tsx` — a dead
  component nothing has imported for some time — left behind a
  `.pt-d20 { position: relative }` rule. The live die is `pt-die pt-d20`, and
  that rule sits *later* in the stylesheet than `.pt-die { position: absolute }`
  at equal specificity, so it won: every d20 was in normal flow. One d20 was
  right by luck (static top 0); each additional one stacked exactly 46px — one
  die height — below the last, which is the "drifts down on every throw", and
  the "stacked oddly against the slots" in the screenshots. The tray
  measurement was never wrong; the transform was correct all along and the
  element's static origin was not. Dead component and its orphaned CSS deleted.

  Verified: three consecutive throws, each replacement measured at the tray's
  own box (1171, 224) with zero drift; d20 computes `position: absolute`.

  A second, independent cause sat behind "they still start off their squares
  while spawning looks fine". A die re-placed itself only on `window.resize`,
  and the thing that actually moves the tray is the *mat* changing size — which
  it does, silently, on first load: the hand's card images arrive after the die
  has mounted, the hand grows to fit them, the mat is squeezed by exactly that
  much, and the tools ride up with its bottom edge while the die stays where it
  was put. No resize event is fired for any of that. It explains the asymmetry
  exactly — a die spawned later mounts into a layout that has already settled,
  which is why spawning looked right. Now a `ResizeObserver` on the mat.

  Reproduced by growing the hand 90px with no window resize: tray up 90, die
  unmoved, off by 90. Confirmed fixed in the real window by you, not here —
  see the trap below.

  **Trap for the handoff:** the browser pane does not composite, and a page
  that never paints is never delivered its `ResizeObserver` callbacks. A plain
  observer on `.pt-mat` recorded *zero* hits across a 766→676 resize that had
  demonstrably happened. So ResizeObserver-driven behaviour reads as
  completely broken here and is fine in a real window. Same class as the drag
  trap: the environment is lying, so ask what you actually see.
- ~~**P3** — Dice no longer rotate while held; only a throw tumbles them.~~ DONE
- ~~**P4** — Reset asks first.~~ DONE
- ~~**P5** — Reset sweeps the dice back into their trays (Mulligan deliberately
  does not: it is still the same game).~~ DONE
- ~~**P13** — Piles too wide, and Next turn / Tutor / Reset not the same width
  as them.~~ DONE, in two passes. First pass shrank the piles 116→113 and
  centred the card, which fixed the gutters but *created* the second
  complaint: the buttons stayed 116 and the two rows no longer lined up.

  What actually set the pile width was the heading, not the card — and most of
  that was tracking: 0.24em across "Graveyard" is 23px of pure letter-spacing
  against a 64px card. Dropping the heading to 9.5px/0.06em let the pile go to
  88px with the label still on one line, which turned 25px of dead gutter into
  6. Both rows now take their width from a single `--zone-w` on `.pt-zones`
  instead of each carrying its own copy, so they cannot drift again — and
  `.pt-actions` had to become `repeat(3, var(--zone-w))`, because the old
  `minmax(…, 1fr)` let each column grow to its own label and "Next turn"
  pushed all three back out to 90.

  Verified: all six boxes 88px at identical x positions, both rows 284px, no
  label wrapping, no button text overflow, card gutters 12 and 12.
- ~~**P6 — Proper d20.**~~ DONE, the SVG route rather than twenty real faces.
  Face-on a d20 is a hexagon with the face you read in the middle of it, so
  the outline plus three edges running out to the corners is the whole of what
  makes it recognisable — and it is recognisable *before* you read the number,
  which was the entire job.

  The part that needed thought was the tumble. The silhouette is one flat
  plane, and a plane turned edge-on in 3D collapses to a hairline; a d20 that
  vanishes to a line halfway through a throw reads as a sheet of paper. So the
  d20 spins **in-plane on Z**, which can never flatten, with a shallow bounded
  tilt (`TILT`, 24°) on X and Y so it still turns *in* space. Both tilt terms
  are sines of the accumulated spin, so they vanish exactly where `land` snaps
  the spin to a multiple of 360 — it comes to rest genuinely flat-on rather
  than a few degrees off. All five rotation sites now go through one `turn()`
  mapping, so the cube and the d20 cannot drift apart.

  Verified on the rendered element across a 1080° sweep: max tilt 24°, the
  projected area never drops below 93% of face-on, and the rest state is
  exactly rotateX/Y 0 with rotateZ a multiple of 360. The *motion* itself is
  not verified here — see the trap below.

  **Trap for the handoff:** a throw cannot be driven synthetically in this
  pane. `setTimeout` is throttled in a page that is not compositing, so the
  pointer samples arrive slowly enough that the release velocity falls under
  `THROW_SPEED` and every attempted throw is scored as a slow placement — the
  die moves to the drop point and never rolls. It looks like broken throwing
  and is not. Verify throw geometry by driving the transforms directly, as
  above, and leave the feel of it to a real window.
- ~~**P7 — Bin for dice.**~~ DONE. A trash target above the d20 slot, shown
  only while a die is in hand, armed in red while the die is over it, and
  releasing there removes that die. Three decisions worth keeping:
  it holds its space in the layout at all times and only fades in, because a
  slot that appears *and* shifts the trays is a slot you cannot aim at; the
  bin is tested against the pointer, not the die, since the die is a 46px
  block under your finger; and binning the die that sits *in* a tray leaves a
  fresh one behind, because the tray is a supply and an empty one is a dead
  end. Verified: 2 dice → carried one out (3, replacement appeared) → binned
  the loose one (2), with the bin's armed state tracking correctly.
- ~~**P8** — Coin is gold and on the top layer.~~ DONE. The gold landed first
  time; the layer did not, and was reported done when it was not. `.pt-tools`
  carried `z-index: 4`, which makes it a **stacking context** — so the coin's
  `z-index: 40` only ever ranked it against its two sibling trays. Against a
  die at `z-index: 6` *outside* that box it could not have won at any value.
  Removed the `z-index` from `.pt-tools`: it was buying nothing, because the
  tools already paint over the battlefield by DOM order.

  **Trap for the handoff:** reading the computed `z-index` back off the coin
  returns `40` whether or not it means anything, which is exactly how this was
  called done the first time. Verify a layer by hit-testing the overlap —
  `elementFromPoint` where the die and coin actually cover each other — and
  confirm the cause by toggling the suspect property live: with `z-index: 4`
  the die is topmost, without it the coin is.
- ~~**P9 — Life counter.**~~ DONE. A bar across the full width of the deck's
  column, directly above Next turn / Tutor / Reset, with a chevron at each
  end. The arrows are pushed out to the two ends so they are the largest
  targets in that column and cannot be caught when you are aiming at the
  number between them, and the number is tabular with a 3ch floor so the bar
  does not twitch crossing 9→10 or 39→40. The old `Life − 40 +` in the top bar
  is gone rather than duplicated: it is the number you change by hand most
  often, so it belongs with the things you press, not the things you read.
  Verified: 40 → 43 → 41 through the arrows, bar 284px and left-aligned with
  the buttons below it, top bar no longer carries a life control.
- ~~**P10 — Fetch lands.**~~ DONE. Tapping a fetch cracks it rather than
  toggling a tapped state it does not really have. What it can find is read
  off the oracle text rather than kept as a list of card names — the list is
  long, grows every set, and the text already names its own types. Subtypes
  are matched against the *type line*, which is where a Tundra keeps its
  Plains and its Island, so a fetch finds duals as it should.

  Three corrections after your first look, all of which were real:
  the fetch is now sacrificed (it was sitting on the battlefield having paid
  nothing); the land arrives tapped when the fetch says "onto the battlefield
  tapped", overriding what that land would have done arriving under its own
  steam; and a fetch that names exactly one type resolves immediately instead
  of opening a picker for a choice you do not have, preferring a basic over a
  dual carrying the same subtype. Both facts are read from the text, not
  assumed — Flooded Strand sacrifices but does *not* tap what it finds.

  Verified against real oracle text: Terramorphic Expanse and Evolving Wilds
  (basic-only, tapped, sacrificed → picker); Flooded Strand (Plains/Island,
  untapped, sacrificed → picker); Bant Panorama (three types → picker);
  Krosan Verge (Forest *and* Plains — the first regex stopped at the first
  "card" and offered half of what the land finds); Sandsteppe Citadel and
  Rampant Growth correctly not fetches.

- ~~**P14 — Planeswalker loyalty.**~~ DONE. Walkers arrive carrying their
  printed loyalty, on the supplied shield artwork, in the bottom-right corner
  — which is both where the tap symbol used to be and where the number is
  printed on the card itself. The tap symbol is gone from walkers, since they
  do not tap. Two arrows appear either side of the badge on hover only:
  loyalty moves a few times a game, and two live buttons parked on every
  walker are two more things to catch while dragging one around the mat.
  Leaving the battlefield resets loyalty to the printed number — counters do
  not travel between zones, and a walker returning from the graveyard on the
  three it died with would be quietly wrong every time.

  The artwork's viewBox was measured rather than guessed: with the group's own
  translate applied the art lands at exactly 0,0 spanning 444.33 x 270.2, and
  it is landscape at 1.64:1, so the badge box is shaped to match instead of
  letterboxing it into a square. Verified on Ajani, Adversary of Tyrants:
  arrives on 4, steps up and down, floors at 0, no tap symbol, badge seated
  3px from the right edge and 2px from the bottom.
- **P11 / P12 — Dragging behaved like an image.** Two separate causes, one
  symptom, and the first fix was reported as done before the second showed up.

  1. `solidDragImage` tore its clone down on a `setTimeout(…, 0)` and sometimes
     beat Chrome to rasterising it. The clone now lives until `dragend`.
  2. The deck editor *also* called `setDragging(uid)` inside the dragstart
     handler. A discrete-event state update flushes synchronously, so every row
     reconciled before the drag had finished starting, invalidating layout
     while the off-screen ghost was waiting to be painted. Now deferred a tick.

  The playtest surfaces only ever had cause 1 because their dragstart writes to
  a ref, not state — which is what made the command zone the useful control
  case. **Any dragstart handler that sets React state will reintroduce this.**

  **Regression, 2026-08-09 — NEEDS YOUR EYES.** Came back as the washed-out
  card in every context at once (hand, mat, tray, deck). Not a lost call site
  and not the `dragend` fix, both of which were checked and intact: the ghost
  was parked at `left: -10000px`, which is outside Chrome's paint area for the
  same reason `top: -10000px` was — and that was already known and fixed for
  the vertical axis only. Relying on horizontal being treated more leniently
  was relying on a quirk, and when it stops holding Chrome falls back to its
  own translucent snapshot everywhere simultaneously. The clone now sits
  precisely over the element it copied: unconditionally inside the paint area,
  and invisible because it is a pixel-identical copy of what is already there.

  Unverified here, necessarily. One cosmetic risk to watch: if the source gets
  a dimmed "being dragged" style, the undimmed clone sits over it until
  `dragend`, which would read as a card that refuses to fade.

  **Trap for the handoff:** real HTML5 drag needs OS-level mouse input.
  Synthetic events bypass drag initiation entirely and prove nothing, and the
  browser pane cannot screenshot (not compositing) so `left_click_drag` has no
  coordinates. Drag behaviour cannot be verified in this environment — three
  wrong fixes were shipped before asking the user what they actually saw.
  Ask for the observation first: does it not move, move with a wrong ghost, or
  move but not drop?

- ~~**P15 — Fetch placement.**~~ DONE, confirmed working in your window. Two
  things, both in `play()` in `Playtest.tsx`:

  1. The slot was counted from `inZone.battlefield` — React state as captured
     at *render*. Cracking a fetch plays a land and sacrifices the fetch in the
     same tick, so both reads returned the same answer and a two-card fetch
     would deal its second land exactly on top of its first. The count now
     happens inside the `setCards` updater, against `cs`, so each play sees the
     one before it. A card going to hand frees its square for nothing extra:
     the count filters on `zone === 'battlefield'`, so leaving the board is the
     reservation being released.
  2. `play()` takes an optional `seat`, and `crack` hands over the square the
     fetch is vacating — so the land arrives where the fetch stood rather than
     at the end of the row. Only when the fetch actually sacrifices itself: one
     that taps instead is still standing there and its seat is not going spare.

  **This is the one thing in this file that has not been checked in a browser.**
  It typechecks and the reasoning is above; nobody has watched a fetch crack
  since it was written. Verify before trusting: crack an Evolving Wilds and
  confirm the land lands on the square the Wilds vacated and the board count is
  unchanged.

- ~~**P16 — Count mode skips back to 1.**~~ DONE. Clicking a die in count mode sometimes
  goes 3 → 1 rather than 3 → 4. Suspect the click that follows a settle: the
  `threw` guard in `PlayDie.onClick` swallows one click, and something is
  resetting `value` to 1 — `onDoubleClick` sets `{ counting: true, value: 1 }`,
  so a stray double-click detection would do exactly this. Check whether a
  slow second click is being read as a double.
- ~~**P17 — d20 counts to 20.**~~ DONE. Count mode wraps at 6 for both dice, because the
  cycle is hard-coded to a d6. It should wrap at `DIE_SIDES[kind]`.
- ~~**P18 — Playtest picker copy.**~~ DONE. "Pick a deck and it deals you seven. No
  editor, no analysis — just the table." becomes "Pick your deck - cast your
  spells and practice your interaction."
- ~~**P19 — "Goldfish" above Playtest**~~ DONE: becomes "Commander".
- **P20 — Drag a planeswalker back to hand. LIKELY FIXED, NEEDS YOUR EYES.**
  The cause was almost certainly the loyalty badge added in P14: its container
  called `stopPropagation` on pointerdown and covered the card's bottom-right
  corner, so a drag begun anywhere near the badge never started. The container
  is now `pointer-events: none` with only the two arrows taking the pointer,
  and the handler is gone. Drag cannot be verified in this environment (see the
  P11/P12 trap), so this is a reasoned fix rather than an observed one — try
  it, and if a walker still will not move, say *what* it does: nothing, moves
  with a wrong ghost, or moves but will not drop.
- **P21 — Turn counter on the deck.** The remaining-cards counter becomes
  `TURN #`. The card count moves to the deck's hover, replacing "Draw".
- ~~**P22 — History needs a scrollbar.**~~ DONE. The drawer runs off the bottom.
- ~~**P23 — Playtest deck tiles**~~ DONE: should carry Deck Lab's own subtitle — number
  of lines and the date — rather than "N lines · deal seven".

## Deck Lab

Real deck-builder work, as opposed to the Binder clone below.

- ~~**L1 — Move `# cards · $cost` a few pixels left.**~~ DONE. It sits too close to the
  right-hand rule in the editor bar.
- ~~**L2 — Mana base ignores colour-agnostic sources.**~~ DONE. The denominator
  was `sum(produced.values())` — the sum of *colours made*, not the count of
  sources. A five-colour land counted five times, so every extra colour a
  source could make inflated the total that every colour was then judged
  against. A mono-red deck whose fixing also taps for red measured red against
  a total its own lands had quintupled. Now counted once per source card, so a
  share means "what fraction of my sources can make this colour" — and a land
  making any colour satisfies every colour it makes instead of diluting all of
  them. In `server/app/deck/stats.py`.

  Verified against a mono-red shape (30 Mountains + 6 any-colour lands, all
  red pips): the old maths reproduces your screenshot exactly — others +10%,
  Red −40% — and the new one puts **Red at 0.0%**. A two-colour deck stays
  sane. The server needs a restart to pick it up.
- **L3 — Mono-red cannot reach 100%** in the Card costs / Land mana donut.
  Related to L2 but *not* fixed by it, and it needs a decision rather than a
  patch. The inner ring plots `produced` per colour as slices of one circle,
  and those sets overlap: an any-colour land is in all five at once. Overlapping
  sets do not sum to a whole, so no denominator makes a mono-red deck's red
  slice reach 100% while the other colours still show the fixing they really
  have. Either the inner ring stops being a donut — five small bars, each "% of
  sources that can make this colour", which is what L2's `source_share` now
  says — or it keeps the donut and plots something that genuinely partitions,
  such as each source's *primary* colour. The first is honest; the second keeps
  the shape. Ask before building.
- ~~**L4 — Approve button on name resolution.**~~ DONE. Approve *writes the
  match down*: a fuzzy line is re-flagged on every analysis because the raw
  text still says "Phial of Galadrl", and agreeing with the guess in your head
  does not change the file. It rewrites the line to the resolved name — the
  same edit picking an alternative makes — which is the only thing that
  actually settles the question. Hidden when there is nothing to approve or
  the text already says it. Styled with `--ok` rather than the accent, which
  on that row already means "use this other one instead".

  Verified: "Braid of Fre" → approve → the decklist now reads "Braid of Fire",
  the raw spelling is gone, and the row stops being flagged.
- ~~**L5 — Move the name-resolution panel.**~~ DONE: below "How this deck
  works" and above the decklist, in the text view. It reports on lines you
  typed and the fix is to edit one, so in the analysis tab it was a verdict
  delivered a pane away from the thing it was judging. Verified by measured
  order: description 401, panel 541, decklist 703.
- ~~**L6 — Normalise imported lists.**~~ DONE. `serialize` wrote
  `${quantity} ${name}` and dropped the printing entirely, so every trip
  through the editor flattened a precise list into a vague one. It now writes
  `1 Card Name (SET) 123`, both halves or neither — `(FDN)` with no number is
  not the canonical form and is no more precise than the bare name. Set codes
  are upper-cased; Scryfall stores them lower and every printed list writes
  them upper.

  Verified on a 62-card deck: **62 of 62** lines canonical after a real
  serialize, foreign markers like `*CMDR*` gone (the commander is the section
  header in this format), and double-faced cards normalised to `//`.

- **L7 — Imports do not honour the printing they arrive with.** Found while
  verifying L6, and it is the other half of the same job. Round-tripping the
  deck rewrote `Arcane Bombardment (SNC) 101` as `(OTC) 154`: the resolver
  matches on *name* and picks its own printing, so the set and collector
  number in an imported line are parsed and then thrown away. L6 means the
  list now always states a printing — this is what makes the stated printing
  the one you actually chose. Resolve by `(set, collector_number)` first and
  fall back to the name only when that pair finds nothing.

## Deck sleeves

- ~~**S2 — Per-deck sleeve art.**~~ DONE. A `Sleeves` button beside the
  `Commander` label; once set the label reads `COMMANDER · SLEEVED` with a
  reset beside it. The art sits behind the commander, offset down-right, the
  way a sleeved card shows its back past two edges of the card in front. In
  Playtest the deck pile wears it — the pile is the one place on the mat you
  only ever see the back of a card, so it is the one place sleeves can show.

  The tilt was the detail worth getting right: the sleeve is a *sibling* of
  the tilted link, not a child, so the commander keeps its pointer tilt and
  the sleeve stays flat behind it. A stack on a table does not swing as one
  piece. Verified: sleeve is not inside the tilted element and holds
  `translate(7px, 7px)` while the card tilts.

  **Stored per-machine, not on the deck** (`lib/sleeves.ts`, localStorage
  keyed by deck id, 1.5MB cap, rejects rather than silently re-encoding). A
  sleeve is how *your* copy looks; the decklist is what you export and paste
  to a friend, and a megabyte of base64 riding inside it would burden every
  save, analysis and export. The honest cost: sleeves do not travel with an
  exported list or to another machine. If that turns out to be wanted, the fix
  is a sleeves table keyed by deck id — not a blob in the list.

  Verified end to end on deck 185: upload → label flips, art appears behind at
  z-index 0, stored under the deck id; playtest pile picks it up as a cover
  background; reset clears art, label and storage together.

  Offset settled at +18/-20, and the card now moves down when sleeved. The
  sleeve is absolutely positioned, so riding it up made it reach into the
  heading without making its own box any taller — the space it needs has to be
  reserved separately. Both numbers are `--sleeve-x` / `--sleeve-y` on
  `.commander-stack` now, with the margin derived as `4px + var(--sleeve-y)`:
  two literals would drift apart the first time either was nudged, and this
  was nudged four times. Verified: 14px clear of the heading when sleeved,
  and the reserved space appears *only* when sleeved (24px vs 4px).

  Final round: offset +14/-20, square corners on the sleeve (a sleeve is a
  straight-cornered pocket; rounding it read as a second card peeking out
  rather than as the thing the card sits in), and the shimmer pinned to the
  card. That last one: hovering lifts and scales the *image*
  (`translateY(-4px) scale(1.02)`) while the sheen is a pseudo-element on the
  link, so the card moved out from under its own highlight — which is exactly
  the gap you saw at the top and left edges. The sheen now carries the same
  transform and easing, so they move as one. Verified identical by reading
  both rules back off the stylesheet.

  A further round: offset raised to +11/-15, the sleeve stretched to the card's
  exact box (`object-fit: fill` — a backing is better seen whole than
  well-cropped), and the tilt sheen stopped spilling. That last was a knock-on
  I caused: `.commander-card > a` sized the link, and wrapping the commander in
  `.commander-stack` pushed the link a level down so the rule stopped matching.
  The link then stretched to the panel's full width, and because the sheen is
  an `inset: 0` pseudo-element on the link, it lit a box wider than the card.
  The stack is now `width: max-content`, so link, sheen and sleeve are all
  measured against the card itself. Verified: stack, link and card all 290px,
  and a 400x120 test image stretched to the card's box.

  Three corrections after your screenshots, all mine and all worth keeping:
  the sleeve offsets **up** and to the right, not down — down-and-right read as
  a drop shadow of the card rather than as something the card sits inside; the
  dimming filter and shadow are gone, which had made it look like a second,
  badly-composited card; and the heading is one row again. That last one had a
  cause worth noting: `.chart-head` is `flex-direction: column` elsewhere,
  because charts stack a label over a value, so a heading that carries controls
  has to say `row` explicitly or its buttons pile up under it and float over
  the card. Verified: heading 16px tall with all three children on one row,
  sleeve at +9/-9, `filter: none`, `box-shadow: none`.

  (original ask) **Per-deck sleeve art.** An upload button immediately right of the
  `Commander` label. Once uploaded the label reads `COMMANDER · SLEEVED` with a
  reset symbol beside it that clears the image. The art shows offset *behind*
  the commander card; the commander keeps its tilt animation while the sleeve
  image stays flat. In Playtest, a deck with sleeves uses that art for the deck
  pile. See the two reference screenshots in the conversation of 2026-08-09.

## Glossary

- ~~**G1 — Learning modules.**~~ DONE. Four of them at the top of the
  Glossary — Searching properly, Keeping a search, Deck Lab, The playtest mat
  — with the artwork to their right on a slow 7s drift, and a tick per module.

  The content rule was the hard part and is worth keeping: nothing here
  explains that fetch lands fetch or that walkers carry loyalty, and there is
  no lesson for Sets or Settings. What is left is only what is genuinely not
  discoverable — the operators (including the `*` wildcard the API lacks, and
  `c:` vs `id:`), that a saved search stores the *query* so it re-runs, what
  the four category buttons actually ask the server, and the playtest
  gestures, which no label mentions.

  Two deliberate calls: the tick is yours to set rather than inferred, because
  this cannot observe whether you understood something and watching which
  pages you opened to guess would be both creepy and wrong; and a ticked
  lesson goes *quieter* rather than getting decorated, so the ones you have
  not done are what the eye lands on.

  Verified: 4 modules, artwork loaded in its own column, expanding shows the
  steps, the tick does not collapse the panel, and the state survives a reload
  (`["deck-lab"]`). The drift is unverified — rAF animation, same pane trap.

  Also added `web/src/vite-env.d.ts`, which was missing: without it no asset
  import typechecks.

  (original ask) **Learning modules, at the top of the Glossary**, with
  `web/src/assets/glossary-lessons.png` to their right, animated slightly.
  Each module shows a tick when complete and nothing when not.

  Modules cover **how to use this app**, not how to play Magic. Advanced search
  syntax; saving and recalling previous searches; Deck Lab and what its
  controls, searches and AI actually do; Playtest mechanics — the dice, the
  coin, the mat.

  Explicitly **not**: anything self-evident (Sets, Settings, what a search box
  is), and no game rules. Not "fetch lands fetch", not "planeswalkers have
  loyalty", not "this is your graveyard", not "here is your commander", not
  "this is what the analysis chart means". If a player would already know it,
  or the screen already says it, it is not a module.

## Binder

The Binder is a *clone* of the deck builder, and everything in this section
applies to that clone only. The deck builder itself is not being changed —
B1 through B10 were written up under a "Deck builder" heading by mistake, and
touching the real editor to satisfy any of them would be wrong.

**B11 is the one to build first**, because the rest are changes *to* it.

**B11 is mostly built. One defect blocks it — read this first.**

`busy` never clears on `/binder`, so Save, Playtest, Copy, Export and the
category buttons all stay disabled and the binder cannot be written. Everything
else works. What is known: the load effect sets `setBusy('load')` and clears it
in `.finally`; in binder mode the chain is `api.savedDecks().then(find by name
-> loadDeck | null)` instead of `api.loadDeck(id)`, and when no binder exists
yet that resolves to `null` and returns early inside `.then`. The `.finally`
should still run. `analyseText` does not touch `busy`, and no error is shown.
Suspect the StrictMode double-invoke interacting with `cancelled`, or a second
effect re-setting `busy` — instrument `setBusy` before changing anything.

Done and verified: the `/binder` route, the nav tab right of Glossary, sections
reading **Bulk / Trades / Fav** with no Commander, and Recommendations,
Pipeline and AI recommend all absent. Save writes to the reserved name so it
cannot fork into a second binder, and the gallery filters it out — both
written, neither reachable until the `busy` defect is fixed.

Still to do: the category buttons (Ramp / Removal / Counters / Draw) becoming
filters over the list rather than requests to the server. That is the piece
with real design left in it.

What exists, and is sound:

- `web/src/lib/binder.ts` — the binder's identity. It is stored as an ordinary
  saved deck under the reserved name `__binder__`, which is the whole design:
  a second storage path would need its own save, load, serialise and migrate
  to hold a shape the deck store already holds. `BINDER_SECTIONS` relabels the
  deck model's *existing* keys — `main`→Bulk, `sideboard`→Trades,
  `maybeboard`→Fav, no commander — so what is written to disk stays a
  perfectly ordinary decklist and every mechanism that reads one keeps
  working. That is what "a deck in every mechanical sense" buys.
- `DeckEditor` takes a `binder` prop and swaps its section tabs accordingly.
- `DeckPage` takes a `binder` prop and no longer treats a missing `:deckId`
  as "new" when in binder mode.

Still to do, in order:

1. The `/binder` route in `main.tsx` and the nav link in `Layout.tsx`, right
   of Glossary (`NAV` array, line ~20).
2. Load-by-name on mount and create-on-first-save, since the binder has no
   route parameter to find itself by.
3. Filter `__binder__` out of the deck gallery — `isBinder` is written and
   currently unused. **Do this in the same pass as 1 and 2**, or the binder
   shows up as a deck called `__binder__` the moment it is first saved.
4. Hide Commander, Recommendations, Pipeline and AI recommend. The tab buttons
   are around `DeckPage.tsx:739-753`; `tab` is a four-way union that will need
   narrowing or guarding in binder mode.
5. Ramp / Removal / Counters / Draw become filters over the list rather than
   requests for recommendations. This is the only part with real design left
   in it: the categories currently come back *from the server* per deck, and a
   filter needs them computed over the cards already in the binder.

- **B11 — New Binder tab, right of Glossary.** A deck in every mechanical
  sense, but singular, never listed among decks, and titled Binder. Hide
  Commander, Recommendations, Pipeline and AI recommend. Ramp / Removal /
  Counters / Draw stay where they are but act as filters over the list below.
  Sections are **Bulk, Trades, Fav** rather than commander/deck/sideboard/
  maybeboard.

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

## Settings

- **S1 — Backup and restore.** Export decks (and the Binder, and collected
  cards) to a local file and read it back. JSON unless there is a reason not
  to.

- ~~**S3 — Dice and coin skins.**~~ DONE. Eight dice finishes (including two
  patterned — Marble and Speckled) and six coin metals, in a new **Table**
  panel in Settings. Each swatch paints itself with the skin it offers, so the
  choice is made by looking rather than by reading a name.

  A skin is a handful of custom properties, not a stylesheet or an asset: the
  dice and coin are already drawn entirely in CSS, so a skin only says which
  colours those rules reach for. Every property falls back to the value the
  rule was written with, so an unskinned table is the *original* object rather
  than a skin that resembles it. The coin's reverse is `color-mix`ed a shade
  darker from the same four stops instead of carrying a second palette, so a
  new metal is six values, not twelve.

  Verified: Obsidian + Silver chosen in Settings, stored, and reaching the mat
  — face border `rgb(69,75,96)`, pips `rgb(232,236,255)`, silver coin gradient.

- ~~**P24 — d20 larger, and its slot the right shape.**~~ DONE. The silhouette
  is drawn at 1.2x with a 17px numeral, but the element is still exactly 46px:
  every placement in `PlayDie` — tray centring, mat span, bin hit test — is
  computed against `DIE_PX`, so widening the box would have put the d20 a few
  pixels outside its own slot, which is precisely the bug that had them
  stacking down the board. The shape overflows; the geometry does not move.

  The d20's slot is now the hexagon it holds, drawn as an SVG background using
  the hull's own points. Not a bordered box: `clip-path` on a dashed border
  cuts the dashes into solid edges along the cut, and CSS has no hexagonal
  border. Verified: shape at `scale(1.2)`, box still 46px, hex background on
  the d20 tray only, d6 tray still a dashed box.

  (original ask) **Dice and coin skins.** A picker in Settings: a set of colours and
  patterns for the dice, and a set of metal finishes for the coin. Generated
  rather than uploaded — no asset pipeline needed. The d6 pips and the d20's
  drawn shell both take the colour, so a skin is a couple of custom properties
  on `.pt-die` rather than a second copy of either. The coin already carries a
  struck-metal gradient (see P8); a finish swaps its two stops.

## Documentation

- **R1 — A thorough README**, with a section teaching the search syntax and a
  section on the tray icon.

## New batch (2026-08-12)

- **P25 — Deck pile sits too high.** Shift the deck and the cards-left number
  slightly lower in the playtest corner.
- **P26 — Reset button should be red**, matching the confirmation button it
  opens. It is the one control there that throws the board away.
- **L8 — Rootbound Crag entered untapped** with no Mountain and no Forest on
  the battlefield. Check-land logic in `server/.../landTiming` (or
  `web/src/lib/landTiming.ts`) is reading the condition the wrong way round, or
  matching the subtype against the wrong zone. Reproduce with an empty board.
- **A1 — Set field in Advanced search** should list the most recent few sets
  when empty, and narrow to what you type as you type. Currently neither.
- **G2 — Cards tray opens a little short.** Its default height clips content.
- **G3 — Drop the second "Back" and "Reference" eyebrow** now sitting under the
  Glossary heading; the Lessons head introduced a duplicate.
- **G4 — Bigger artwork, smaller lesson bars.** The image should carry more of
  the block and each lesson should take less height.
- **G5 — A navigation lesson**, describing what each tab is for. It is the one
  lesson that should exist for someone who has just opened the app.
- **G6 — Lessons become a guided walkthrough.** Rather than an expandable list
  of steps, a lesson should move you to the page it is talking about and point
  at things: help boxes with arrows, and everything that is not the subject
  dimmed. This supersedes the accordion built in G1 — keep the module list and
  the ticks, replace the body.
