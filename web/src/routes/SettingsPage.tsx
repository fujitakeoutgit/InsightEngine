import { useEffect, useRef, useState } from 'react'

import {
  DEFAULT_ACCENT, applyAccent, deriveAccent, hexToHsl, hslToHex, hslToHsv,
  hsvToHsl, isHex, normalizeHex, readAccent, resetAccent, saveAccent,
} from '../lib/accent'
import { api, type ModelTier, type SyncStatus } from '../lib/api'
import { riseIn } from '../lib/motion'
import {
  COIN_SKINS, DICE_SKINS, readCoinSkin, readD20Skin, readDieSkin,
  skinVars, writeCoinSkin, writeD20Skin, writeDieSkin,
} from '../lib/skins'
import { SkinStage } from '../components/SkinStage'
import {
  download, exportAll, parseBackup, previewRestore, restore,
  type Backup, type RestorePreview, type RestoreReport,
} from '../lib/backup'
import { useEscape } from '../lib/usePersisted'
import { PageHead } from '../components/PageHead'

/**
 * Settings.
 *
 * Save and Cancel sit at the top rather than the bottom, beside the title,
 * because they act on the page as a whole and the page is long enough that a
 * footer would put them off screen while you are still choosing.
 *
 * Nothing is applied until Save. The dropdown edits a draft; Cancel puts the
 * saved value back. That is the ordinary contract for a settings form, and
 * worth honouring here precisely because the setting is expensive to get
 * wrong -- picking a model your card cannot hold makes every semantic search
 * take minutes.
 */
/** What each derived colour is for, so the swatches are readable. */
const FAMILY_ROLES: [string, string][] = [
  ['--aether', 'Buttons, tab underline, focus'],
  ['--aether-hi', 'Hover and links'],
  ['--aether-deep', 'Ambient background'],
  ['--chrome', 'Glass, hairlines, dividers'],
  ['--aether-ink', 'Text on the accent'],
]

/**
 * Pick the one colour the interface is built from.
 *
 * HSV for the sliders because that is what colour pickers speak and what most
 * people have a feel for; the derivation underneath works in HSL, where the
 * family's actual relationships live. Hex as well, because half the time you
 * already have the value you want.
 *
 * Applied live rather than behind an Apply button: the swatches below are a
 * poor substitute for seeing the real thing, and the page you are standing on
 * is the best preview there is.
 */
function AccentPicker() {
  const [accent, setAccent] = useState(readAccent)
  const [draft, setDraft] = useState(() => readAccent().replace('#', ''))
  const hsv = hslToHsv(hexToHsl(accent))
  const family = deriveAccent(accent)

  const commit = (hex: string) => {
    setAccent(hex)
    setDraft(hex.replace('#', ''))
    applyAccent(hex)
    saveAccent(hex)
  }

  const setChannel = (channel: 'h' | 's' | 'v', value: number) =>
    commit(hslToHex(hsvToHsl({ ...hsv, [channel]: value })))

  const channels: [('h' | 's' | 'v'), string, number][] = [
    ['h', 'Hue', 360], ['s', 'Saturation', 100], ['v', 'Value', 100],
  ]

  return (
    <div className="accent-picker">
      {channels.map(([key, label, max]) => (
        <label key={key} className={`accent-slider ${key === 'h' ? 'hue' : ''}`}>
          <span className="label">{label}</span>
          <input
            type="range" min={0} max={max} step={key === 'h' ? 1 : 0.5}
            value={Math.round(hsv[key] * 10) / 10}
            onChange={(e) => setChannel(key, Number(e.target.value))}
            aria-label={label}
          />
          <input
            className="fld num"
            type="number" min={0} max={max}
            value={Math.round(hsv[key])}
            onChange={(e) => setChannel(key, Number(e.target.value))}
            aria-label={`${label} value`}
          />
        </label>
      ))}

      <label className="accent-hex">
        <span className="label">Hex</span>
        <span className="hex-field">
          <span className="hash">#</span>
          <input
            className="fld mono"
            value={draft}
            spellCheck={false}
            maxLength={6}
            // Typed freely and only applied once it is a colour, so deleting
            // back to nothing does not repaint the app black on the way.
            onChange={(e) => {
              const next = e.target.value.replace(/[^0-9a-fA-F]/g, '')
              setDraft(next)
              if (isHex(next)) commit(normalizeHex(next))
            }}
            aria-label="Accent colour hex"
          />
        </span>
        <button
          className="btn btn-ghost sm"
          onClick={() => { resetAccent(); const d = DEFAULT_ACCENT; setAccent(d); setDraft(d.replace('#', '')) }}
          title={`Back to ${DEFAULT_ACCENT}`}
        >
          Reset
        </button>
      </label>

      <div className="accent-family">
        {FAMILY_ROLES.map(([name, role]) => (
          <div className="accent-swatch" key={name}>
            <span className="chip" style={{ background: family[name] }} aria-hidden />
            <span className="mono">{family[name]}</span>
            <span className="faint">{role}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

/** The phases a card-pool update passes through, in the order they happen. */
const SYNC_STAGES: [string, string][] = [
  ['copy', 'Copy'],
  ['download', 'Download'],
  ['index', 'Index'],
  ['swap', 'Swap in'],
]

/** An update's progress as a rail — the same one the semantic search draws.
 *
 * A refresh takes minutes, and showed nothing for them but a button reading
 * "Updating…" and a growing wall of log lines. The rail answers the question
 * anyone waiting actually has: which part is this, and how much is left. It is
 * the shape this app already uses for a long job with known phases, so it
 * needs no introduction.
 */
function SyncStages({ stage }: { stage: string | null }) {
  const at = SYNC_STAGES.findIndex(([key]) => key === stage)
  const finished = stage === 'done'
  return (
    <div className="stages" style={{ marginTop: 14 }}>
      {SYNC_STAGES.map(([key, label], i) => {
        const done = finished || (at > -1 && i < at)
        return (
          <div
            key={key}
            className={`stage ${!finished && key === stage ? 'active' : ''} ${done ? 'done' : ''}`}
          >
            <span className="dot" />
            {label}
          </div>
        )
      })}
    </div>
  )
}

export function SettingsPage() {
  const [dieSkin, setDieSkin] = useState(readDieSkin)
  const [d20Skin, setD20Skin] = useState(readD20Skin)
  const [coinSkin, setCoinSkin] = useState(readCoinSkin)
  const [sync, setSync] = useState<SyncStatus | null>(null)
  const [syncBusy, setSyncBusy] = useState<'check' | 'refresh' | null>(null)
  const [syncLog, setSyncLog] = useState<string[]>([])
  const [syncStage, setSyncStage] = useState<string | null>(null)

  /* Polled only while a refresh is actually running. A background poll on a
   * settings page nobody is looking at would be a request every few seconds
   * forever, to learn nothing. */
  useEffect(() => {
    api.syncStatus().then(setSync).catch(() => {})
  }, [])

  useEffect(() => {
    if (!sync?.running && syncBusy !== 'refresh') return
    const timer = setInterval(async () => {
      try {
        const p = await api.syncProgress()
        setSyncLog(p.log)
        setSyncStage(p.stage)
        if (!p.running) {
          setSyncBusy(null)
          // The server rechecks Scryfall before it reports finished, so this
          // status is the post-update truth rather than the stamps from before.
          setSync(await api.syncStatus())
        }
      } catch { /* the server is busy rebuilding; try again next tick */ }
    }, 2000)
    return () => clearInterval(timer)
  }, [sync?.running, syncBusy])

  const [backupBusy, setBackupBusy] = useState<'export' | 'import' | null>(null)
  const [backupNote, setBackupNote] = useState<string | null>(null)
  const [backupError, setBackupError] = useState<string | null>(null)
  const backupInput = useRef<HTMLInputElement>(null)

  /** A restore that is waiting on its confirmation. */
  const [pending, setPending] = useState<
    null | { backup: Backup; preview: RestorePreview }
  >(null)
  useEscape(() => setPending(null), Boolean(pending))

  const said = (r: RestoreReport) => {
    const bits = [
      r.created && `${r.created} deck${r.created === 1 ? '' : 's'} added`,
      r.updated && `${r.updated} updated`,
      // Stated even when zero would be tidier, because a deletion is the one
      // outcome someone will want to see confirmed in words.
      r.deleted && `${r.deleted} deleted`,
      r.sleeves && `${r.sleeves} sleeved`,
      r.collected && `${r.collected} card${r.collected === 1 ? '' : 's'} collected`,
    ].filter(Boolean)
    const done = bits.length ? bits.join(', ') : 'nothing to change'
    return r.failed.length ? `${done}. Could not restore: ${r.failed.join(', ')}.` : `${done}.`
  }
  const [tiers, setTiers] = useState<ModelTier[]>([])
  /** What the server has. The draft is compared against this to know whether
   *  there is anything to save. */
  const [saved, setSaved] = useState<string | null>(null)
  const [draft, setDraft] = useState<string>('')
  const [isCustom, setIsCustom] = useState(false)
  const [defaultModel, setDefaultModel] = useState('')
  const [installed, setInstalled] = useState<string[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)

  useEffect(() => {
    api.settings()
      .then((s) => {
        setTiers(s.tiers)
        setSaved(s.model)
        setDraft(s.model)
        setIsCustom(s.is_custom)
        setDefaultModel(s.default_model)
      })
      .catch(() => setError('Could not read settings from the server.'))
    // Which models are actually pulled, so a choice that will not run says so
    // before it is saved rather than at the end of a failed search.
    api.semanticStatus()
      .then((s) => setInstalled(s.models))
      .catch(() => setInstalled(null))
  }, [])

  useEffect(() => {
    if (!status) return
    const timer = setTimeout(() => setStatus(null), 2600)
    return () => clearTimeout(timer)
  }, [status])

  const dirty = saved !== null && draft !== saved
  const chosen = tiers.find((t) => t.id === draft)
  const missing = installed !== null && draft !== '' && !installed.includes(draft)

  const save = async () => {
    setBusy(true)
    setError(null)
    try {
      const { model } = await api.saveSettings(draft)
      setSaved(model)
      setDraft(model)
      setIsCustom(false)
      setStatus('Saved')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save settings')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="shell" ref={riseIn}>
      <PageHead
        eyebrow="Configuration"
        title="Settings"
        subtitle="Applies to q: searches and AI deck recommendations. Ordinary searches do not use a model."
      >
        <button
          className="btn btn-ghost sm"
          onClick={() => { if (saved) setDraft(saved) }}
          disabled={!dirty || busy}
        >
          Cancel
        </button>
        <button className="btn btn-primary sm" onClick={save} disabled={!dirty || busy}>
          {busy && <span className="spinner" />}Save
        </button>
      </PageHead>

      {error && <div className="notice error"><h3>Could not continue</h3><p>{error}</p></div>}

      {status && (
        <p className="mono" style={{ fontSize: 12, color: 'var(--ok)', marginBottom: 12 }}>
          {status}
        </p>
      )}

      <div className="panel settings-panel">
        <h3>Accent colour</h3>
        <p className="muted" style={{ fontSize: 13, marginBottom: 14 }}>
          The interface is built from one colour — the buttons, the tab
          underline, the focus ring, and the glass and hairlines everything is
          drawn with. Pick a new one and the other four are derived from it,
          keeping the relationships the design was drawn with.
        </p>
        <AccentPicker />
      </div>

      <div className="panel settings-panel" data-tour="card-data">
        <h3>Card data</h3>
        <p className="muted" style={{ fontSize: 13, marginBottom: 14 }}>
          Every card in print, mirrored locally from Scryfall. Checked each time the
          app starts; nothing is downloaded until you ask, because a refresh replaces
          the card table and a failed one would leave you with none.
        </p>

        {sync?.ready ? (
          <>
            <div className="sync-facts mono">
              <span>{(sync.cards ?? 0).toLocaleString()} cards</span>
              <span className="faint">·</span>
              <span>built {(sync.built_at ?? '').slice(0, 10) || 'never'}</span>
              {sync.checked_at && (
                <>
                  <span className="faint">·</span>
                  <span className="faint">checked {sync.checked_at.slice(0, 10)}</span>
                </>
              )}
            </div>

            <p className={sync.update_available ? 'sync-state stale' : 'sync-state current'}>
              {sync.update_available
                ? 'Scryfall has newer data than this mirror.'
                : 'This mirror is up to date.'}
            </p>
          </>
        ) : (
          <p className="muted" style={{ fontSize: 12.5 }}>Card data has not been built yet.</p>
        )}

        <div className="row gap-2" style={{ flexWrap: 'wrap', marginTop: 4 }}>
          <button
            className="btn btn-ghost sm"
            disabled={!!syncBusy}
            onClick={async () => {
              setSyncBusy('check')
              try { setSync(await api.syncCheck()) } catch { /* offline */ }
              finally { setSyncBusy(null) }
            }}
          >
            {syncBusy === 'check' ? 'Checking…' : 'Check now'}
          </button>

          <button
            className="btn btn-primary sm"
            data-tour="update-pool"
            disabled={!!syncBusy || !!sync?.running}
            onClick={async () => {
              // Straight into the work. It used to be reasonable to press
              // Check now first to find out whether this was worth doing; the
              // refresh has always asked Scryfall for itself, and now it
              // rechecks afterwards too, so this is the only button the job
              // needs.
              setSyncBusy('refresh'); setSyncLog([]); setSyncStage('copy')
              try { await api.syncRefresh() } catch { setSyncBusy(null); setSyncStage(null) }
            }}
          >
            {syncBusy === 'refresh' || sync?.running ? 'Updating…' : 'Update Card Pool'}
          </button>
        </div>

        {(syncBusy === 'refresh' || sync?.running) && (
          <>
            <SyncStages stage={syncStage} />
            <p className="faint" style={{ fontSize: 11.5, marginTop: 10 }}>
              A few hundred megabytes, and several minutes. Searching keeps working until
              the new data is written.
            </p>
          </>
        )}

        {syncLog.length > 0 && (
          <pre className="sync-log mono">{syncLog.join('\n')}</pre>
        )}

        {sync?.error && (
          <p style={{ fontSize: 12.5, marginTop: 10, color: 'var(--danger)' }}>{sync.error}</p>
        )}
      </div>

      <div className="panel settings-panel" data-tour="backup">
        <h3>Backup</h3>
        <p className="muted" style={{ fontSize: 13, marginBottom: 14 }}>
          One file holding your decks, the binder, the cards you have collected and
          the sleeves you put on decks. Not the card data — that is Scryfall's, it is
          220MB, and any install can rebuild it.
        </p>

        <div className="row gap-2" style={{ flexWrap: 'wrap' }}>
          <button
            className="btn btn-primary sm"
            disabled={!!backupBusy}
            onClick={async () => {
              setBackupBusy('export'); setBackupError(null); setBackupNote(null)
              try {
                const backup = await exportAll()
                download(backup)
                setBackupNote(`Exported ${backup.decks.length} deck${backup.decks.length === 1 ? '' : 's'}.`)
              } catch (err) {
                setBackupError(err instanceof Error ? err.message : 'Could not export.')
              } finally { setBackupBusy(null) }
            }}
          >
            {backupBusy === 'export' ? 'Exporting…' : 'Export'}
          </button>

          <button
            className="btn btn-ghost sm"
            disabled={!!backupBusy}
            onClick={() => backupInput.current?.click()}
          >
            {backupBusy === 'import' ? 'Restoring…' : 'Restore'}
          </button>

          <input
            ref={backupInput}
            type="file"
            accept="application/json,.json"
            hidden
            onChange={async (e) => {
              const file = e.target.files?.[0]
              e.target.value = ''
              if (!file) return
              setBackupBusy('import'); setBackupError(null); setBackupNote(null)
              try {
                const backup = parseBackup(await file.text())
                // Read the file, work out what it would destroy, and ask. The
                // restore itself does not start until the dialog is answered.
                setPending({ backup, preview: await previewRestore(backup) })
              } catch (err) {
                setBackupError(err instanceof Error ? err.message : 'Could not restore.')
              } finally { setBackupBusy(null) }
            }}
          />
        </div>

        {/* Said plainly, because "restored" on its own does not tell you
            whether the file had anything in it. */}
        {backupNote && <p className="muted" style={{ fontSize: 12.5, marginTop: 10 }}>{backupNote}</p>}
        {backupError && <p style={{ fontSize: 12.5, marginTop: 10, color: 'var(--danger)' }}>{backupError}</p>}

        <p className="faint" style={{ fontSize: 11.5, marginTop: 10 }}>
          A backup is a snapshot. Restoring one puts this install back as it was
          when the file was made — decks not in the file are deleted, and your
          collected cards are replaced. You are asked to confirm first.
        </p>
      </div>

      {/* Named for what it destroys rather than for what it does. "Restore
          this backup?" is a question anyone says yes to; "three decks will be
          deleted" is the part worth reading. */}
      {pending && (
        <div className="modal-backdrop" onClick={() => setPending(null)} role="presentation">
          <div
            className="modal"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal
            aria-labelledby="restore-title"
          >
            <h3 id="restore-title">Restore this snapshot?</h3>
            <p className="muted" style={{ fontSize: 13 }}>
              This puts the app back as it was on{' '}
              {pending.backup.exported_at?.slice(0, 10) || 'the day the file was made'}.
            </p>
            <ul className="muted" style={{ fontSize: 13, paddingLeft: 18, margin: '10px 0' }}>
              {pending.preview.arriving > 0 && (
                <li>{pending.preview.arriving} deck
                  {pending.preview.arriving === 1 ? '' : 's'} added</li>
              )}
              {pending.preview.overwriting > 0 && (
                <li>{pending.preview.overwriting} overwritten</li>
              )}
              <li style={{ color: pending.preview.losing.length ? 'var(--danger)' : undefined }}>
                {pending.preview.losing.length
                  ? `${pending.preview.losing.length} deleted: ${
                      pending.preview.losing.slice(0, 6).join(', ')}${
                      pending.preview.losing.length > 6 ? '…' : ''}`
                  : 'Nothing will be deleted'}
              </li>
              <li>Your collected cards are replaced by the file&rsquo;s</li>
            </ul>
            <div className="row gap-2" style={{ justifyContent: 'flex-end' }}>
              <button className="btn btn-ghost sm" onClick={() => setPending(null)}>Cancel</button>
              <button
                className="btn btn-danger sm"
                onClick={async () => {
                  const { backup } = pending
                  setPending(null)
                  setBackupBusy('import'); setBackupError(null); setBackupNote(null)
                  try {
                    setBackupNote(said(await restore(backup)))
                  } catch (err) {
                    setBackupError(err instanceof Error ? err.message : 'Could not restore.')
                  } finally { setBackupBusy(null) }
                }}
              >
                Restore
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="panel settings-panel" data-tour="tabletop">
        <h3>Tabletop</h3>
        <p className="muted" style={{ fontSize: 13, marginBottom: 14 }}>
          What the dice and the coin are made of. Nothing is downloaded — both are
          drawn in CSS, so a finish is only a change of color.
        </p>

        <div className="skin-layout">
        <div className="skin-choices">
        <div className="skin-group">
          <span className="label">Dice</span>
          <div className="skin-row">
            {DICE_SKINS.map((s) => (
              <button
                key={s.id}
                className={`skin${dieSkin === s.id ? ' on' : ''}`}
                style={s.vars as React.CSSProperties}
                title={s.label}
                aria-pressed={dieSkin === s.id}
                onClick={() => { setDieSkin(s.id); writeDieSkin(s.id) }}
              >
                <span className="skin-die" aria-hidden>
                  <i /><i /><i />
                </span>
                <span className="skin-name">{s.label}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="skin-group">
          <span className="label">D20</span>
          <div className="skin-row">
            {DICE_SKINS.map((s) => (
              <button
                key={s.id}
                className={`skin${d20Skin === s.id ? ' on' : ''}`}
                style={Object.fromEntries(
                  Object.entries(s.vars).map(([k, v]) => [k, v]),
                ) as React.CSSProperties}
                title={s.label}
                aria-pressed={d20Skin === s.id}
                onClick={() => { setD20Skin(s.id); writeD20Skin(s.id) }}
              >
                <span className="skin-d20" aria-hidden>
                  <svg viewBox="0 0 100 100">
                    <polygon className="hull" points="50,4 89.8,27 89.8,73 50,96 10.2,73 10.2,27" />
                    <polygon className="face" points="50,26 73,66 27,66" />
                  </svg>
                </span>
                <span className="skin-name">{s.label}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="skin-group">
          <span className="label">Coin</span>
          <div className="skin-row">
            {COIN_SKINS.map((s) => (
              <button
                key={s.id}
                className={`skin${coinSkin === s.id ? ' on' : ''}`}
                style={s.vars as React.CSSProperties}
                title={s.label}
                aria-pressed={coinSkin === s.id}
                onClick={() => { setCoinSkin(s.id); writeCoinSkin(s.id) }}
              >
                <span className="skin-coin" aria-hidden />
                <span className="skin-name">{s.label}</span>
              </button>
            ))}
          </div>
        </div>

        </div>

        {/* The real objects, beside the swatches rather than under them: a
            finish is judged on a die that turns, and the comparison only works
            if the choice and the thing it changes are in view at once. */}
        <div className="skin-preview" style={skinVars(dieSkin, d20Skin, coinSkin)}>
          <SkinStage />
        </div>
        </div>
      </div>

      <div className="panel settings-panel" data-tour="local-model">
        <h3>Local model</h3>
        <p className="muted" style={{ fontSize: 13, marginBottom: 14 }}>
          Five sizes of the same job. Larger models read an awkward sentence more
          faithfully; the number beside each is roughly the video memory it needs to stay
          on the card. Below that it still runs, but spills into system RAM and slows to
          minutes per search.
        </p>

        <label className="stack gap-1" style={{ maxWidth: 460 }}>
          <span className="label">Model</span>
          <select
            className="fld"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            aria-label="Local model"
          >
            {/* A model set by hand in .env is honoured, so it is shown rather
                than silently replaced by whichever tier happens to be first. */}
            {isCustom && saved && <option value={saved}>{saved} — set in configuration</option>}
            {tiers.map((tier) => (
              <option key={tier.id} value={tier.id}>
                {tier.label} · {tier.vram_gb}GB · {tier.id}
              </option>
            ))}
          </select>
        </label>

        {chosen && (
          <p className="muted settings-note">{chosen.note}</p>
        )}

        {missing && (
          <p className="settings-warn mono">
            Not installed. Run <code>ollama pull {draft}</code> before using it.
          </p>
        )}

        <dl className="settings-facts">
          <div>
            <dt className="label">Saved</dt>
            <dd className="mono">{saved ?? '—'}</dd>
          </div>
          <div>
            <dt className="label">Default</dt>
            <dd className="mono faint">{defaultModel || '—'}</dd>
          </div>
        </dl>
      </div>
    </section>
  )
}
