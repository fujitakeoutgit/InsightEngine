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
    blurb: 'What each tab is for, and which one you actually want.',
    steps: [
      {
        route: '/',
        target: '.nav a[href="/"]',
        text: '**Search** is the whole card pool. Type a card name, or an operator query. Everything else here is built on it.',
      },
      {
        target: '.nav a[href="/advanced"]',
        text: '**Advanced** is the same search as a form. Click instead of remembering syntax, and it writes the query for you.',
      },
      {
        target: '.nav a[href="/deck"]',
        text: '**Deck Lab** holds your decks. Paste or build a list, see what it is made of, and ask for cards it is missing.',
      },
      {
        target: '.nav a[href="/playtest"]',
        text: '**Playtest** deals you seven and gives you a table. No rules are enforced — it is for seeing whether the deck does anything.',
      },
      {
        target: '.nav a[href="/sets"]',
        text: '**Sets** browses by printing rather than by card. Use it when you want a particular version.',
      },
      {
        target: '.nav a[href="/glossary"]',
        text: '**Glossary** is the reference: operators, mana symbols, keywords, and these lessons.',
      },
      {
        target: '.nav a[href="/binder"]',
        text: '**Binder** is what you own, kept as one long list. It works like a deck, but there is only ever one.',
      },
      {
        target: '.nav a[href="/settings"]',
        text: '**Settings** holds the local model and the dice finishes. It also holds **Export**, the only button in this app that can save you from a lost database.',
      },
      {
        target: '.nav-tray',
        text: '**Cards** is a scratch pile rather than a page. It slides out over whatever you are doing, so what you found stays beside what you are building.',
      },
    ],
  },
  {
    id: 'search-syntax',
    title: 'Searching properly',
    blurb: 'The operators, and the one this app has that Scryfall does not.',
    steps: [
      {
        route: '/',
        target: '.search-input-wrap',
        text: 'Filters combine with a space, and every one of them has to match. `t:creature c:rg mv<=3` is every red-green creature costing three or less.',
      },
      {
        target: '.search-input-wrap',
        text: '`c:` is colour. `id:` is colour **identity**. A Golgari commander deck is `id:bg`, a wider set of cards than `c:bg`. That difference is most of what makes a deckbuilding search work.',
      },
      {
        target: '.search-input-wrap',
        text: 'Comparisons take `>`, `<`, `>=`, `<=` and `=`, so `pow>=4 tou<=2` finds the glass cannons. Quote anything with a space in it: `o:"whenever you cast"`.',
      },
      {
        target: '.search-input-wrap',
        text: '`*` is the wildcard this app adds and the API does not have. `n:thal*` reaches Thalia, Thallid and Thraben. Put `-` in front of a term to exclude it.',
      },
      {
        text: 'Start a search with `q:` to ask in plain words instead of operators. `q: cheap green creatures that draw a card` goes to the local model. It writes the operator query for you and runs it.',
      },
      {
        text: 'A `q:` search can only return cards that exist, because the model writes a query rather than an answer. It is slower than a plain search, and the badge above the results tells you which engine ran.',
      },
      {
        target: '.owned-toggle',
        text: 'Press **In binder** to outline every result you already own in gold. Use it to see what you would be buying twice.',
      },
      {
        target: '.nav a[href="/advanced"]',
        text: 'If you would rather not memorise any of that, **Advanced** builds the same query from a form.',
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
        text: 'Every search is recorded with its result count. It also records which engine answered: the plain index, or the local model for a `q:` question.',
      },
      {
        target: '.history',
        text: 'The **Recent searches** table sits under the results. Only the last five unpinned queries are kept, so an afternoon of searching cannot bury the one that mattered.',
      },
      {
        target: '.history',
        text: 'Press the **☆** on a row to pin that search. Pinned searches stay at the top, never age out, and survive the **Clear** button. Running a pinned search again updates its numbers in place.',
      },
    ],
  },
  {
    id: 'deck-lab',
    title: 'Deck Lab',
    blurb: 'The two modes, the four category buttons, and what the AI is doing.',
    steps: [
      {
        route: '/deck',
        target: '.gallery-head',
        text: 'Every deck you have saved. Open one and you get it in two modes.',
      },
      {
        example: 'deck',
        target: '.editor-bar',
        text: 'Press **Text** to edit the deck as a pasted list. Press **Build** to edit it by dragging cards around. Switching between them rewrites every line as `1 Card Name (SET) 123`, so the deck always states which printing it means.',
      },
      {
        text: 'Name resolution sits under the description and flags any line that did not match exactly. **Approve** writes the match into the list. The alternatives beside it replace the line instead.',
      },
      {
        text: '**Ramp**, **Removal**, **Counters** and **Draw** ask for cards that do that job *in this deck*, judged against what it already plays. Not a generic list of good cards.',
      },
      {
        text: '**AI recommend** is the slow one. It reads your deck description first, so a deck that says what it is trying to do gets markedly better answers. Press the **Pipeline** tab to watch the run stage by stage.',
      },
      {
        text: 'Press the **Sleeves** tab to give the deck a sleeve. It is what the deck wears in the gallery and on the playtest mat, so two decks never look alike.',
      },
      {
        text: 'Press **Playtest** to deal this deck onto a table. Press **Copy** to duplicate the deck before trying something you might regret, and **Export** to write the list out as text.',
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
        text: '**Cards** opens over the page you are on rather than taking you somewhere else.',
      },
      {
        text: 'Press the **+** on a search result to put it in the tray.',
      },
      {
        text: 'Drag a card **out** of the tray onto a deck to add it. Drag a card from a deck **into** the tray to remove it.',
      },
      {
        text: 'The tray keeps what you put in it as you move between pages. Nothing in it belongs to a deck until you drag it onto one.',
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
        text: 'One binder, always here, never listed among your decks. Its three sections are **Bulk**, **Trades** and **Fav**. Drag a card between them the way you would move one around a deck.',
      },
      {
        target: '.colour-filter',
        text: 'The pips filter by colour. All five start lit; click one to drop it out. Colourless cards are never hidden, since an artifact goes in any deck.',
      },
      {
        target: '.cat-buttons',
        text: '**Ramp**, **Removal**, **Counters** and **Draw** narrow the list to cards you own that do that job. In a deck the same buttons suggest cards you *lack*. Here they show what you have.',
      },
      {
        text: 'The counts and the mana curve beside the list follow both filters, so the numbers always describe what is on screen.',
      },
      {
        text: 'Hover a card and press **Printing** to choose which edition of it you own.',
      },
    ],
  },
  {
    id: 'settings',
    title: 'Settings',
    blurb: 'Card data, backups, and what the dice are made of.',
    steps: [
      {
        route: '/settings',
        target: '.settings-panel',
        text: '**Card data** shows how old your copy of Scryfall is, and whether a newer one exists. When one does, a gold **+** appears next to the card count on the Search page.',
      },
      {
        text: 'Press **Check now** to ask Scryfall whether newer card data exists. It only checks; it downloads nothing.',
      },
      {
        text: 'Press **Update Card Pool** to start importing the new card list in the background. It copies over when it finishes, so searching keeps working the whole time.',
      },
      {
        text: 'Press **Export** to write your decks, your binder, your collected cards and your sleeves into one file. Press **Restore** to read that file back in. **Restore** only adds — it never deletes anything you already have.',
      },
      {
        text: '**Tabletop** is where you choose what the dice and coin are made of. Press a swatch to try a finish, then throw the dice beside it to see how it looks in motion. The d20 is picked separately, so your two dice never look alike.',
      },
      {
        text: '**Local model** is the model that answers a `q:` search. Press the **Model** dropdown to change it. Each option lists the video memory it wants. A model bigger than your card still runs, but spills into system memory and slows to minutes per search.',
      },
      {
        text: 'Press **Save** to keep a new model. If it is not on this machine yet, the panel prints the exact `ollama pull` command to run first.',
      },
    ],
  },
  {
    id: 'playtest',
    title: 'The playtest mat',
    blurb: 'The gestures, which are the part no label tells you about.',
    steps: [
      {
        route: '/playtest',
        target: '.deck-tile',
        text: 'Pick a deck and it deals you seven. Nothing is enforced: you are checking whether the deck does anything, not adjudicating a game.',
      },
      {
        text: 'Press **Next turn** to untap everything, step the turn counter and draw a card. Press **Draw** to draw one card without ending the turn, and **Untap all** to untap without drawing.',
      },
      {
        text: 'Press **Tutor** to search your library for any card and put it in your hand. Press **Shuffle** to shuffle the library.',
      },
      {
        example: 'playtest',
        // The whole tool column, not one tray. The dice are *positioned by
        // script* after the mat lays out, so a highlight pinned to a single
        // empty slot sits beside them rather than on them.
        target: '.pt-tools',
        text: 'Flick a die to throw it — it tumbles, bounces off the edges and lands on a face. Drag it slowly instead and it just moves.',
      },
      {
        text: 'Double-click a die to switch it to **counting**. Clicks step the number. Throw it to go back to rolling.',
      },
      {
        text: 'Drag a die out of its slot and a new one appears there, so you can have as many as you need. Drag a die onto the bin above the slots to get rid of it.',
      },
      {
        text: 'Click a fetch land on the battlefield to crack it. It finds what it can, goes to the graveyard, and the land it fetches arrives tapped if the fetch land says so.',
      },
      {
        text: 'Press **Reset** to clear the board and sweep the dice home; it asks you to confirm first. Press **Mulligan** to redraw your opening hand and nothing else.',
      },
      {
        text: 'Press the arrows either side of your life total to gain or lose life. Press the coin to flip it.',
      },
      {
        text: 'Press **History** on the right edge to slide out the log of everything that has happened this game.',
      },
      {
        text: 'A planeswalker you play arrives with its starting loyalty. Press the arrows on its badge to move the counter; leaving the battlefield resets it.',
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
