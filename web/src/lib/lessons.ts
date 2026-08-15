/**
 * Lessons: how to drive this app.
 *
 * Deliberately not how to play Magic. Nothing here explains that fetch lands
 * fetch, that planeswalkers carry loyalty, or what a graveyard is — a player
 * opening a deck builder already knows all of that, and being told it is
 * faintly insulting.
 *
 * What is left is the part that genuinely is not discoverable: the operators
 * the search bar accepts, what the four category buttons actually ask for, and
 * the parts of the playtest mat that answer to a gesture rather than a click.
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
        text: '**Playtest** deals an opening hand and gives you a board. It enforces no rules.',
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
        text: '`c:` matches a card’s colour. `id:` matches its colour identity. `id:bg` returns a wider set than `c:bg`, and is the correct filter for a Golgari commander deck.',
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
        text: 'Prefix a query with `q:` to write it in plain words. `q: cheap green creatures that draw a card` is sent to the local model, which converts it to an operator query and runs that.',
      },
      {
        // No target: the engine badge only exists once results are on screen,
        // and this lesson runs on an empty Search page.
        text: 'A `q:` search returns only cards that exist, because the model writes a query rather than a list. It is slower than a plain search. A badge above the results names which engine answered.',
      },
      {
        target: '.owned-toggle',
        text: 'Press **In binder** to outline every result you already own in gold.',
      },
      {
        target: '.search-input-wrap',
        text: '`binder:true` returns only cards in your binder, and `-binder:true` only cards that are not. Combine it like any other filter: `binder:true t:creature id:bg`.',
      },
      {
        target: '.owned-toggle',
        text: 'Press **Toggle Overlay** to keep prices on the cards instead of showing them on hover. In a deck or the binder it shows the quantity too.',
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
        text: 'Can view cards as **LIST** or **IMAGE**. Press **SHUFFLE** to sort cards.',
      },
      {
        example: 'deck',
        exampleQuery: 'mode=text',
        target: '.decklist-input',
        text: 'Under the **TEXT** tab you can import a full list of cards (multiple formatting options work). When importing a list under **TEXT**, Lines that did not match a card exactly are listed under the description. Press **Approve** to write the matched name into the list.',
      },
      {
        target: '.cat-buttons',
        text: 'Press **Ramp**, **Removal**, **Counters** or **Draw** to show cards with those functions that fit well with the deck synergy. ',
      },
      {
        example: 'deck',
        target: '[data-tour="ai-recommend"]',
        text: 'Press **AI recommend** to have the local model suggest cards. It uses the deck description under **TEXT** as part of its prompt. A run takes a minute or more.',
      },
      {
        target: '[data-tour="tab-pipeline"]',
        text: 'The **Pipeline** tab show the AI model at work.',
      },
      {
        target: '.commander-card',
        text: 'A deck can have two commanders when the pair is legal — Partner, Friends forever, a Background, or a Doctor and its companion. Put both in the Commander section and their colours combine.',
      },
      {
        text: 'Hover a card and press **Printing** to choose which edition you own.',
      },
      {
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
    blurb: 'What you own, and the filters that make it usable.',
    steps: [
      {
        route: '/binder',
        target: '.section-tabs',
        text: 'The binder is one list, always present, never shown among your decks. Its sections are **Bulk**, **Trades** and **Fav**. Drag cards between them.',
      },
      {
        target: '.colour-filter',
        text: 'Press a pip to remove that colour from the list. All five start active. Colourless cards are never hidden.',
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
        target: '.cat-buttons',
        text: 'Press **Bulk Edit** to file several cards at once. Click a card to tick it, then press **Bulk**, **Trades** or **Fav** to move everything ticked there.',
      },
      {
        target: '.result-tabs',
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
        text: 'Press **Export** to write your decks, binder, collected cards and sleeves to one file. Press **Restore** to read that file back in. **Restore** only adds; it deletes nothing.',
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
        text: 'The curve counts nonland cards by mana value, stacked by colour. Lands are left out: they cost nothing and would pile onto zero.',
      },
      {
        target: '.chart-grid',
        text: 'The ring shows what your cards cost against what your lands make. Only the commander’s colours appear — a land that taps for blue in a deck with no blue commander is a land, not a blue source.',
      },
      {
        target: '.balance',
        text: '**Mana base** is sources per pip: how much of your mana works for a colour, divided by how much that colour is asked for. The weakest colour is marked in amber.',
      },
      {
        target: '.balance',
        text: 'Each source is split between the colours it makes. A dual counts a half to each, a triome a third, a five-colour land a fifth — or a quarter, if the commander only allows four.',
      },
      {
        target: '.balance',
        text: 'A fetch land counts as the colours it can go and get, not as nothing. Scryfall says it produces no mana, which is true of the card and false of what it does for your deck.',
      },
      {
        text: 'Bars are scaled against your best-supported colour rather than a pass mark. A healthy deck runs well under one source per pip, so a fixed threshold would fail every colour and tell you nothing.',
      },
      {
        target: '.deck-info',
        text: 'Press **Show numbers** for the counts behind the bars: pips, cards that can tap for the colour, weighted sources, and the ratio.',
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
        text: 'Playtest shows one game, which is an anecdote. This one deals and plays the opening turns as many times as you ask. Choose how many games and how many turns, then press **Run simulation**.',
      },
      {
        target: '[data-tour="sim-drops"]',
        text: '**Missed a drop** is the share of games where some turn had no land in hand. **First miss** is the turn it usually happened on.',
      },
      {
        target: '.sim-table',
        text: 'One row per turn, averaged over every game: mana available, lands and accelerants on the board, and how many colours it could actually produce.',
      },
      {
        target: '.sim-table',
        text: '**Missed drop** turns amber above 30%. **Avg. cost in hand** is what you were holding, so a figure that stays above your mana is a curve problem rather than a land problem.',
      },
      {
        target: '[data-tour="sim-sources"]',
        text: 'Press **Lands**, **Rocks** or **Dorks** to see where a colour comes from. A deck short on green from its lands but fine once its dorks arrive has a different problem from one that is simply short.',
      },
      {
        text: 'It is a mana simulation, not a game. No spell is cast except a rock or a dork, one land is played per turn whenever the hand holds one, and anything entering tapped or summoning-sick pays nothing until the next turn. Nothing is mulliganed.',
      },
    ],
  },
  {
    id: 'playtest',
    title: 'The playtest mat',
    blurb: 'The buttons, and the gestures no label tells you about.',
    steps: [
      {
        route: '/playtest',
        target: '.deck-tile',
        text: 'Pick a deck to deal an opening hand. No rules are enforced.',
      },
      {
        example: 'playtest',
        target: '.pt-actions',
        text: 'Press **Next turn** to untap everything, advance the turn counter and draw a card. Press **Tutor** to search your library and put a card in your hand.',
      },
      {
        target: '.pt-actions',
        text: '**Tutor** also lists the tokens this deck can make. Picking one puts it straight onto the battlefield — a token is created rather than drawn, so the library is untouched.',
      },
      {
        target: '.pt-deck',
        text: 'Click the deck to draw one card. The deck also shows how many cards are left.',
      },
      {
        target: '.pt-actions',
        text: 'Press **Shuffle** to shuffle the library.',
      },
      {
        target: '.pt-life',
        text: 'Press the arrows beside your life total to change it.',
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
        text: 'Flick a die to throw it. It tumbles, bounces off the mat edges and lands on a face. Drag it to move it without rolling.',
      },
      {
        target: '.pt-tools',
        text: 'Double-click a die to switch it to counting mode. Each click then steps its number. Throw it to return it to rolling.',
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
        text: 'Click a fetch land on the battlefield to crack it. It finds a land, goes to the graveyard, and the fetched land enters tapped if its text says so.',
      },
      {
        text: 'A planeswalker enters with its printed starting loyalty. Press the arrows on its badge to change the counter. It resets when the card leaves the battlefield.',
      },
      {
        target: '.pt-actions',
        text: 'Press **Reset** to clear the board and return the dice to their slots; it asks for confirmation first. Press **Mulligan** to redraw your opening hand only.',
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
