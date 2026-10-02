/**
 * Lessons: how to drive this app.
 *
 * Deliberately not how to play Magic. Nothing here explains that fetch lands
 * fetch, that planeswalkers carry loyalty, or what a graveyard is — a player
 * opening a deck builder already knows all of that, and being told it is
 * faintly insulting.
 *
 * What is left is the part that genuinely is not discoverable: the operators
 * the search bar accepts, what the four category buttons actually ask for,
 * the parts of the playtest mat that answer to a gesture rather than a click,
 * and what the table does by itself once it is playing by the rules.
 * "Getting around" is the exception that names every tab, including the two
 * that explain themselves — saying what a tab is *for* is a different question,
 * and every other lesson assumes you already know where you are.
 *
 * A step points at something real. `route` is where it is shown and `target` is
 * a selector for the thing being talked about; a step with neither is a plain
 * card in the middle of the screen. **Every selector here is a promise about
 * the DOM** — when one stops matching, the walkthrough quietly degrades to a
 * centred card, so they are worth re-checking whenever markup moves.
 *
 * **Name every control exactly as it is labelled, in full, and say what
 * pressing it does.** "Refreshing builds beside the copy you have" names no
 * button and describes an implementation; "Press **Update Card Pool** to start
 * importing the new card list in the background" names the thing on screen and
 * the outcome. If a control is an icon, print the icon (`**☆**`). If the label
 * changes while it works, the resting label is the one to use. A step the
 * reader cannot act on without hunting for the control has failed.
 *
 * **Write the step as an instruction, not an observation.** "AI recommend is
 * the slow one" is a remark about a button; "Press **AI recommend** to have the
 * local model suggest cards" tells the reader what to do and what happens.
 * Cut similes, cut asides, cut anything that flatters the software. State the
 * control, the action, and the consequence, in that order.
 *
 * **Give a step a `target` whenever it names one thing.** A step about a
 * specific button that highlights nothing makes the reader hunt for it. Only a
 * step describing something with no single home on screen -- a gesture, a rule
 * about how the tray behaves -- should go untargeted.
 *
 * Text takes `**bold**` and `` `code` `` and nothing else. Two markers are
 * enough to name a control and to set an operator apart from the prose around
 * it, and a fuller markdown parser here would be a dependency in aid of text
 * we write ourselves.
 */
export interface Step {
  text: string
  /** Where the step is shown. Omitted means "wherever you already are". */
  route?: string
  /**
   * Show this step inside a real deck, resolved when the lesson runs.
   *
   * A lesson about the deck editor has to be *in* the deck editor, and the
   * editor needs a deck. Which deck cannot be written down here: ids belong to
   * whichever database made them, and the obvious candidate is deletable.
   * So the tour looks for one when it gets here — Minsc by preference, since
   * it is the deck this app seeds and therefore the one most installs have —
   * then any other deck, and only then gives up and shows the gallery.
   */
  example?: 'deck' | 'playtest' | 'simulate'
  /** Appended to the example's path, for a page that opens on the wrong tab
   *  for what the step is about. `mode=text` opens the deck editor on Text. */
  exampleQuery?: string
  /** What it points at. Omitted means a centred card with no arrow. */
  target?: string
}

export interface Lesson {
  id: string
  title: string
  blurb: string
  steps: Step[]
}

export const LESSONS: Lesson[] = [
  {
    id: 'navigation',
    title: 'Getting around',
    blurb: 'What each tab does.',
    steps: [
      {
        route: '/',
        target: '.nav a[href="/"]',
        text: '**Search** searches the whole card pool. Type a card name, or an operator query.',
      },
      {
        target: '.nav a[href="/advanced"]',
        text: '**Advanced** builds the query for you, so you do not have to type operators.',
      },
      {
        target: '.nav a[href="/deck"]',
        text: '**Deck Lab** manage your decks. Search for recommendations and view statistics.',
      },
      {
        target: '.nav a[href="/playtest"]',
        text: '**Playtest** deals an opening hand and plays the deck by the rules: turns, mana and the stack. Switch **Rules** off there for a free table.',
      },
      {
        target: '.nav a[href="/sets"]',
        text: '**Sets** browse sets of cards.',
      },
      {
        target: '.nav a[href="/glossary"]',
        text: '**Glossary** information and lessons.',
      },
      {
        target: '.nav a[href="/binder"]',
        text: '**Binder** manage your collection of cards. Your binder can be applied as a filter in search queries.',
      },
      {
        target: '.nav a[href="/settings"]',
        text: '**Settings** settings and backup management.',
      },
      {
        target: '.nav-tray',
        text: '**Cards** is a tray that slides over the current page. It holds cards.',
      },
    ],
  },
  {
    id: 'search-syntax',
    title: 'Searching properly',
    blurb: 'The operators, and the two this app has that Scryfall does not.',
    steps: [
      {
        route: '/',
        target: '.search-input-wrap',
        text: 'Filters combine with spaces and all of them must match. `t:creature c:rg mv<=3` returns red-green creatures of mana value 3 or less.',
      },
      {
        target: '.search-input-wrap',
        text: '`c:` matches a card’s color, `id:` its color identity. Both take *these and possibly more*, so `c:wgu` includes five-color cards. Use `<=` for a ceiling: `id<=wgu` is the right filter for a three-color commander deck.',
      },
      {
        target: '.search-input-wrap',
        text: 'The comparison operators are `>`, `<`, `>=`, `<=` and `=`. `pow>=4 tou<=2` returns high-power, low-toughness creatures. Quote any value containing a space: `o:"whenever you cast"`.',
      },
      {
        target: '.search-input-wrap',
        text: '`*` is a wildcard. `n:thal*` matches Thalia, Thallid and Thraben.',
      },
      {
        target: '.search-input-wrap',
        text: 'In rules text, `_` matches any run of text and `#` matches any creature type. Magic writes “Other Dinosaurs you control have haste”, so `o:"#_have haste"` finds every tribe that does it.',
      },
      {
        target: '.search-input-wrap',
        text: 'Prefix a query with `q:` to write it in plain words. `q: cheap green creatures that draw a card` is sent to the local model, which converts it to an operator query and runs that.',
      },
      {
        // No target: the badge is a column of Recent searches, which is only
        // there once something has been searched for.
        text: 'A `q:` search returns only cards that exist, because the model writes a query rather than a list. It is slower than a plain search. The **Engine** column under **Recent searches** names which engine answered each query.',
      },
      {
        // These two sit above the results, so they are only on screen once a
        // search has run; the text says so for when it has not.
        target: '[data-tour="in-binder"]',
        text: 'Run a search, then press **In binder** above the results to outline every card you already own in gold.',
      },
      {
        target: '.search-input-wrap',
        text: '`binder:true` returns only cards in your binder, and `-binder:true` only cards that are not. Combine it like any other filter: `binder:true t:creature id:bg`.',
      },
      {
        target: '[data-tour="toggle-overlay"]',
        text: 'Press **Toggle Overlay** above the results to keep prices on the cards instead of showing them on hover. In a deck or the binder it shows the quantity too.',
      },
      {
        target: '.nav a[href="/advanced"]',
        text: 'Press **Advanced** to build the same query from a form.',
      },
    ],
  },
  {
    id: 'advanced',
    title: 'The Advanced form',
    blurb: 'The same search, built by clicking.',
    steps: [
      {
        route: '/advanced',
        target: '.adv-form',
        text: 'Every row here writes part of a query.',
      },
      {
        target: '.query-preview',
        text: 'The query updates live. Press **Copy** to take it, or **Search with these options** to run it.',
      },
      {
        target: '.checks',
        text: 'Press **Only Binder** under **Collection** to restrict a search to cards you own, or **Not in Binder** for everything you do not. `binder:true` and `-binder:true`.',
      },
    ],
  },
  {
    id: 'recent-searches',
    title: 'Recent searches',
    blurb: 'The last few queries, and how to stop one ageing out.',
    steps: [
      {
        route: '/',
        target: '.history',
        text: 'Search history can be used to save custom queries. Usually you will have a few for one deck.',
      },
      {
        target: '.history',
        text: 'This table keeps the last five unpinned queries. Older ones are dropped.',
      },
      {
        target: '.history',
        text: 'Press **☆** on a row to pin that search. Pinned searches stay at the top and survive **Clear**. Running one again updates its counts in place.',
      },
    ],
  },
  {
    id: 'deck-lab',
    title: 'Deck Lab',
    blurb: 'The two editors, the four category buttons, and the model.',
    steps: [
      {
        route: '/deck',
        target: '.gallery-head',
        text: 'Every deck you have saved. Open one to edit it.',
      },
      {
        example: 'deck',
        target: '.editor-bar',
        text: 'Press **List** or **Images** to change how the deck is shown. Press **Shuffle** to go through a section one card at a time and decide on each.',
      },
      {
        example: 'deck',
        exampleQuery: 'mode=text',
        target: '.decklist-input',
        text: 'Press **Text** to paste or type a whole list; several list formats are read. Lines that did not match a card exactly are listed under the description. Press **Approve** to write the matched name into the list.',
      },
      {
        example: 'deck',
        exampleQuery: 'tab=recommendations',
        target: '.cat-buttons',
        text: 'Press **Recommendations**, then **Ramp**, **Removal**, **Counters** or **Draw** to show cards that do that job and fit the deck.',
      },
      {
        example: 'deck',
        exampleQuery: 'tab=recommendations',
        target: '[data-tour="ai-recommend"]',
        text: 'Press **AI recommend** to have the local model suggest cards. It uses the deck description under **TEXT** as part of its prompt. A run takes a minute or more.',
      },
      {
        // The row of tabs, not the Pipeline tab: that one exists only while
        // there is a run to watch.
        target: '.result-tabs',
        text: 'While the model works, a **Pipeline** tab appears in this row and shows its progress. When the run finishes it becomes **AI Recommendations**, holding that run\'s cards — separate from the **Recommendations** tab, so asking for either one never throws the other away.',
      },
      {
        // Back to Build and Analysis, where the next three steps are.
        example: 'deck',
        exampleQuery: 'mode=build&tab=analysis',
        target: '.commander-card',
        text: 'A deck can have two commanders when the pair is legal — Partner, Friends forever, a Background, or a Doctor and its companion. Put both in the Commander section and their Colors combine.',
      },
      {
        example: 'deck',
        exampleQuery: 'mode=build&tab=analysis',
        text: 'Hover a card and press **Printing** to choose which edition you own.',
      },
      {
        example: 'deck',
        exampleQuery: 'mode=build&tab=analysis',
        target: '.sleeve-add',
        text: 'Press the **Sleeves** button to add sleeves to your deck.',
      },
      {
        target: '[data-tour="deck-bar"]',
        text: 'Press **Playtest** to deal this deck onto a table, or **Simulation** to simulate a few thousand games and read the averages. Press **Copy** to duplicate the deck, and **Export** to write its list out as text.',
      },
    ],
  },
  {
    id: 'cards-tray',
    title: 'The Cards tray',
    blurb: 'The scratch pile you gather results into.',
    steps: [
      {
        route: '/',
        target: '.nav-tray',
        text: 'Press **Cards** to open the tray. It slides over the current page.',
      },
      {
        text: 'Drag cards from the search result into the tray.',
      },
      {
        text: 'Drag cards from the tray onto a deck section to add them. Drag a card from a deck into the tray to remove it from that deck.',
      },
      {
        text: 'The tray can be resized by dragging the bottom edge.',
      },
    ],
  },
  {
    id: 'binder',
    title: 'The Binder',
    blurb: 'Manage your cards.',
    steps: [
      {
        route: '/binder',
        target: '.section-tabs',
        text: 'Binder for your owned cards. Its sections are **Bulk**, **Trades** and **Fav**. Drag cards between them.',
      },
      {
        target: '.color-filter',
        text: 'Press a pip to remove that color from the list of cards.',
      },
      {
        target: '.cat-buttons',
        text: 'Press **Ramp**, **Removal**, **Counters** or **Draw** to show only cards you own that do that job. In a deck these buttons suggest cards you lack; here they filter what you have.',
      },
      {
        target: '.deck-info',
        text: 'The counts and the mana curve are computed from the filtered list, not the whole binder.',
      },
      {
        target: '[data-tour="bulk-edit"]',
        text: 'Press **Bulk Edit** to file several cards at once. Click a card to tick it, then press **Bulk**, **Trades** or **Fav** to move everything ticked there.',
      },
      {
        target: '[data-tour="tab-search"]',
        text: 'Press the **Search** tab to look a card up and add it without leaving the binder.',
      },
      {
        text: 'Hover a card and press **Printing** to choose which edition of it you own.',
      },
    ],
  },
  {
    id: 'settings',
    title: 'Settings',
    blurb: 'Card data, backup, the dice, and the model.',
    steps: [
      {
        route: '/settings',
        target: '[data-tour="card-data"]',
        text: '**Card data** reports the age of your local Scryfall copy and whether a newer one exists. When one does, a gold **+** appears next to the card count on the Search page.',
      },
      {
        target: '[data-tour="card-data"]',
        text: 'Press **Check now** to ask Scryfall whether newer data exists. It downloads nothing.',
      },
      {
        target: '[data-tour="update-pool"]',
        text: 'Press **Update Card Pool** to import the new card list in the background. It replaces the old copy when it finishes. Searching works throughout.',
      },
      {
        target: '[data-tour="backup"]',
        text: 'Press **Export** to create a backup file. **Restore** puts the app back exactly as it was when that file was made — decks not in it are deleted and your collected cards are replaced, so it asks you to confirm first.',
      },
      {
        target: '[data-tour="tabletop"]',
        text: 'Press a swatch to change the dice and coin finish. Throw the dice beside the swatches to preview it. The d20 is set separately from the d6.',
      },
      {
        target: '[data-tour="local-model"]',
        text: 'Press the **Model** dropdown to choose the model that answers a `q:` search. Each option lists the video memory it needs. A model larger than your GPU still runs, but spills into system memory and takes minutes per search.',
      },
      {
        target: '[data-tour="local-model"]',
        text: 'Press **Save** to apply the model. If it is not installed, the panel prints the `ollama pull` command to run.',
      },
    ],
  },
  {
    id: 'deck-stats',
    title: 'Reading the charts',
    blurb: 'The curve, the ring, and what the mana base is actually measuring.',
    steps: [
      {
        route: '/deck',
        example: 'deck',
        target: '.chart.wide',
        text: 'The curve counts nonland cards by mana value, stacked by color. Lands are left out: they cost nothing and would pile onto zero.',
      },
      {
        target: '.chart-grid',
        text: 'The ring shows what your cards cost against what your lands make. Only the commander’s Colors appear — a land that taps for blue in a deck with no blue commander is a land, not a blue source.',
      },
      {
        target: '.balance',
        text: '**Mana base** is sources per pip: how much of your mana works for a color, divided by how much that color is asked for. The weakest color is marked in amber.',
      },
      {
        target: '.balance',
        text: 'Each source is split between the Colors it makes. A dual counts a half to each, a triome a third, a five-color land a fifth — or a quarter, if the commander only allows four.',
      },
    ],
  },
  {
    id: 'simulation',
    title: 'Simulation',
    blurb: 'Shuffle the deck a few thousand times and read the averages.',
    steps: [
      {
        route: '/deck',
        example: 'simulate',
        target: '[data-tour="sim-controls"]',
        text: 'Choose how many games and how many turns to simulate, then press **Run simulation**.',
      },
      {
        target: '[data-tour="sim-drops"]',
        text: '**Missed a drop** is the share of games where some turn had no land in hand. **First miss** is the turn it usually happened on.',
      },
      {
        target: '.sim-table',
        text: 'Results averaged over games: mana available, lands and accelerants on the board, and how many Colors it could actually produce.',
      },
      {
        target: '.sim-table',
        text: 'Wondering why first turn says 0.99 lands and 0.56 mana? 0.99 is because a land drop was missed on turn one, likely one occurrence out of the thousands. 0.56 because sometimes a tapped land was played turn one and tapped lands do not contribute until turn two.',
      },
      {
        target: '[data-tour="sim-sources"]',
        text: 'Press **Lands**, **Rocks** or **Dorks** to toggle results.',
      },
      {
        text: 'It is a mana simulation, not a game. No spell is cast except a rock or a dork, one land is played per turn whenever the hand holds one, and anything entering tapped or summoning-sick pays nothing until the next turn.',
      },
    ],
  },
  {
    id: 'playtest',
    title: 'The playtest mat',
    blurb: 'The table and its tools, and the gestures no label tells you about.',
    steps: [
      {
        route: '/playtest',
        target: '.deck-tile',
        text: 'Press a deck to deal it onto the table.',
      },
      {
        example: 'playtest',
        target: '.pt-actions',
        text: 'Seven cards are dealt and nothing is drawn yet. Press **Start turn** to begin turn 1 and draw a card. Clicking the deck does the same.',
      },
      {
        target: '.pt-actions',
        text: 'Press **Reset** to clear the board, deal a new hand and return the dice to their slots; it asks you to confirm. There is no mulligan. To go down a card, drag one from your hand onto the deck before you start the turn: it goes to the bottom.',
      },
      {
        target: '.pt-deck',
        text: 'Click the deck to draw one card. Hover it to see how many cards are left. A card dragged onto the deck once the turn has started goes on top.',
      },
      {
        target: '.pt-actions',
        text: 'Press **Tutor** to search your library and put a card in your hand. It also lists the tokens this deck can make; press one to create it.',
      },
      {
        target: '.pt-shuffle',
        text: 'Press **Shuffle** to shuffle the library.',
      },
      {
        target: '[data-tour="pt-undo"]',
        text: 'Press **Undo** to take back your last action. **Ctrl+Z** does the same. There is no redo.',
      },
      {
        text: 'Drag a card onto the mat, a pile, your hand or the deck to move it by hand. A move made this way is not checked against the rules.',
      },
      {
        target: '.pt-life',
        text: 'Press the arrows beside your life total to change it.',
      },
      {
        target: '.pt-opponent',
        text: 'Click **Opp** to take one life from the opponent. Shift+click gives one back.',
      },
      {
        target: '.pt-coin',
        text: 'Press the coin to flip it.',
      },
      {
        // The whole tool column, not one tray. The dice are *positioned by
        // script* after the mat lays out, so a highlight pinned to a single
        // empty slot sits beside them rather than on them.
        target: '.pt-tools',
        text: 'Flick a die to throw it. Drag it to move it without rolling.',
      },
      {
        target: '.pt-tools',
        text: 'Double-click a die on the board to switch it to counting mode. Each click then steps its number. Throw it to return it to rolling mode.',
      },
      {
        target: '.pt-die-bin',
        text: 'Drag a die out of its slot and a replacement appears there. Drag a die onto this bin to remove it.',
      },
      {
        target: '.pt-history-tab',
        text: 'Press **History** to open the log of everything that has happened this game.',
      },
      {
        text: 'Click a fetch land on the battlefield to crack it. It tutors a land, goes to the graveyard, and the fetched land enters tapped if its text says so.',
      },
      {
        text: 'A planeswalker enters with its printed starting loyalty. Press the arrows on its badge to change the counter.',
      },
    ],
  },
  {
    id: 'playtest-rules',
    title: 'Playing by the rules',
    blurb: 'Turns, mana and the stack, and what the table does without being asked.',
    steps: [
      {
        route: '/playtest',
        example: 'playtest',
        target: '[data-tour="pt-rules"]',
        text: 'With **Rules** on, the table enforces turns, costs and the stack. Press **Rules** to switch them off for a free table where nothing is checked.',
      },
      {
        target: '.pt-phase-steps',
        text: 'The bar shows the turn and its steps. Press a step to pass priority until the game reaches it.',
      },
      {
        target: '.pt-hand',
        text: 'Cards you can play now are outlined. Click the top of a card to play it, or the bottom to read it. A card you cannot play says why.',
      },
      {
        text: 'Mana is tapped for you when you cast a spell. Hover a card in your hand to see which lands it would tap. Click a land to tap it for mana yourself.',
      },
      {
        target: '.pt-phase-land',
        text: '**Land** counts the lands you have played this turn against how many you may.',
      },
      {
        text: 'When a card can be cast more than one way — kicker, evoke, convoke, a free spell — the table asks which. Press **Not now** to leave the card where it is.',
      },
      {
        target: '.pt-actions',
        text: 'The first button passes priority, and its label says what that will do: **Resolve**, **Combat**, **Main 2**, **End turn**. **Space** presses it.',
      },
      {
        text: 'A spell or ability resolves by itself unless you could respond with an instant or an ability. When you could, it waits in the **Stack** panel: press **Resolve** when you are ready.',
      },
      {
        text: 'A turn with nothing left to play or activate passes by itself. So does the next one, until there is something you can do or the table has a question.',
      },
      {
        text: 'When a creature can attack, the table asks at combat. Click the creatures that attack, or press **All**, then press **Attack**. Press **No attack** to skip combat.',
      },
      {
        text: 'Press **⚡** on a permanent to list its abilities and activate one. A card in your hand or graveyard with an ability of its own has a **⚡** too.',
      },
      {
        text: 'Cards you may play from somewhere else — exile, the graveyard, the top of your library — are shown at the end of your hand, each labelled with where it is.',
      },
      {
        text: 'Shift+click a permanent to tap or untap it by hand. Hover a creature and press **+** or **−** to change its +1/+1 counters.',
      },
      {
        target: '[data-tour="pt-coverage"]',
        text: 'The percentage is how much of this deck the table plays by itself. Press it to list the cards it leaves to you. When one of those resolves, its text is posted under **By hand**: carry it out, then press **Done**.',
      },
      {
        target: '[data-tour="pt-rules"]',
        text: 'With **Rules** off, press **Next turn** to untap everything, draw a card and advance the turn. Hover a permanent and press **⟳** to tap it.',
      },
    ],
  },
]

const KEY = 'insight-enigma:lessons-done'

/** Which lessons are ticked. Stored as a list of ids so a lesson that is
 *  renamed or removed simply stops matching, rather than corrupting a map. */
export function readDone(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '[]')
    return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : []
  } catch {
    return []
  }
}

export function writeDone(ids: string[]) {
  try { localStorage.setItem(KEY, JSON.stringify(ids)) } catch { /* private mode */ }
}
