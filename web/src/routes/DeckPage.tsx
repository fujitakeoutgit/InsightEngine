import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useBlocker, useNavigate, useParams, useSearchParams } from 'react-router-dom'

import {
  api, streamDeckRecommendations, type Category,
  type Card, type DeckReport, type RecommendReport, type Resolution,
} from '../lib/api'
import {
  addedCard, fromResolutions, serialize, type DeckCard, type Section,
} from '../lib/deckModel'
import { recallDeckView, rememberDeckView } from '../lib/deckViewCache'
import { BINDER_NAME, BINDER_SECTIONS } from '../lib/binder'
import { clearSleeve, readSleeveFile, setSleeve, sleeveFor } from '../lib/sleeves'
import { attachTilt, dissolveIn, riseIn } from '../lib/motion'
import { CardGrid } from '../components/CardGrid'
import { DeckEditor } from '../components/DeckEditor'
import { ManaCost } from '../components/ManaCost'
import { DeckCharts } from '../components/DeckCharts'
import { DeckInfo } from '../components/DeckInfo'
import { BinderInfo } from '../components/BinderInfo'
import { doesJob } from '../lib/cardRoles'
import { DeckSearch } from '../components/DeckSearch'
import { useEscape, usePersisted, useTransient, useTransientMessage } from '../lib/usePersisted'
import { copyText } from '../lib/clipboard'
import { Playtest } from '../components/Playtest'
import {
  DECK_RAIL, EMPTY_CONSOLE, SemanticConsole, type ConsoleState,
} from '../components/SemanticConsole'
import { SplitPane } from '../components/SplitPane'

const SAMPLE = `Commander
1 Teysa Karlov

Deck
1 Blood Artist
1 Zulaport Cutthroat
1 Viscera Seer
1 Carrion Feeder
1 Ashnod's Altar
1 Village Rites
10 Swamp
8 Plains

Sideboard
2 Duress
`

/** Deep enough to cover a run of edits without holding a session's worth. */
const UNDO_LIMIT = 60

/** The four jobs every deck does, asked for by name. */
const CATEGORIES: [Category, string][] = [
  ['ramp', 'Ramp'], ['removal', 'Removal'],
  ['counterspell', 'Counters'], ['draw', 'Draw'],
]

const UNCERTAIN = new Set(['fuzzy', 'ambiguous', 'prefix', 'unresolved'])
const REC_FORMATS = ['', 'commander', 'standard', 'pioneer', 'modern', 'legacy', 'vintage', 'pauper', 'brawl']

/**
 * One line of the name-resolution report.
 *
 * The alternatives are buttons, not prose. This panel exists to tell you a
 * line went somewhere you may not have meant, and it used to stop there —
 * printing the right answer next to the wrong one and leaving you to go and
 * retype it in Text mode. Clicking one rewrites that line.
 */
function ResolutionRow({
  entry, onReplace, busy,
}: {
  entry: Resolution
  onReplace?: (entry: Resolution, name: string) => void
  busy?: boolean
}) {
  return (
    <div className="resolution">
      <span className="q mono">{entry.quantity}×</span>
      <span className="muted" style={{ flex: '0 1 auto', minWidth: 0 }}>{entry.raw_name}</span>
      <span className="arrow">→</span>
      <span className="to">
        {entry.card
          ? <Link to={`/card/${entry.card.oracle_id}`}>{entry.card.name}</Link>
          : <span style={{ color: 'var(--danger)' }}>no match</span>}
        {entry.alternatives.length > 0 && (
          <span className="alts">
            <span className="faint">or</span>
            {entry.alternatives.slice(0, 3).map((name) => (
              <button
                key={name}
                className="alt-pick"
                disabled={busy || !onReplace}
                title={`Use “${name}” on this line instead`}
                onClick={() => onReplace?.(entry, name)}
              >
                {name}
              </button>
            ))}
          </span>
        )}
      </span>
      {/* Approve: the match is right, write it down.
          A fuzzy line is flagged every time the deck is analysed, because the
          raw text still says "Phial of Galadrl" — agreeing with the guess in
          your head does not change the file. This rewrites the line to the
          name it resolved to, which is the same edit an alternative makes and
          the only thing that actually settles the question. Absent when there
          is nothing to approve, or when the raw text already says it. */}
      {entry.card && entry.match !== 'exact' && entry.raw_name !== entry.card.name && (
        <button
          className="alt-pick approve"
          disabled={busy || !onReplace}
          title={`Accept “${entry.card.name}” and write it into the list`}
          onClick={() => onReplace?.(entry, entry.card!.name)}
        >
          Approve
        </button>
      )}
      <span className={`match-tag ${entry.match}`}>
        {entry.match}{entry.match !== 'exact' && entry.score > 0 && ` ${Math.round(entry.score)}`}
      </span>
    </div>
  )
}

export function DeckPage({ binder }: { binder?: boolean } = {}) {
  const { deckId } = useParams()
  const navigate = useNavigate()
  /* The binder is one particular saved deck rather than a route parameter, so
   * it is never "new" in the sense a deck is: it is found by name on mount,
   * and created on first save if it has never been written. */
  const isNew = !binder && (!deckId || deckId === 'new')

  const [text, setText] = useState('')
  /** The decklist as it last existed on the server, so "has this changed?" is
   *  a comparison rather than a flag that has to be cleared in every path that
   *  touches the deck. */
  const [savedText, setSavedText] = useState('')
  const [deckName, setDeckName] = useState('')
  const [savedId, setSavedId] = useState<number | null>(null)
  const [savedAt, setSavedAt] = useState<{ created: string; updated: string } | null>(null)
  const [format, setFormat] = useState('commander')
  const [description, setDescription] = useState("")

  const [searchParams] = useSearchParams()
  /* The editor opens on Build. A lesson about importing a list has to be
   * looking at the Text tab, so it asks for it in the URL rather than the
   * walkthrough reaching in and clicking things. Read once, at mount: this is
   * an opening state, not a mode the address bar keeps owning. */
  const wantsText = useRef(searchParams.get('mode') === 'text')
  const [mode, setMode] = useState<'text' | 'build'>(
    () => (wantsText.current ? 'text' : 'build'),
  )
  /* Opening a deck switches to Build once it has been analysed, which is the
   * right default and the wrong one when the URL asked for Text -- the tab
   * would flip back a moment after arriving. Honoured once, then cleared, so
   * pressing Build afterwards behaves normally. */
  const settleMode = (next: 'text' | 'build') => {
    if (wantsText.current) { wantsText.current = false; return }
    setMode(next)
  }
  const [deckCards, setDeckCards] = useState<DeckCard[]>([])
  const [report, setReport] = useState<DeckReport | null>(null)
  const [recs, setRecs] = useState<RecommendReport | null>(null)

  const [tab, setTab] = useState<'analysis' | 'search' | 'recommendations' | 'pipeline'>('analysis')
  const [pipeline, setPipeline] = useState<ConsoleState>(EMPTY_CONSOLE)
  const [recView, setRecView] = usePersisted<'list' | 'grid'>('insight-enigma:rec-view', 'list')
  const [recSize, setRecSize] = usePersisted('insight-enigma:rec-size', 150)
  const [activeThemes, setActiveThemes] = useState<string[]>([])
  const [aiMode, setAiMode] = useState(false)
  const [aiStrategy, setAiStrategy] = useState<string | null>(null)
  const [playing, setPlaying] = useState(false)
  const [busy, setBusy] = useState<
    'load' | 'analyse' | 'recommend' | 'ai' | 'save' | Category | null
  >(null)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useTransientMessage()
  const [showAll, setShowAll] = useState(false)
  const [copied, flashCopied] = useTransient()
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  /* Which of the four jobs the binder is filtered to, if any.
   *
   * In a deck these buttons ask the server for cards you do not have. In a
   * binder that is the wrong question entirely — you are looking at what you
   * own — so the same four buttons filter the list instead of fetching a
   * table nobody asked for. */
  const [job, setJob] = useState<Category | null>(null)
  const [colors, setColors] = useState<string[]>(['W', 'U', 'B', 'R', 'G', 'C'])

  /* Both binder filters, applied in one place.
   *
   * They have to combine — asking for red *and* removal means both — and the
   * same result has to feed the list and the numbers beside it, so neither can
   * own half of it. Colorless cards survive the color filter: an artifact
   * goes in any deck, and losing your Sol Rings when you ask for red would be
   * the wrong answer to the question the pips are asking. */
  const binderCards = useMemo(() => {
    if (!binder) return deckCards
    return deckCards.filter((c) => {
      if (job && !doesJob(c.card, job)) return false
      if (colors.length === 6) return true
      const identity = c.card.color_identity || ''
      // Colorless is a color here, with its own pip. It used to be exempt --
      // an artifact goes in any deck, so hiding Sol Ring when you asked for
      // red seemed wrong. But a binder is mostly artifacts and lands, and
      // being unable to get them out of the way made the pips much less useful
      // than being unable to keep them in.
      if (!identity) return colors.includes('C')
      return [...identity].some((letter) => colors.includes(letter))
    })
  }, [binder, job, colors, deckCards])
  useEscape(() => setConfirmingDelete(false), confirmingDelete)

  const resultRef = useRef<HTMLDivElement>(null)
  const commanderTilt = useRef<HTMLAnchorElement>(null)
  /** This deck's sleeve art, if it has been given one. Local to this machine
   *  -- see `lib/sleeves`. */
  const [sleeve, setSleeveArt] = useState<string | null>(() => sleeveFor(deckId))
  const [sleeveError, setSleeveError] = useState<string | null>(null)
  const sleeveInput = useRef<HTMLInputElement>(null)
  useEffect(() => { setSleeveArt(sleeveFor(deckId)); setSleeveError(null) }, [deckId])
  const recRef = useRef<HTMLDivElement>(null)
  const aiStream = useRef<{ stop: () => void } | null>(null)

  /* Navigation this page performs *because* the deck is now safe.
   *
   * A ref, not state: saving a new deck and deleting one both settle the deck
   * and then navigate in the same tick, so the `dirty` the blocker closes over
   * is still the pre-save value and would challenge the page on its way out of
   * a move it made itself. */
  const leaving = useRef(false)

  /** Navigate away from a deck this page has just settled. Wrapping it means
   *  the "tell the guard first" step cannot be forgotten by the next caller. */
  const leave = useCallback((to: string) => {
    leaving.current = true
    navigate(to, { replace: true })
  }, [navigate])

  const analyseText = useCallback(async (source: string) => {
    if (!source.trim()) { setReport(null); return null }
    try {
      const next = await api.analyzeDeck(source)
      setReport(next)
      return next
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Analysis failed')
      return null
    }
  }, [])

  // Opening a saved deck lands in Build with the analysis already on screen —
  // both are what you want to see, and neither should need a second click.
  useEffect(() => {
    let cancelled = false
    // A different deck is a different history. Without this, undoing on deck B
    // would restore deck A's cards into it.
    past.current = []
    future.current = []
    // Arriving is the end of the departure that set it, if there was one.
    leaving.current = false
    // A deck opens on its analysis, not on whichever tab the last one left
    // behind. The saved view still restores when you come *back* from a card.
    setTab("analysis")
    if (isNew) { setBusy(null); return }
    setBusy('load')
    /* The binder has no id in the URL, so it finds itself by name. Absent on
     * first visit, which is not an error: an empty binder is simply one you
     * have not put anything in yet, and it is written the first time you save. */
    const opening = binder
      ? api.savedDecks().then(({ decks }) => {
          const mine = decks.find((d) => d.name === BINDER_NAME)
          if (!mine) return null
          return api.loadDeck(mine.id)
        })
      : api.loadDeck(Number(deckId))
    opening
      .then(async (loaded) => {
        if (cancelled) return
        if (!loaded) { settleMode('build'); return }
        const { deck } = loaded
        setText(deck.text ?? '')
        setSavedText(deck.text ?? '')
        setDeckName(deck.name)
        setSavedId(deck.id)
        setSavedAt({ created: deck.created_at, updated: deck.updated_at })
        setDescription(deck.description ?? "")
        if (deck.format) setFormat(deck.format)
        const analysed = await analyseText(deck.text ?? '')
        if (!cancelled && analysed) setDeckCards(fromResolutions(analysed.entries))
        settleMode('build')
      })
      .catch(() => !cancelled && setError(binder ? 'Could not open the binder.' : 'Could not load that deck.'))
      .finally(() => !cancelled && setBusy(null))
    return () => { cancelled = true }
  }, [deckId, isNew, analyseText, binder])

  /* Unsaved work.
   *
   * The editor keeps sixty steps of undo and none of it is written anywhere
   * until Save, so leaving the page discarded the lot in silence -- no prompt,
   * no autosave, no way back. Compared against the text the server last
   * confirmed rather than tracked with a flag, because every path that changes
   * the deck would otherwise have to remember to set one.
   *
   * Trimmed on both sides: serialize() and the textarea disagree about the
   * trailing newline, which would otherwise report a deck as modified the
   * instant it was opened. */
  const dirty = text.trim() !== savedText.trim() && Boolean(text.trim())

  // Closing the tab or reloading. The browser shows its own wording; the
  // returned string is legacy but still required by some engines.
  useEffect(() => {
    if (!dirty) return
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ''
      return ''
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])

  // Navigating within the app. useBlocker needs the data router, which is what
  // main.tsx builds. Playtesting is not navigation -- it renders in place --
  // so it is unaffected.
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      !leaving.current && dirty && currentLocation.pathname !== nextLocation.pathname,
  )

  // A deck that has just been deleted has nothing left to save.
  useEffect(() => {
    if (!dirty && blocker.state === 'blocked') blocker.reset()
  }, [dirty, blocker])

  // Escape means "stay here" — the safe half of the question, and the one you
  // want when the prompt was a surprise.
  useEscape(() => blocker.reset?.(), blocker.state === 'blocked')

  /* Returning from a card must not discard the recommendations.
   *
   * They take real work to produce -- the AI pipeline takes minutes -- so
   * clicking a suggestion to read it and pressing Back has to come back to the
   * same list, the same tab and the same place in it. */
  const viewKey = deckId ?? 'new'
  /** Set by the restore, cleared by the save it must not be undone by. */
  const restoring = useRef<string | null>(null)

  /* Opening a tab is the request; there is no separate button any more.
   *
   * Guarded on `busy` as well as on the result being absent, or the effect
   * would fire again on the render that starts the work and run it twice. */
  useEffect(() => {
    if (busy || !text.trim()) return
    if (tab === 'analysis' && !report) { void analyseText(text) }
    else if (tab === 'recommendations' && !recs) { void getRecommendations() }
    // getRecommendations is recreated every render; depending on it would
    // restart the run it just finished.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, report, recs, busy, text, analyseText])

  /* Opening a deck always opens it on Analysis.
   *
   * The cache still restores the *work* -- recommendations take minutes to
   * produce and clicking through to a card must not throw them away -- but
   * not the view. Arriving at a deck and finding yourself half way down a
   * recommendation list from an hour ago is disorienting in a way that saving
   * one click never justified; the tab and the scroll position are cheap to
   * get back and the results are not. */
  useEffect(() => {
    const saved = recallDeckView(viewKey)
    if (!saved) return
    restoring.current = viewKey
    setRecs(saved.recs)
    setAiMode(saved.aiMode)
    setAiStrategy(saved.aiStrategy)
    setActiveThemes(saved.activeThemes)
    // The router leaves the page wherever the last one was, so the top has to
    // be asked for rather than assumed.
    if ('scrollRestoration' in history) history.scrollRestoration = 'manual'
    window.scrollTo(0, 0)
  }, [viewKey])

  useEffect(() => {
    // The save that fires in the same commit as a restore still sees the
    // pre-restore state, and writing it back would erase what was just read.
    // Under StrictMode that is fatal rather than merely wasteful: effects are
    // invoked twice on mount, so the second restore would read the blank view
    // this had just written and faithfully restore *that*.
    if (restoring.current === viewKey) {
      restoring.current = null
      return
    }
    rememberDeckView(viewKey, { tab, recs, aiMode, aiStrategy, activeThemes })
  }, [viewKey, tab, recs, aiMode, aiStrategy, activeThemes])

  /* Undo history.
   *
   * Every deck mutation goes through applyEdits, so the whole editor gets undo
   * from one place. Snapshots are whole card lists rather than diffs: a deck is
   * a few hundred small objects, so the memory is irrelevant next to the
   * complexity of inverting each kind of edit.
   *
   * The text is snapshotted alongside the cards rather than regenerated from
   * them on the way back. The two are not interchangeable: in Text mode the
   * decklist is what the user is editing and the card list may not describe it
   * at all, so an undo that rebuilt the text with serialize() would replace
   * whatever they had typed with a rendering of an unrelated card list -- and
   * where the card list was still empty, with nothing. It also means an undo
   * restores the file as it was, comments and ordering included. */
  interface Snapshot { cards: DeckCard[]; text: string }
  const past = useRef<Snapshot[]>([])
  const future = useRef<Snapshot[]>([])

  /* The present, readable from the undo callbacks without making them depend
   * on it. They are memoised with an empty dependency list so the key handler
   * is bound once, which would otherwise close over the first render's deck. */
  const live = useRef<Snapshot>({ cards: deckCards, text })
  live.current = { cards: deckCards, text }

  const remember = () => {
    past.current = [...past.current, live.current].slice(-UNDO_LIMIT)
    future.current = []
  }

  const applyEdits = (next: DeckCard[]) => {
    remember()
    setDeckCards(next)
    setText(serialize(next, binder ? BINDER_SECTIONS : undefined))
  }

  /** Undo and redo are the same move in opposite directions: pop the stack you
   *  are travelling towards, push the present onto the one you came from. */
  const step = useCallback((
    from: React.MutableRefObject<Snapshot[]>,
    to: React.MutableRefObject<Snapshot[]>,
  ) => {
    const target = from.current[from.current.length - 1]
    if (target === undefined) return false
    from.current = from.current.slice(0, -1)
    to.current = [...to.current, live.current].slice(-UNDO_LIMIT)
    setDeckCards(target.cards)
    setText(target.text)
    return true
  }, [])

  const undo = useCallback(() => step(past, future), [step])
  const redo = useCallback(() => step(future, past), [step])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'z') return
      // Inside a text field the browser's own undo is the right one — the
      // decklist textarea in particular has its own edit history.
      const el = event.target as HTMLElement | null
      const tag = el?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || el?.isContentEditable) return

      const didSomething = event.shiftKey ? redo() : undo()
      if (!didSomething) return
      event.preventDefault()
      setStatus(event.shiftKey ? 'Redid the last change' : 'Undid the last change')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [undo, redo])

  /** A suggestion you want to think about. Already-present cards gain a copy
   *  rather than a second row, matching how the search tab adds. */
  const addToMaybe = (card: Card) => {
    const existing = deckCards.find(
      (c) => c.card.oracle_id === card.oracle_id && c.section === 'maybeboard',
    )
    applyEdits(
      existing
        ? deckCards.map((c) => (c.uid === existing.uid ? { ...c, quantity: c.quantity + 1 } : c))
        : [...deckCards, addedCard(card, 'maybeboard')],
    )
    setStatus(`Added ${card.name} to the maybeboard`)
  }

  /** A card dragged from the Search tab onto one of the deck's sections. An
   *  existing copy gains a quantity rather than a second row. */
  const addSearchedCard = (card: Card, section: Section) => {
    const existing = deckCards.find(
      (c) => c.card.oracle_id === card.oracle_id && c.section === section,
    )
    applyEdits(
      existing
        ? deckCards.map((c) =>
            c.uid === existing.uid ? { ...c, quantity: c.quantity + 1 } : c)
        : [...deckCards, addedCard(card, section)],
    )
    setStatus(`Added ${card.name} to ${section}`)
  }

  /* Rewrite one line of the decklist in place.
   *
   * Deliberately not routed through applyEdits, which rebuilds the text from
   * serialize() and would flatten the rest of the file -- ordering, comments,
   * blank lines -- as the price of correcting a single name. The undo entry is
   * pushed by hand so the correction is still one Ctrl-Z away. */
  const replaceName = async (entry: Resolution, name: string) => {
    const lines = text.split('\n')
    const index = entry.line_number - 1 // parse_decklist numbers from 1
    if (index < 0 || index >= lines.length) return
    // The quantity is re-emitted rather than preserved from the source line,
    // which may carry a set code or collector number that named the printing
    // this line failed to resolve.
    lines[index] = `${entry.quantity} ${name}`
    const next = lines.join('\n')

    setBusy('analyse')
    remember()
    setText(next)
    const analysed = await analyseText(next)
    if (analysed) setDeckCards(fromResolutions(analysed.entries))
    setBusy(null)
    setStatus(`Line ${entry.line_number} is now ${name}`)
  }

  const copyList = async () => {
    if (await copyText(text)) flashCopied()
    else setError('The browser refused clipboard access.')
  }

  /** Download the decklist as a .txt. Every deckbuilding site reads this
   *  format, which is the point of exporting at all. */
  const download = () => {
    const safe = (deckName.trim() || 'decklist').replace(/[^\w. -]+/g, '_')
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }))
    const link = document.createElement('a')
    link.href = url
    link.download = `${safe}.txt`
    link.click()
    // Revoked on the next frame: revoking synchronously can beat the download
    // the click just started.
    setTimeout(() => URL.revokeObjectURL(url), 0)
    setStatus(`Exported ${safe}.txt`)
  }

  const destroy = async () => {
    if (savedId === null) return
    setConfirmingDelete(false)
    setBusy('save')
    try {
      await api.deleteDeck(savedId)
      // The guard must not challenge a deck that no longer exists.
      leave('/deck')
    } catch {
      setError('Could not delete that deck.')
      setBusy(null)
    }
  }

  const enterBuildMode = async () => {
    if (!text.trim()) { setMode('build'); setDeckCards([]); return }
    setBusy('analyse')
    const analysed = await analyseText(text)
    if (analysed) setDeckCards(fromResolutions(analysed.entries))
    setMode('build')
    setBusy(null)
  }

  const getRecommendations = async () => {
    if (!text.trim()) return
    setBusy('recommend'); setError(null); setTab('recommendations')
    setAiMode(false); setAiStrategy(null); setActiveThemes([])
    try {
      setRecs(await api.recommendDeck(text, format || null, description))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not build recommendations')
      setRecs(null)
    } finally { setBusy(null) }
  }

  const getCategory = async (category: Category) => {
    if (!text.trim()) return
    setBusy(category); setError(null); setTab('recommendations')
    setAiMode(false); setAiStrategy(null); setActiveThemes([])
    try {
      setRecs(await api.recommendCategory(text, category, format || null))
    } catch (err) {
      setError(err instanceof Error ? err.message : `Could not load ${category}`)
      setRecs(null)
    } finally { setBusy(null) }
  }

  const getAiRecommendations = async () => {
    if (!text.trim()) return
    // Opens on the pipeline tab: for a multi-minute run, watching the stages
    // is the useful view until there is something to show.
    setBusy('ai'); setError(null); setTab('pipeline')
    setAiMode(true); setAiStrategy(null); setActiveThemes([]); setRecs(null)
    setPipeline((p) => ({ ...EMPTY_CONSOLE, model: p.model, running: true }))
    try {
      const { run_id } = await api.prepareAiRecommendations(text, format || null, description)
      aiStream.current?.stop()
      aiStream.current = streamDeckRecommendations(run_id, {
        onStage: (stage) => {
          setPipeline((p) => ({ ...p, stages: [...p.stages, stage], current: stage.stage }))
          const strategy = (stage.detail as { strategy?: string }).strategy
          if (strategy) setAiStrategy(strategy)
        },
        onComplete: (stage) => {
          const detail = stage.detail as unknown as RecommendReport & { strategy?: string }
          setPipeline((p) => ({
            ...p, stages: [...p.stages, stage], current: 'complete', running: false,
          }))
          setRecs({
            themes: [], color_identity: undefined, format: format || null,
            recommendations: detail.recommendations ?? [],
            note: (detail.recommendations ?? []).length ? null : 'The model found nothing worth adding.',
          })
          if (detail.strategy) setAiStrategy(detail.strategy)
          setBusy(null)
          setTab('recommendations')
        },
        onCancelled: () => {
          setPipeline((p) => ({ ...p, running: false, cancelled: true }))
          setBusy(null)
        },
        onError: (message) => {
          setPipeline((p) => ({ ...p, running: false, error: message }))
          setError(message); setBusy(null)
        },
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start the AI run')
      setPipeline((p) => ({ ...p, running: false }))
      setBusy(null)
    }
  }

  const save = async () => {
    if (!text.trim()) return
    setBusy('save'); setError(null)
    try {
      const { deck } = await api.saveDeck({
        // The binder always writes to its reserved name, which is what makes
        // it singular: saving cannot fork it into a second one.
        name: binder ? BINDER_NAME : (deckName || 'Untitled deck'), text,
        id: savedId ?? undefined, format: format || null, description,
      })
      setSavedId(deck.id)
      setDeckName(deck.name)
      setSavedText(text)
      setStatus(binder ? 'Binder saved' : `Saved “${deck.name}”`)
      // The deck is saved; the redirect onto its own URL is not a departure.
      // The binder has no such URL -- it is always at /binder.
      if (isNew && !binder) leave(`/deck/${deck.id}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save deck')
    } finally { setBusy(null) }
  }

  useEffect(() => {
    if (!report) return
    riseIn(resultRef.current)
    if (resultRef.current) dissolveIn(resultRef.current.querySelectorAll('.verdict'), { stagger: 0.02 })
  }, [report])

  useEffect(() => {
    if (recs && recRef.current) {
      riseIn(recRef.current)
      dissolveIn(recRef.current.querySelectorAll('.rec-row'), { stagger: 0.015 })
    }
  }, [recs])

  const toggleTheme = (slug: string) =>
    setActiveThemes((c) => (c.includes(slug) ? c.filter((s) => s !== slug) : [...c, slug]))

  const visibleRecs = (recs?.recommendations ?? []).filter(
    (rec) => !activeThemes.length || rec.because.some((b) => activeThemes.includes(b)),
  )
  /* The pipeline exists once a run has started and for as long as its output
   * is worth reading. Not restored with the rest of the view state: the
   * console itself is not saved, so a reopened deck has nothing to show. */
  const showPipeline = !binder && (pipeline.running || pipeline.stages.length > 0)

  useEffect(() => {
    // Restoring a deck's view can land on a tab that is no longer there.
    if (tab === 'pipeline' && !showPipeline) setTab('analysis')
  }, [tab, showPipeline])

  const reasonFor = new Map((recs?.recommendations ?? []).map((r) => [r.card.oracle_id, r.because]))
  // Every card in the commander slot. Two is the ceiling any pairing rule
  // allows, and a partner pair is two commanders rather than one commander
  // with an accessory -- so both are drawn, at the same size.
  const commanderCards = (report?.entries ?? [])
    .filter((e) => e.section === 'commander' && e.card)
    .map((e) => e.card!)
    .slice(0, 2)
  const commanderCard = commanderCards[0] ?? null
  const commanderCardId = commanderCard?.oracle_id ?? null
  const uncertain = report?.entries.filter((e) => UNCERTAIN.has(e.match)) ?? []
  const shown = showAll ? (report?.entries ?? []) : uncertain

  // Declared after commanderCardId so the dependency is in scope; re-attached
  // whenever the commander changes, and torn down with it.
  useEffect(() => {
    if (tab !== 'analysis' || !commanderTilt.current) return
    return attachTilt(commanderTilt.current, 6)
  }, [tab, commanderCardId])

  // Playtesting takes the whole screen. Goldfishing is its own activity, and
  // the decklist beside the board is exactly what you are trying to stop
  // reading: the point is to see what the deck does, not what is in it.
  //
  // Below every hook. Returning earlier skips the ones declared after it, and
  // React counts hooks per render -- which is precisely the crash this caused.
  if (playing) {
    return (
      <Playtest
        deck={deckCards}
        gameKey={viewKey}
        onClose={() => setPlaying(false)}
      />
    )
  }

  const editorPane = (
    <div className="stack gap-3" style={{ minWidth: 0 }}>
      <div className="result-tabs">
        <button className={mode === 'text' ? 'on' : ''} onClick={() => setMode('text')}>Text</button>
        <button className={mode === 'build' ? 'on' : ''} onClick={enterBuildMode}>
          Build{deckCards.length > 0 && <span className="faint"> {deckCards.length}</span>}
        </button>
      </div>

      {/* Directly under the tabs and above the editor's own toolbar, so the
          actions are reachable without scrolling past the whole deck. */}
      <div className="deck-actions">
        {/* Analyse and Recommend are gone: opening their tab runs them. A
            button whose only job is "produce the thing this tab exists to
            show" is a step between you and the answer. */}
        {/* Ramp, removal, counterspells and draw never qualify on theme alone,
            which makes them invisible rather than unwanted. This is how you ask
            for them. */}
        {/* Hidden in the binder's Text mode: they filter a list, and in Text
            mode there is no list to filter — only the raw decklist. */}
        <span className="cat-buttons" hidden={binder && mode === 'text'}>
          {CATEGORIES.map(([key, label]) => {
            const on = binder ? job === key : recs?.category === key
            return (
              <button
                key={key}
                className={on ? 'btn btn-primary sm' : 'btn btn-ghost sm'}
                aria-pressed={on}
                // Pressing the active one puts the theme recommendations back,
                // so the button is a toggle rather than a one-way trip.
                onClick={() => {
                  if (binder) { setJob(on ? null : key); return }
                  if (on) getRecommendations()
                  else getCategory(key)
                }}
                disabled={binder ? false : (!!busy || !text.trim())}
                title={binder
                  ? (on ? `Showing ${label.toLowerCase()} — click to show everything`
                        : `Show only the ${label.toLowerCase()} you own`)
                  : (on ? `Showing ${label.toLowerCase()} — click to go back to themes`
                        : `Most-played ${label.toLowerCase()} in this deck's colors`)}
              >
                {busy === key && <span className="spinner" />}
                {label}
              </button>
            )
          })}
        </span>
        {/* Nothing to recommend into: the binder is a record of what you own. */}
        {!binder && (busy === 'ai' ? (
          <button
            className="btn btn-danger sm"
            onClick={() => {
              aiStream.current?.stop()
              setBusy(null)
              /* The console has to be told as well. Closing the stream from
               * this side does not deliver the cancel event the server would
               * have sent, so `running` stayed true and the Pipeline tab span
               * forever after a run was stopped. */
              setPipeline((p) => (p.running ? { ...p, running: false, cancelled: true } : p))
            }}
          >
            Stop AI
          </button>
        ) : (
          <button
            className="btn btn-primary sm"
            data-tour="ai-recommend"
            onClick={getAiRecommendations}
            disabled={!!busy || !text.trim()}
          >
            AI recommend
          </button>
        ))}
        {!text && (
          <button className="btn btn-ghost sm push" onClick={() => setText(SAMPLE)}>Sample</button>
        )}
      </div>

      {/* B2 — a binder has no name to choose and no format to be legal in.
          It is *the* binder: one of it, named for it, and nothing about a
          format applies to a list of what you own. */}
      {mode === 'text' && !binder && (
        <div className="row gap-2 wrap">
          <label className="stack gap-1" style={{ flex: '1 1 240px', minWidth: 0 }}>
            <span className="label">Deck name</span>
            <input
              className="fld" placeholder="Untitled deck" value={deckName}
              onChange={(e) => setDeckName(e.target.value)} aria-label="Deck name"
            />
          </label>
          <label className="stack gap-1">
            <span className="label">Format</span>
            <select
              className="fld" style={{ width: 'auto' }} value={format}
              onChange={(e) => setFormat(e.target.value)} aria-label="Format"
            >
              {REC_FORMATS.map((f) => <option key={f} value={f}>{f || 'Any format'}</option>)}
            </select>
          </label>
        </div>
      )}

      {/* B2 — "How this deck works" is a statement of intent for the AI
          recommender, and a binder has neither an intent nor a recommender. */}
      {mode === 'text' && !binder && (
        <label className="stack gap-1">
          <span className="label">How this deck works</span>
          <textarea
            className="deck-desc"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Sacrifice creatures for value and drain the table. Teysa doubles the death triggers."
            spellCheck={false}
            aria-label="Deck description"
          />
          <span className="faint" style={{ fontSize: 10.5 }}>
            Saved with the deck, and given to the AI recommender before it reads the cards —
            it states intent the card list can only imply.
          </span>
        </label>
      )}

      {/* Name resolution sits with the text it is talking about: it reports on
          lines you typed, and the fix is to edit one. In the analysis tab it
          was a verdict delivered a pane away from the thing it was judging. */}
      {mode === 'text' && report && uncertain.length > 0 && (
        <div className="panel">
          <div className="row" style={{ justifyContent: 'space-between', marginBottom: 10 }}>
            <h3 style={{ margin: 0 }}>
              Name resolution
              <span style={{ color: 'var(--warn)' }}> · {uncertain.length} to check</span>
            </h3>
            <button className="btn btn-ghost sm" onClick={() => setShowAll(!showAll)}>
              {showAll ? 'Only uncertain' : `All ${report.entries.length}`}
            </button>
          </div>
          {shown.map((entry, i) => (
            <ResolutionRow key={i} entry={entry} onReplace={replaceName} busy={busy !== null} />
          ))}
        </div>
      )}

      {mode === 'text' ? (
        <textarea
          className="decklist-input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={SAMPLE}
          spellCheck={false}
          aria-label="Decklist"
        />
      ) : (
        <DeckEditor
              binder={binder}
              jobFiltered={binder ? binderCards : undefined}
              colors={colors}
              onColors={setColors}
          cards={deckCards}
          onChange={applyEdits}
          onAddSearched={addSearchedCard}
        />
      )}
    </div>
  )

  const analysisPane = (
    <div ref={resultRef} style={{ minWidth: 0 }}>
      {error && <div className="notice error"><h3>Could not continue</h3><p>{error}</p></div>}

      {/* Always rendered: Search works before there is anything to analyse,
          which is exactly when you are looking cards up. */}
      <div className="result-tabs">
        {/* Not disabled on empty: opening the tab is what fills it. */}
        <button className={tab === 'analysis' ? 'on' : ''} disabled={!text.trim()}
          onClick={() => setTab('analysis')}>
          Analysis{report && <span className="faint"> {report.total_cards}</span>}
        </button>
        {/* The binder gets Search too. Finding a card you just pulled and
            adding it is the binder's main job, and routing that through the
            Cards tray on another page was the long way round. */}
        <button
          data-tour="tab-search"
          className={tab === 'search' ? 'on' : ''}
          onClick={() => setTab('search')}
        >
          Search
        </button>
        {/* A binder is a list of what you own, not a deck being tuned, so it
            has nothing to recommend against and no pipeline to watch. */}
        {!binder && (
          <button className={tab === 'recommendations' ? 'on' : ''} disabled={!text.trim()}
            onClick={() => setTab('recommendations')}>
            Recommendations{recs && <span className="faint"> {recs.recommendations.length}</span>}
          </button>
        )}
        {/* Absent until there is a run to watch, rather than present and
            disabled. A permanently greyed tab is a question the reader has to
            answer for themselves -- and this one is only ever answered by
            pressing a button two panels away. */}
        {showPipeline && (
          <button data-tour="tab-pipeline" className={tab === 'pipeline' ? 'on' : ''}
            onClick={() => setTab('pipeline')}>
            Pipeline
            {pipeline.running && <span className="spinner" style={{ marginLeft: 6 }} />}
          </button>
        )}
      </div>

      {tab === 'search' && <DeckSearch />}

      {tab === 'analysis' && !report && !error && (
        <div className="notice">
          <h3>{busy === 'load' ? 'Loading…' : 'Nothing analysed yet'}</h3>
          <p>Build or paste a decklist, then Analyse it or ask for recommendations.</p>
        </div>
      )}

      {tab === 'pipeline' && pipeline.stages.length > 0 && (
        <SemanticConsole
          state={pipeline}
          rail={DECK_RAIL}
          title="Recommendation pipeline"
          collapsed={false}
          onToggle={() => {}}
          onStop={() => { aiStream.current?.stop(); setBusy(null) }}
        />
      )}

      {tab === 'analysis' && report && (
        <div className="stack gap-4">
          {/* The counts that used to sit here are in Deck info below, so this
              space goes to the card the deck is actually built around. */}
          {!binder && commanderCard?.image_normal && (
            <div className="chart commander-card">
              <div className="chart-head">
                <span className="label">Commander</span>
                {/* Sleeves live beside the label because that is the thing
                    they dress. When one is on, the label says so rather than
                    the button changing meaning underneath you. */}
                {sleeve
                  ? (
                    <>
                      <span className="label sleeved">· Sleeved</span>
                      <button
                        className="sleeve-clear"
                        title="Remove these sleeves"
                        aria-label="Remove these sleeves"
                        onClick={() => {
                          if (deckId) clearSleeve(deckId)
                          setSleeveArt(null)
                        }}
                      >
                        ⟳
                      </button>
                    </>
                  )
                  : (
                    <button
                      className="sleeve-add"
                      title="Use an image as this deck's sleeves"
                      disabled={!deckId || deckId === 'new'}
                      onClick={() => sleeveInput.current?.click()}
                    >
                      Sleeves
                    </button>
                  )}
                <input
                  ref={sleeveInput}
                  type="file"
                  accept="image/*"
                  hidden
                  onChange={async (e) => {
                    const file = e.target.files?.[0]
                    e.target.value = ''
                    if (!file || !deckId) return
                    try {
                      const url = await readSleeveFile(file)
                      setSleeve(deckId, url)
                      setSleeveArt(url)
                      setSleeveError(null)
                    } catch (err) {
                      setSleeveError(err instanceof Error ? err.message : 'Could not use that image.')
                    }
                  }}
                />
              </div>
              {sleeveError && (
                <p className="sleeve-error" role="alert">{sleeveError}</p>
              )}
              {/* The same pointer tilt the card grids use, but nothing overlaid
                  on hover — everything those badges would say is printed on the
                  card, and this one is a portrait, not a row in a list. */}
              {/* The sleeve sits behind and offset, the way a sleeved card
                  shows its back above the card in front of it. Outside the
                  tilted link on purpose: the commander keeps its pointer
                  tilt, and the sleeve stays flat behind it rather than
                  swinging with it, which is what a stack on a table does. */}
              {/* One stack per commander, stacked vertically.
                  The sleeve is an inset:0 layer inside the stack, so putting
                  two cards in one stack stretched a single sleeve across both
                  and it spilled out under them. Each card gets its own stack,
                  its own sleeve, and the pair is just a column. */}
              <div className={commanderCards.length > 1 ? 'commander-pair' : 'commander-solo'}>
                {commanderCards.filter((c) => c.image_normal).map((cmd, i) => (
                  <div
                    key={cmd.oracle_id}
                    className={`commander-stack${sleeve ? ' sleeved' : ''}`}
                  >
                    {sleeve && <img className="sleeve-art" src={sleeve} alt="" aria-hidden />}
                    <Link
                      to={`/card/${cmd.oracle_id}`}
                      title={cmd.name}
                      /* Only the first takes the pointer tilt: the ref holds
                         one node, and two cards leaning independently under
                         one cursor reads as two things rather than a pair. */
                      ref={i === 0 ? commanderTilt : undefined}
                    >
                      <img src={cmd.image_normal!} alt={cmd.name} />
                    </Link>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Only shown when it is a problem. A green zero reports that
              nothing went wrong, which is not worth a tile. */}
          {report.unresolved_count > 0 && (
            <div className="stat-row">
              <div className="stat">
                <span className="v mono" style={{ color: 'var(--danger)' }}>
                  {report.unresolved_count}
                </span>
                <span className="label">Unresolved</span>
              </div>
            </div>
          )}

          {/* Charts first: the shape of the deck is what you opened this tab
              for. DeckInfo is reference material and goes last. */}
          {/* B2 — no manabase panel and no cost/land donut in the binder.
              Both answer "can this deck cast what it plays?", which is a
              question about a deck. A binder is not trying to cast anything. */}
          {!binder && report.stats && !report.stats.empty && <DeckCharts stats={report.stats} />}

          {binder && <BinderInfo cards={binderCards} />}

          {!binder && report.stats && !report.stats.empty && (
            <DeckInfo
              report={report}
              stats={report.stats}
              createdAt={savedAt?.created}
              updatedAt={savedAt?.updated}
            />
          )}
        </div>
      )}

      {tab === 'recommendations' && recs && (
        <div className="panel" ref={recRef}>
          <div className="row wrap gap-2" style={{ justifyContent: 'space-between', marginBottom: 10 }}>
            <h3 style={{ margin: 0 }}>
              {recs.category
                ? CATEGORIES.find(([k]) => k === recs.category)?.[1] ?? 'Recommendations'
                : aiMode ? 'AI recommendations' : 'Recommendations'}
              <span className="faint">
                {' · '}{visibleRecs.length} of {recs.recommendations.length}
                {recs.color_identity ? ` · within ${recs.color_identity}` : ''}
              </span>
            </h3>
            <div className="row gap-2">
              {/* Throws the current list away and asks again from scratch —
                  the way out of a category, a stale run or a filtered view. */}
              <button
                className="btn btn-ghost sm rec-reset"
                onClick={() => { setActiveThemes([]); setAiMode(false); getRecommendations() }}
                disabled={!!busy}
                title="Recalculate recommendations"
                aria-label="Recalculate recommendations"
              >
                ↻
              </button>
              {recView === 'grid' && (
                <label className="size-slider" title="Card size">
                  <input type="range" min={110} max={300} step={10} value={recSize}
                    onChange={(e) => setRecSize(Number(e.target.value))} aria-label="Card image size" />
                </label>
              )}
              <button className="btn btn-ghost sm" onClick={() => setRecView(recView === 'list' ? 'grid' : 'list')}>
                {recView === 'list' ? 'Images' : 'List'}
              </button>
            </div>
          </div>

          {recs.note && <p className="muted" style={{ fontSize: 13 }}>{recs.note}</p>}

          {aiStrategy && <p className="muted" style={{ fontSize: 13, marginBottom: 10 }}>{aiStrategy}</p>}

          {recs.themes.length > 0 && (
            <>
              <p className="faint" style={{ fontSize: 11, marginBottom: 8 }}>
                Themes from the tags your cards carry, weighted against how common each tag is.
                Solid chips are signature themes — a card must hit one to be suggested. ✦ marks
                themes your description named, which are ranked up. Click to filter.
              </p>
              <div className="row wrap gap-1" style={{ marginBottom: 14 }}>
                {recs.themes.map((t) => (
                  <button key={t.slug}
                    className={`chip ${activeThemes.includes(t.slug) ? 'on' : ''} ${t.signature ? '' : 'supporting'}`}
                    title={
                      `${t.in_deck} here, ${t.corpus} in the corpus`
                      + (t.described ? ' · named in your description, so ranked up' : '')
                    }
                    onClick={() => toggleTheme(t.slug)}>
                    {t.described && <span className="described" aria-hidden>✦ </span>}
                    {t.slug} <span className="faint">×{t.in_deck}</span>
                  </button>
                ))}
                {activeThemes.length > 0 && (
                  <button className="btn btn-ghost sm" onClick={() => setActiveThemes([])}>Clear</button>
                )}
              </div>
            </>
          )}

          {recView === 'grid' ? (
            <CardGrid cards={visibleRecs.map((r) => r.card)} size={recSize}
              onAdd={addToMaybe}
              addLabel="Add to maybeboard"
              captionFor={(card) => reasonFor.get(card.oracle_id)?.join(' · ')} />
          ) : (
            visibleRecs.map((rec) => (
              <div className="resolution rec-row" key={rec.card.oracle_id}>
                <span className="to">
                  {/* The name searches for the card; the `i` opens it.
                      A suggestion is something you want to look into — see the
                      printings, the price history, what else is like it — and
                      the search page is where that happens. Reading the card
                      itself keeps its own control so neither is lost. */}
                  <Link
                    to={`/?q=${encodeURIComponent(`!"${rec.card.name}"`)}`}
                    title={`Search for ${rec.card.name}`}
                  >
                    {rec.card.name}
                  </Link>{' '}
                  <Link
                    to={`/card/${rec.card.oracle_id}`}
                    className="rec-info"
                    title={`Open ${rec.card.name}`}
                    aria-label={`Open ${rec.card.name}`}
                  >
                    i
                  </Link>{' '}
                  <ManaCost cost={rec.card.mana_cost} />
                  {rec.because.length > 0 && (
                    <span className="faint" style={{ fontSize: 11, display: 'block' }}>
                      {rec.because.slice(0, 3).join(' · ')}
                    </span>
                  )}
                </span>
                <span className="mono faint" style={{ fontSize: 11 }}>
                  {rec.card.usd !== null ? `$${rec.card.usd.toFixed(2)}` : '—'}
                </span>
                {/* Most suggestions want considering, not committing, so the
                    plain add goes to the maybeboard of this deck. It used to
                    go to the Cards collection, which meant a suggestion landed
                    in a queue on another page and had to be imported back. */}
                <button className="btn btn-ghost sm" title="Add to the maybeboard"
                  onClick={() => addToMaybe(rec.card)}>+ maybe</button>
                <button className="btn btn-ghost sm" title="Add straight to the deck"
                  onClick={() => applyEdits([...deckCards, addedCard(rec.card, 'main')])}>
                  ↓ deck
                </button>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  )

  return (
    <section className="shell">
      <div className="page-back">
        <button className="back-link" onClick={() => navigate('/deck')}>← All decks</button>
      </div>

      {/* Page-level actions live in the page header: they act on the whole
          deck, and anywhere lower puts the Playtest button underneath the
          panel it toggles. */}
      <div className="deck-head">
        {/* Read-only here. The title bar is the deck's identity, not a form:
            the field and the dropdown live under Text, where you are already
            editing what the deck is. */}
        <h2 className="deck-title">
          {binder ? 'Binder' : (deckName.trim() || 'Untitled deck')}
        </h2>
        {/* `__binder__` is a storage key, not a title, and a binder is not
            legal or illegal in anything — so neither the reserved name nor the
            format chip belongs above it. */}
        {!binder && <span className="chip">{format || 'Any format'}</span>}

        {/* Save and Playtest act on the deck as a whole, not on whichever tab
            is open, so they sit with the deck's name rather than beside the
            per-tab actions. */}
        {/* Unsaved work is worth saying out loud, next to the button that
            resolves it. */}
        {dirty && (
          <span className="mono" style={{ fontSize: 11, color: 'var(--warn)' }}>
            unsaved
          </span>
        )}

        <div className="row gap-2 push" data-tour="deck-bar">
          <button className="btn btn-primary sm" onClick={save} disabled={!!busy || !text.trim()}>
            {busy === 'save' && <span className="spinner" />}Save
          </button>
          {/* None of the next three mean anything for a binder. You cannot
              goldfish a shelf of cards, there is no commander to simulate a
              mana base against, and copying the binder produces a second copy
              of the one list that is meant to be singular. */}
          {!binder && (
            <button
              className="btn sm"
              onClick={() => setPlaying((p) => !p)}
              disabled={!deckCards.length}
              title={deckCards.length ? 'Goldfish this deck' : 'Build or load a deck first'}
            >
              {playing ? 'Close playtest' : 'Playtest'}
            </button>
          )}
          {/* Playtest shows you one game. Simulation shows you a thousand,
              which is the only way to see a pattern rather than an anecdote.
              Needs a saved deck: the page loads the list by id. */}
          {!binder && (
            <button
              className="btn sm"
              onClick={() => navigate(`/simulate/${deckId}`)}
              disabled={!deckCards.length || !deckId}
              title={deckId
                ? 'Shuffle and play the opening turns many times over'
                : 'Save the deck first'}
            >
              Simulation
            </button>
          )}
          {/* A decklist is portable text, and every other site reads it. Not
              being able to get one back out made this a place decks came to
              and stayed. */}
          {!binder && (
            <button
              className={copied ? 'btn btn-primary sm' : 'btn btn-ghost sm'}
              onClick={copyList}
              disabled={!text.trim()}
              title="Copy the decklist to the clipboard"
            >
              {copied ? '✓ Copied' : 'Copy'}
            </button>
          )}
          <button
            className="btn btn-ghost sm"
            onClick={download}
            disabled={!text.trim()}
            title="Download as a .txt file"
          >
            Export
          </button>
          {savedId !== null && (
            <button
              className="btn btn-danger sm"
              onClick={() => setConfirmingDelete(true)}
              disabled={!!busy}
              title="Delete this deck"
            >
              Delete
            </button>
          )}
        </div>
      </div>

      {/* A toast, not a line in the flow.
          Saving is confirmed at the top of a page you may have scrolled a long
          way down, and a small green sentence up there is indistinguishable
          from not having saved at all. This one is pinned to the viewport and
          announced, so the answer arrives wherever you are. */}
      {status && (
        <div className="save-toast mono" role="status" aria-live="polite">
          <span className="tick" aria-hidden>✓</span>
          {status}
        </div>
      )}


      {confirmingDelete && (
        <div className="modal-backdrop" onClick={() => setConfirmingDelete(false)} role="presentation">
          <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal>
            <h3>Delete “{deckName.trim() || 'Untitled deck'}”?</h3>
            <p className="muted">
              The decklist, its description and its saved format go with it. This cannot be
              undone.
            </p>
            <div className="row gap-2" style={{ marginTop: 'var(--gap-3)' }}>
              <button className="btn btn-danger sm" onClick={destroy}>Delete deck</button>
              <button className="btn btn-ghost sm" onClick={() => setConfirmingDelete(false)}>
                Keep it
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Three ways out, because all three are things people actually mean:
          save and carry on leaving, leave anyway, or stay. A prompt offering
          only the last two makes you cancel, save, and navigate again. */}
      {blocker.state === 'blocked' && (
        <div className="modal-backdrop" onClick={() => blocker.reset()} role="presentation">
          <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal>
            <h3>This deck has unsaved changes</h3>
            <p className="muted">
              Leaving now discards everything since the last save, including the undo history.
            </p>
            <div className="row gap-2 wrap" style={{ marginTop: 'var(--gap-3)' }}>
              <button
                className="btn btn-primary sm"
                disabled={!!busy}
                onClick={async () => {
                  await save()
                  blocker.proceed?.()
                }}
              >
                {busy === 'save' && <span className="spinner" />}Save and leave
              </button>
              <button className="btn btn-danger sm" onClick={() => blocker.proceed?.()}>
                Discard changes
              </button>
              <button className="btn btn-ghost sm" onClick={() => blocker.reset?.()}>
                Stay here
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Both open at the splitter's right-hand limit: the cards are what you
          came to look at, and the analysis beside them is a reference you turn
          to rather than read continuously. Dragging it back is one motion and
          is remembered.

          B9 — the binder additionally cannot be dragged as far left. Its list
          is the whole page, so squeezing it to a quarter of the width, which is
          fine for a deck beside its charts, just clips it. */}
      <SplitPane
        storageKey={binder ? 'insight-enigma:binder-split' : 'insight-enigma:deck-split'}
        initial={0.75}
        min={binder ? 0.45 : 0.25}
        left={editorPane}
        right={analysisPane}
      />
    </section>
  )
}
