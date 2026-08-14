import { useEffect, useState } from 'react'

import { api, type Card } from '../lib/api'
import { useEscape } from '../lib/usePersisted'

/**
 * Every edition of one card, to pick from.
 *
 * Full-screen and dark because a printing is chosen by *looking* — the whole
 * point is the art and the frame, and a dropdown of set codes would be the
 * same choice made blind. The set name sits under each, since that is what
 * people say out loud even when the list stores the code.
 *
 * The printings come from Scryfall live, not from the local mirror. The mirror
 * is built from `oracle_cards`, which holds exactly one row per card — the
 * other editions are simply not in it. That is also why choosing one is not
 * yet durable: see the note where the choice is applied.
 */
export function PrintingPicker({
  card, onPick, onClose,
}: {
  card: Card
  onPick: (printing: Card) => void
  onClose: () => void
}) {
  const [printings, setPrintings] = useState<Card[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEscape(onClose)

  useEffect(() => {
    let cancelled = false
    api.printings(card.oracle_id)
      .then((r) => { if (!cancelled) setPrintings(r.printings) })
      .catch(() => { if (!cancelled) setError('Could not reach Scryfall for the other printings.') })
    return () => { cancelled = true }
  }, [card.oracle_id])

  return (
    <div className="printings-backdrop" onClick={onClose} role="presentation">
      <div
        className="printings"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal
        aria-label={`Printings of ${card.name}`}
      >
        <div className="printings-head">
          <span className="label">Printing</span>
          <h3>{card.name}</h3>
          {printings && <span className="mono faint">{printings.length} editions</span>}
        </div>

        {error && <p className="printings-error">{error}</p>}
        {!printings && !error && <p className="faint">Looking…</p>}

        {printings && (
          <div className="printings-grid">
            {printings.map((p) => {
              const chosen = p.set_code === card.set_code
                && p.collector_number === card.collector_number
              return (
                <button
                  key={`${p.set_code}-${p.collector_number}`}
                  className={`printing${chosen ? ' on' : ''}`}
                  onClick={() => { onPick(p); onClose() }}
                  title={`${p.set_name ?? p.set_code} — ${p.collector_number}`}
                >
                  {p.image_normal
                    ? <img src={p.image_normal} alt="" loading="lazy" draggable={false} />
                    : <span className="printing-blank">{p.set_code?.toUpperCase()}</span>}
                  <span className="printing-set">{p.set_name ?? p.set_code}</span>
                  <span className="printing-num mono faint">
                    {p.set_code?.toUpperCase()} {p.collector_number}
                  </span>
                </button>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
