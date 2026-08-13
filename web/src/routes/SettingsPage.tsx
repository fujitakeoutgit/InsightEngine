import { useEffect, useState } from 'react'

import { api, type ModelTier } from '../lib/api'
import { riseIn } from '../lib/motion'
import {
  COIN_SKINS, DICE_SKINS, readCoinSkin, readDieSkin, writeCoinSkin, writeDieSkin,
} from '../lib/skins'
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
  const [coinSkin, setCoinSkin] = useState(readCoinSkin)
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
        <h3>Table</h3>
        <p className="muted" style={{ fontSize: 13, marginBottom: 14 }}>
          What the dice and the coin are made of. Nothing is downloaded — both are
          drawn in CSS, so a finish is only a change of colour.
        </p>

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
