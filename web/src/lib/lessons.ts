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
  example?: 'deck' | 'playtest'
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
        text: '**Advanced** builds the same query from a form, so you do not have to type operators.',
      },
      {
        target: '.nav a[href="/deck"]',
        text: '**Deck Lab** stores your decks. Open one to edit its list, read its statistics, or request cards it lacks.',
      },
      {
        target: '.nav a[href="/playtest"]',
        text: '**Playtest** deals an opening hand and gives you a board. It enforces no rules.',
      },
      {
        target: '.nav a[href="/sets"]',
        text: '**Sets** browses printings rather than cards. Use it to find a specific edition.',
      },
      {
        target: '.nav a[href="/glossary"]',
        text: '**Glossary** lists the operators, mana symbols and keywords, and holds these lessons.',
      },
      {
        target: '.nav a[href="/binder"]',
        text: '**Binder** is one permanent list of the cards you own. It edits like a deck.',
      },
      {
        target: '.nav a[href="/settings"]',
        text: '**Settings** holds the card data controls, the local model, the dice finishes, and backup.',
      },
      {
        target: '.nav-tray',
        text: '**Cards** is a tray that slides over the current page. It holds cards you are collecting.',
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
        text: '`*` is a wildcard. `n:thal*` matches Thalia, Thallid and Thraben. Prefix a term with `-` to exclude it.',
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
    id: 'recent-searches',
    title: 'Recent searches',
    blurb: 'The last few queries, and how to stop one ageing out.',
    steps: [
      {
        route: '/',
        target: '.history',
        text: 'Every search is recorded with its result count and the engine that answered it.',
      },
      {
        target: '.history',
        text: 'This table keeps the last five unpinned queries. Older ones are dropped.',
      },
      {
        target: '.history',
        text: 'Press **☆** on a row to pin that search. Pinned searches stay at the top, never age out, and survive **Clear**. Running one again updates its counts in place.',
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
        text: 'Press **Text** to edit the deck as a list. Press **Build** to edit it by dragging cards. Switching rewrites every line as `1 Card Name (SET) 123`.',
      },
      {
        text: 'Lines that did not match a card exactly are listed under the description. Press **Approve** to write the matched name into the list, or press one of the alternatives to use that name instead.',
      },
      {
        target: '.cat-buttons',
        text: 'Press **Ramp**, **Removal**, **Counters** or **Draw** to request cards that do that job. Suggestions are scored against the cards this deck already plays.',
      },
      {
        target: '.deck-actions',
        text: 'Press **AI recommend** to have the local model suggest cards. It uses the deck description as part of its prompt, so write one first. A run takes a minute or more.',
      },
      {
        target: '.result-tabs',
        text: 'Press the **Pipeline** tab to watch each stage of that run.',
      },
      {
        target: '.sleeve-add',
        text: 'Press the **Sleeves** button to add sleeves to your deck.',
      },
      {
        target: '[data-tour="deck-bar"]',
        text: 'Press **Playtest** to deal this deck onto a table, or **Simulation** to shuffle it a few thousand times and read the averages. Press **Copy** to duplicate the deck, and **Export** to write its list out as text.',
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
        text: 'Press **Cards** to open the tray. It slides over the current page rather than navigating away.',
      },
      {
        text: 'Press **+** on a search result to put that card in the tray.',
      },
      {
        text: 'Drag a card from the tray onto a deck section to add it. Drag a card from a deck into the tray to remove it from that deck.',
      },
      {
        text: 'The tray keeps its contents as you move between pages. Nothing in it belongs to a deck until you drag it onto one.',
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
