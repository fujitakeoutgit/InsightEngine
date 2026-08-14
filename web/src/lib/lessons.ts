/**
 * Lessons: how to drive this app.
 *
 * Deliberately not how to play Magic. Nothing here explains that fetch lands
 * fetch, that planeswalkers carry loyalty, or what a graveyard is — a player
 * opening a deck builder already knows all of that, and being told it is
 * faintly insulting. Nor is there a lesson for Sets or Settings: a page that
 * lists sets needs no lesson.
 *
 * What is left is the part that genuinely is not discoverable — the operators
 * the search bar accepts, that a search can be kept, what the four category
 * buttons actually do, and the parts of the playtest mat that respond to a
 * gesture rather than a click.
 *
 * The one exception is "Getting around", which names every tab including Sets
 * and Settings. Saying what a tab is *for* is not the same as explaining a
 * page that explains itself, and it is the first thing a new pair of hands
 * needs — the rest of these assume you already know where you are.
 *
 * Steps take `**bold**` and `` `code` `` and nothing else. Two markers are
 * enough to name a control and to set an operator apart from the prose around
 * it, and a fuller markdown parser here would be a dependency in aid of text
 * we write ourselves.
 */
export interface Lesson {
  id: string
  title: string
  blurb: string
  /** The actual teaching. Each step is one thing you can go and try. */
  steps: string[]
}

export const LESSONS: Lesson[] = [
  {
    id: 'navigation',
    title: 'Getting around',
    blurb: 'What each tab is for, and which one you actually want.',
    steps: [
      '**Search** is the whole card pool. Type a name, or an operator query — everything else here is built on it.',
      '**Advanced** is the same search as a form, for when you would rather click than remember the syntax. It writes the query for you.',
      '**Deck Lab** holds your decks: paste or build a list, see what it is made of, and ask for cards that do a job it is missing.',
      '**Playtest** deals you seven and gives you a table. No rules are enforced — it is for seeing whether the deck does anything.',
      '**Sets** browses by printing rather than by card, which is the view you want when you are looking for a particular version.',
      '**Glossary** is the reference: operators, mana symbols, keywords, and these lessons.',
      '**Binder** is what you own, kept as one long list — the same editor as a deck, but singular and never listed among them.',
      '**Settings** holds the local model, the dice and coin finishes, and Backup, which is the only thing here that can save you from a lost database.',
      '**Cards** — the tray at the top right — is a scratch pile. Press + on any card to drop it in, and drag from it into a deck.',
    ],
  },
  {
    id: 'search-syntax',
    title: 'Searching properly',
    blurb: 'The operators, and the one this app has that Scryfall does not.',
    steps: [
      'Filters combine with a space and are ANDed: `t:creature c:rg mv<=3`.',
      '`c:` is colour and `id:` is colour identity — a Golgari commander deck is `id:bg`, which is not the same set of cards as `c:bg`.',
      'Comparisons take `>`, `<`, `>=`, `<=` and `=`, so `pow>=4 tou<=2` finds the glass cannons.',
      'Quote anything with a space in it: `o:"whenever you cast"`.',
      '`*` is the wildcard this app adds and the API has not: `n:thal*` reaches Thalia, Thallid and Thraben.',
      'Prefix a term with `-` to exclude it, and the Advanced page writes all of this for you if you would rather click than type.',
    ],
  },
  {
    id: 'saved-searches',
    title: 'Keeping a search',
    blurb: 'A query you will run again is worth naming.',
    steps: [
      'Run a search, then save it — it is stored with its full query text, not its results.',
      'Recall one from the search bar; it re-runs, so it picks up cards printed since you saved it.',
      'Because a saved search is a query, editing the query and saving again replaces it rather than making a near-duplicate.',
      'Press `/` anywhere in the app to jump to the search bar.',
    ],
  },
  {
    id: 'deck-lab',
    title: 'Deck Lab',
    blurb: 'The two modes, the four category buttons, and what the AI is doing.',
    steps: [
      'Text and Build are the same deck: Text is the list you paste and edit, Build is the one you drag around. Switching rewrites the list into the canonical `1 Card Name (SET) 123`.',
      'Name resolution sits under the description and flags lines that did not match exactly. Approve accepts the match and writes it into the list; the alternatives replace it instead.',
      'Ramp, Removal, Counters and Draw ask the server for cards that do that job in *this* deck, judged against what it already plays.',
      'AI recommend is the slow one: it reads your description first, so a deck that says what it is trying to do gets better answers than one that does not.',
      'The Pipeline tab shows that run stage by stage, and is the place to look when a recommendation seems to come from nowhere.',
      'Drag a card from Search straight onto a section to add it; drag one to the Cards tray to take it out.',
    ],
  },
  {
    id: 'playtest',
    title: 'The playtest mat',
    blurb: 'The gestures, which are the part no label tells you about.',
    steps: [
      'Dice are thrown, not clicked: pick one up and flick it, and it tumbles and settles on a face. A slow drag places it instead.',
      'Double-click a die to switch it to counting, where clicks step the number — for storm, experience, or anything else you are tracking.',
      'Both trays hand out replacements, so take a die and another is waiting. Drag one onto the bin above the d20 slot to get rid of it.',
      'Reset asks first and sweeps the dice home; Mulligan does not, because it is still the same game.',
      'The history drawer on the right edge answers "what just happened" and stays shut until you ask.',
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
