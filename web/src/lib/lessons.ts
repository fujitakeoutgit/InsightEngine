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
        text: '**Search** is the whole card pool, and everything else here is built on it. Type a name, or an operator query.',
      },
      {
        target: '.nav a[href="/advanced"]',
        text: '**Advanced** is that same search as a form, for when you would rather click than remember syntax. It writes the query for you.',
      },
      {
        target: '.nav a[href="/deck"]',
        text: '**Deck Lab** holds your decks: paste or build a list, see what it is made of, and ask for cards that do a job it is missing.',
      },
      {
        target: '.nav a[href="/playtest"]',
        text: '**Playtest** deals you seven and gives you a table. No rules are enforced — it is for seeing whether the deck does anything.',
      },
      {
        target: '.nav a[href="/sets"]',
        text: '**Sets** browses by printing rather than by card, which is what you want when you are after a particular version.',
      },
      {
        target: '.nav a[href="/glossary"]',
        text: '**Glossary** is the reference — operators, mana symbols, keywords — and these lessons.',
      },
      {
        target: '.nav a[href="/binder"]',
        text: '**Binder** is what you own, kept as one long list. The same editor as a deck, but singular and never listed among them.',
      },
      {
        target: '.nav a[href="/settings"]',
        text: '**Settings** holds the local model, the dice and coin finishes, and Backup — the only thing here that can save you from a lost database.',
      },
      {
        target: '.nav-tray',
        text: '**Cards** is a scratch pile rather than a page: it slides out over whatever you are doing. Press + on any card to drop it in, and drag from it into a deck.',
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
        text: 'Filters combine with a space and are ANDed: `t:creature c:rg mv<=3` is every red-green creature costing three or less.',
      },
      {
        target: '.search-input-wrap',
        text: '`c:` is colour and `id:` is colour **identity**. A Golgari commander deck is `id:bg`, which is not the same set of cards as `c:bg` — and that difference is most of what makes a deckbuilding search work.',
      },
      {
        target: '.search-input-wrap',
        text: 'Comparisons take `>`, `<`, `>=`, `<=` and `=`, so `pow>=4 tou<=2` finds the glass cannons. Quote anything containing a space: `o:"whenever you cast"`.',
      },
      {
        target: '.search-input-wrap',
        text: '`*` is the wildcard this app adds and the API does not have: `n:thal*` reaches Thalia, Thallid and Thraben. Prefix any term with `-` to exclude it.',
      },
      {
        target: '.owned-toggle',
        text: '**In binder** outlines every result you already own in gold, so you can tell at a glance what you would be buying twice.',
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
        text: 'Every search is recorded with its result count and which engine answered it — the plain index, or the local model for a `q:` question.',
      },
      {
        target: '.history',
        text: 'The **Recent searches** table sits under the results. Only the last five unpinned queries are kept, so an afternoon of searching cannot bury the one you care about.',
      },
      {
        target: '.history',
        text: 'Pin a query and it is held at the top, never evicted, and kept even by **Clear**. Re-running a pinned search refreshes its numbers in place rather than adding a duplicate.',
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
        text: 'Every deck you have saved. Opening one gives you the same deck in two modes.',
      },
      {
        example: 'deck',
        target: '.editor-bar',
        text: '**Text** is the list you paste and edit; **Build** is the one you drag around. Switching rewrites the list into the canonical `1 Card Name (SET) 123`, so a deck always states which printing it means.',
      },
      {
        text: 'Name resolution sits under the description and flags any line that did not match exactly. **Approve** accepts the match and writes it into the list; the alternatives beside it replace the line instead.',
      },
      {
        text: '**Ramp**, **Removal**, **Counters** and **Draw** ask for cards that do that job *in this deck*, judged against what it already plays — not a generic list of good cards.',
      },
      {
        text: '**AI recommend** is the slow one, and it reads your deck description first: a deck that says what it is trying to do gets markedly better answers. The **Pipeline** tab shows that run stage by stage.',
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
        text: '**Cards** opens over the page you are on instead of taking you somewhere else, so you can keep what you found next to what you are building.',
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
        text: 'One binder, always here, never listed among your decks. Its three sections are **Bulk**, **Trades** and **Fav** — drag a card between them the same way you would move one around a deck.',
      },
      {
        target: '.colour-filter',
        text: 'The pips filter by colour. All five start lit; click one to drop it out. Colourless cards are never hidden, because an artifact goes in any deck.',
      },
      {
        target: '.cat-buttons',
        text: '**Ramp**, **Removal**, **Counters** and **Draw** filter the list to cards you own that do that job. In a deck those same buttons suggest cards you *lack* — here you are looking at what you have.',
      },
      {
        text: 'The card counts and the mana curve beside the list follow both filters, so the numbers always describe what is actually on screen.',
      },
      {
        text: 'Hover a card and press **Printing** to see every edition of it and pick the one you own.',
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
        text: '**Card data** says how old your local copy of Scryfall is and whether they have newer. Refreshing builds beside the copy you have and only swaps it in when it finishes, so a failed download costs you nothing.',
      },
      {
        text: '**Backup** writes your decks, the binder, your collected cards and your deck sleeves to one file — and reads it back. Restoring merges: nothing is deleted. It is the only thing here that can save you from a lost database.',
      },
      {
        text: '**Table** is what the dice and coin are made of. Throw the dice beside the swatches to see a finish before you keep it; the d20 is chosen separately so the two are never hard to tell apart.',
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
        text: 'Pick a deck and it deals you seven. Nothing is enforced — you are checking whether the deck does anything, not adjudicating a game.',
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
        text: 'Double-click a die on the mat to switch it to **counting**. Clicks step the number; throwing it returns it to rolling.',
      },
      {
        text: 'Take a die from a slot and another appears in it, so you can have as many as you need. Drag one to the bin above the slots to remove it.',
      },
      {
        text: 'Tap a **fetch land** to crack it. It finds what it can, sacrifices itself, and the land arrives tapped if the fetch says so.',
      },
      {
        text: '**Reset** asks first, then clears the board and sweeps the dice home. **Mulligan** only redraws your hand.',
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
