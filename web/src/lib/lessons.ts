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
        text: 'Dice are **thrown**, not clicked: pick one up and flick it, and it tumbles across the mat, bounces off the edges and settles on a face. A slow drag places it instead.',
      },
      {
        text: 'Double-click a die to switch it to **counting**, where clicks step the number — for storm, experience, or anything else you are tracking. Throwing it returns it to rolling.',
      },
      {
        text: 'Both trays hand out replacements, so taking a die leaves another waiting. Drag one onto the bin above the d20 slot to be rid of it.',
      },
      {
        text: 'Tapping a **fetch land** cracks it: it finds what it is allowed to find, sacrifices itself, and what it finds arrives tapped if the fetch says so.',
      },
      {
        text: '**Reset** asks first and sweeps the dice home. **Mulligan** does not, because it is still the same game.',
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
