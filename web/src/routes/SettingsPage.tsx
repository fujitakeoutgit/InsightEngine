import { useEffect, useRef, useState } from 'react'

import { api, type ModelTier, type SyncStatus } from '../lib/api'
import { riseIn } from '../lib/motion'
import {
  COIN_SKINS, DICE_SKINS, readCoinSkin, readD20Skin, readDieSkin,
  skinVars, writeCoinSkin, writeD20Skin, writeDieSkin,
} from '../lib/skins'
import { SkinStage } from '../components/SkinStage'
import {
  download, exportAll, parseBackup, restore, type RestoreReport,
} from '../lib/backup'
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
export function SettingsPage() {
  const [dieSkin, setDieSkin] = useState(readDieSkin)
  const [d20Skin, setD20Skin] = useState(readD20Skin)
  const [coinSkin, setCoinSkin] = useState(readCoinSkin)
  const [sync, setSync] = useState<SyncStatus | null>(null)
  const [syncBusy, setSyncBusy] = useState<'check' | 'refresh' | null>(null)
  const [syncLog, setSyncLog] = useState<string[]>([])

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
        if (!p.running) {
          setSyncBusy(null)
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

  const said = (r: RestoreReport) => {
    const bits = [
      r.created && `${r.created} deck${r.created === 1 ? '' : 's'} added`,
      r.updated && `${r.updated} updated`,
      r.sleeves && `${r.sleeves} sleeved`,
      r.collected && `${r.collected} card${r.collected === 1 ? '' : 's'} collected`,
    ].filter(Boolean)
    const done = bits.length ? bits.join(', ') : 'nothing new to add'
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
            disabled={!!syncBusy || !!sync?.running}
            onClick={async () => {
              setSyncBusy('refresh'); setSyncLog([])
              try { await api.syncRefresh() } catch { setSyncBusy(null) }
            }}
          >
            {syncBusy === 'refresh' || sync?.running ? 'Updating…' : 'Update Card Pool'}
          </button>
        </div>

        {(syncBusy === 'refresh' || sync?.running) && (
          <p className="faint" style={{ fontSize: 11.5, marginTop: 10 }}>
            A few hundred megabytes, and several minutes. Searching keeps working until
            the new data is written.
          </p>
        )}

        {syncLog.length > 0 && (
          <pre className="sync-log mono">{syncLog.join('\n')}</pre>
        )}

        {sync?.error && (
          <p style={{ fontSize: 12.5, marginTop: 10, color: 'var(--danger)' }}>{sync.error}</p>
        )}
      </div>

      <div className="panel settings-panel">
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
                setBackupNote(said(await restore(backup)))
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
          Restoring merges: a deck whose name is already here is updated, anything
          else is added, and nothing is deleted.
        </p>
      </div>

      <div className="panel settings-panel">
        <h3>Table</h3>
        <p className="muted" style={{ fontSize: 13, marginBottom: 14 }}>
          What the dice and the coin are made of. Nothing is downloaded — both are
          drawn in CSS, so a finish is only a change of colour.
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

      <div className="panel settings-panel">
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
