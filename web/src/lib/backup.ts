import { api, type Card, type SavedDeck } from './api'
import { collection } from './collection'
import { allSleeves, clearSleeve, setSleeve } from './sleeves'

/**
 * Backup and restore.
 *
 * One JSON file holding everything you made: your decks, the binder among
 * them, the cards you have collected, and the sleeves you put on decks. Not
 * the card mirror — that is 220MB of Scryfall's data which any install can
 * rebuild, and it is not yours.
 *
 * Two decisions shape the format.
 *
 * **Decks travel by name, not by id.** Ids are handed out by whichever
 * database wrote them, so a file restored into another install — or into this
 * one after a rebuild — would collide with whatever already holds those
 * numbers. Names are what you actually recognise a deck by, and the binder's
 * reserved name is what keeps it singular across a restore too.
 *
 * **Restore replaces.** The file is a snapshot, and restoring one puts this
 * install back into the state the snapshot was taken in: decks in the file
 * are written, decks that are not in it are deleted, and the collection is
 * replaced wholesale. Anything made since the backup is gone.
 *
 * That is destructive on purpose, and it is the behaviour a backup file is
 * expected to have -- a restore that merged left you with a mixture of two
 * moments in time and no way to get back to either. It is guarded by a
 * confirmation that says what will be removed, and `restore` reports the
 * deletions so the page can state them afterwards.
 */

export const BACKUP_KIND = 'insight-engine-backup'
export const BACKUP_VERSION = 1

export interface Backup {
  kind: typeof BACKUP_KIND
  version: number
  exported_at: string
  decks: BackupDeck[]
  collection: Card[]
  /** Keyed by deck *name*, for the same reason the decks are. */
  sleeves: Record<string, string>
}

export interface BackupDeck {
  name: string
  text: string
  format: string | null
  description: string | null
}

/** What a restore did, so the page can say so rather than just claiming
 *  success. */
export interface RestoreReport {
  created: number
  updated: number
  /** Decks removed because the snapshot does not contain them. */
  deleted: number
  sleeves: number
  collected: number
  failed: string[]
}

/** What restoring a given file would destroy, for the confirmation. */
export interface RestorePreview {
  /** Names of decks here that the snapshot does not have. */
  losing: string[]
  /** Decks in the snapshot that will overwrite one of the same name. */
  overwriting: number
  arriving: number
}

export async function previewRestore(backup: Backup): Promise<RestorePreview> {
  const { decks: existing } = await api.savedDecks()
  const wanted = new Map<string, number>()
  for (const d of backup.decks) wanted.set(d.name, (wanted.get(d.name) ?? 0) + 1)

  const losing: string[] = []
  const seen = new Map<string, number>()
  for (const d of existing as SavedDeck[]) {
    const used = seen.get(d.name) ?? 0
    if (used < (wanted.get(d.name) ?? 0)) seen.set(d.name, used + 1)
    else losing.push(d.name)
  }
  const overwriting = [...seen.values()].reduce((n, v) => n + v, 0)
  return { losing, overwriting, arriving: backup.decks.length - overwriting }
}

export async function exportAll(): Promise<Backup> {
  const { decks } = await api.savedDecks()
  /* The listing does not carry decklist text, so each deck is fetched. Serial
   * rather than parallel: a backup is not a hot path, and forty simultaneous
   * requests at a local server that is also indexing is a worse trade than
   * waiting a moment. */
  const full: BackupDeck[] = []
  const byId = new Map<number, string>()
  for (const deck of decks) {
    try {
      const loaded = await api.loadDeck(deck.id)
      byId.set(deck.id, loaded.deck.name)
      full.push({
        name: loaded.deck.name,
        text: loaded.deck.text ?? '',
        format: loaded.deck.format ?? null,
        description: loaded.deck.description ?? null,
      })
    } catch {
      // A deck that will not load is a deck that cannot be backed up. Skipping
      // it beats failing the whole export over one bad row.
    }
  }

  // Re-key the sleeves from ids onto names, dropping any whose deck has gone.
  const sleeves: Record<string, string> = {}
  for (const [id, art] of Object.entries(allSleeves())) {
    const name = byId.get(Number(id))
    if (name) sleeves[name] = art
  }

  return {
    kind: BACKUP_KIND,
    version: BACKUP_VERSION,
    exported_at: new Date().toISOString(),
    decks: full,
    collection: collection.snapshot(),
    sleeves,
  }
}

/** Parse and sanity-check a file before anything is written. */
export function parseBackup(raw: string): Backup {
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    throw new Error('That file is not JSON.')
  }
  const backup = data as Partial<Backup>
  if (backup?.kind !== BACKUP_KIND) {
    throw new Error('That is not an Insight Engine backup.')
  }
  if (typeof backup.version !== 'number' || backup.version > BACKUP_VERSION) {
    throw new Error(`That backup is version ${String(backup.version)}; this app reads up to ${BACKUP_VERSION}.`)
  }
  if (!Array.isArray(backup.decks)) throw new Error('That backup has no decks in it.')
  return {
    kind: BACKUP_KIND,
    version: backup.version,
    exported_at: typeof backup.exported_at === 'string' ? backup.exported_at : '',
    decks: backup.decks,
    collection: Array.isArray(backup.collection) ? backup.collection : [],
    sleeves: backup.sleeves && typeof backup.sleeves === 'object' ? backup.sleeves : {},
  }
}

export async function restore(backup: Backup): Promise<RestoreReport> {
  const { decks: existing } = await api.savedDecks()
  /* A *queue* of ids per name, not one id per name.
   *
   * Deck names are not unique — this database has two called "Orzhov
   * Aristocrats" — so a plain name-to-id map would point both backup entries
   * at the same deck, and restoring would silently overwrite one with the
   * other and leave you a deck short. Each existing deck of a given name is
   * claimed once, in order; a backup entry with no unclaimed match left is
   * created instead. Duplicates survive a round trip as duplicates. */
  const available = new Map<string, number[]>()
  for (const d of existing as SavedDeck[]) {
    const queue = available.get(d.name)
    if (queue) queue.push(d.id)
    else available.set(d.name, [d.id])
  }

  const report: RestoreReport = {
    created: 0, updated: 0, deleted: 0, sleeves: 0, collected: 0, failed: [],
  }

  for (const deck of backup.decks) {
    try {
      const known = available.get(deck.name)?.shift()
      const saved = await api.saveDeck({
        name: deck.name,
        text: deck.text,
        id: known,
        format: deck.format,
        description: deck.description,
      })
      if (known) report.updated += 1
      else report.created += 1

      // The sleeve goes onto whatever id this install just used.
      const art = backup.sleeves[deck.name]
      if (art) {
        setSleeve(String(saved.deck.id), art)
        report.sleeves += 1
      }
    } catch {
      report.failed.push(deck.name)
    }
  }

  /* Whatever is left unclaimed was not in the snapshot, so it postdates it and
   * goes. Done after the writes rather than before: if a save fails partway,
   * the decks it would have replaced are still here. */
  for (const ids of available.values()) {
    for (const id of ids) {
      try {
        await api.deleteDeck(id)
        clearSleeve(String(id))
        report.deleted += 1
      } catch {
        report.failed.push(`could not delete deck ${id}`)
      }
    }
  }

  /* The collection is replaced, not merged -- a snapshot of what you had
   * collected, not an addition to it. */
  collection.clear()
  for (const card of backup.collection) {
    if (card?.oracle_id) {
      collection.add(card)
      report.collected += 1
    }
  }

  return report
}

/** Hand the file to the browser. */
export function download(backup: Backup) {
  const stamp = new Date().toISOString().slice(0, 10)
  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `insight-engine-${stamp}.json`
  document.body.appendChild(link)
  link.click()
  link.remove()
  // Revoked on the next tick: revoking synchronously can beat the download in
  // some browsers and produce an empty file.
  setTimeout(() => URL.revokeObjectURL(url), 0)
}
