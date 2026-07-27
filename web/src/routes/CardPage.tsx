import { useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'

import { api, type CardDetail } from '../lib/api'
import { collection, useIsCollected } from '../lib/collection'
import { attachTilt, riseIn } from '../lib/motion'
import { Lightbox } from '../components/Lightbox'
import { BackLink } from '../components/PageHead'
import { IdentityDots, ManaCost, OracleText } from '../components/ManaCost'

const FORMAT_ORDER = [
  'standard', 'pioneer', 'modern', 'legacy', 'vintage', 'commander', 'pauper',
  'brawl', 'historic', 'timeless', 'alchemy', 'explorer', 'duel', 'oathbreaker',
  'penny', 'predh', 'premodern', 'oldschool', 'future', 'gladiator', 'standardbrawl',
]

function money(value: string | null | undefined, prefix = '$') {
  return value ? `${prefix}${value}` : '—'
}

export function CardPage() {
  const { oracleId } = useParams()

  const [detail, setDetail] = useState<CardDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const artRef = useRef<HTMLDivElement>(null)
  const held = useIsCollected(oracleId ?? '')
  const [zoomed, setZoomed] = useState<DOMRect | null>(null)
  const [isZoomed, setIsZoomed] = useState(false)

  useEffect(() => {
    if (!oracleId) return
    setDetail(null)
    setError(null)
    window.scrollTo(0, 0)
    api
      .card(oracleId)
      .then(setDetail)
      .catch((err) => setError(err instanceof Error ? err.message : 'Could not load card'))
  }, [oracleId])

  useEffect(() => {
    if (detail) riseIn(bodyRef.current)
  }, [detail])

  // Attached after the art renders, and torn down on card change.
  useEffect(() => {
    if (!detail || !artRef.current) return
    return attachTilt(artRef.current, 5)
  }, [detail])

  if (error) {
    return (
      <section className="shell" style={{ paddingTop: 'var(--gap-5)' }}>
        <div className="notice error">
          <h3>Card unavailable</h3>
          <p>{error}</p>
          <Link to="/" className="btn" style={{ marginTop: 'var(--gap-3)' }}>
            Back to search
          </Link>
        </div>
      </section>
    )
  }

  if (!detail) {
    return (
      <section className="shell" style={{ paddingTop: 'var(--gap-5)' }}>
        <div className="row gap-2 muted">
          <span className="spinner" /> Loading card…
        </div>
      </section>
    )
  }

  const { card, rulings, printings, tags, vendors } = detail
  const faces = card.card_faces ?? []
  const legalities = card.legalities ?? {}
  const prices = card.prices ?? {}

  return (
    <>
      {/* Collect sits beside Back rather than under the art: both are actions
          about the card as a whole, and the art column is for the art. */}
      <div className="shell row gap-3 wrap" style={{ paddingTop: 4 }}>
        <BackLink label="Back to results" />
        <button
          className={held ? 'btn btn-primary sm' : 'btn sm'}
          onClick={() => collection.toggle(card)}
        >
          {held ? '✓ In Cards' : '+ Add to Cards'}
        </button>
      </div>
      <section className="shell detail" ref={bodyRef}>
      <div className="detail-art">
        {card.image_normal ? (
          <div
            className="detail-tilt"
            ref={artRef}
            onClick={() => { setZoomed(artRef.current?.getBoundingClientRect() ?? null); setIsZoomed(true) }}
            title="Click to enlarge"
          >
            <img src={card.image_normal} alt={card.name} />
          </div>
        ) : (
          <div className="panel">No image available.</div>
        )}
        {vendors.tcgplayer && (
          <a
            className="btn"
            style={{ marginTop: 10, width: '100%' }}
            href={vendors.tcgplayer}
            target="_blank"
            rel="noreferrer noopener"
          >
            Search TCGplayer
            {card.usd !== null && <span className="faint"> · ${card.usd.toFixed(2)}</span>}
          </a>
        )}
        <div className="row wrap gap-2" style={{ marginTop: 8 }}>
          {vendors.cardmarket && (
            <a className="btn btn-ghost sm" href={vendors.cardmarket} target="_blank" rel="noreferrer noopener">
              Cardmarket
            </a>
          )}
          {vendors.cardhoarder && (
            <a className="btn btn-ghost sm" href={vendors.cardhoarder} target="_blank" rel="noreferrer noopener">
              Cardhoarder
            </a>
          )}
          {card.scryfall_uri && (
            <a className="btn btn-ghost sm" href={card.scryfall_uri} target="_blank" rel="noreferrer noopener">
              Scryfall
            </a>
          )}
        </div>
      </div>

      <div className="stack gap-4">
        <div>
          <div className="row gap-2 wrap" style={{ marginBottom: 'var(--gap-1)' }}>
            <IdentityDots identity={card.color_identity} />
            <span className="label">{card.set_name}</span>
            {card.reserved && <span className="chip">Reserved List</span>}
            {card.game_changer && <span className="chip on">Game Changer</span>}
          </div>
          <h1>{card.name}</h1>
          <div className="row gap-3 wrap">
            <ManaCost cost={card.mana_cost} />
            {card.cmc !== null && <span className="mono faint">MV {card.cmc}</span>}
            {card.edhrec_rank && <span className="mono faint">EDHREC #{card.edhrec_rank}</span>}
          </div>
          {/* Every part of the type line is a query: supertypes, card types
              and creature types alike. They were previously plain text while
              keywords beside them were clickable, which is arbitrary. */}
          <div className="type-links" style={{ marginTop: 10 }}>
            {(card.type_line ?? '').split(/\s*(—|\/\/)\s*/).map((chunk, i) =>
              chunk === '—' || chunk === '//' ? (
                <span className="sep" key={`s${i}`}>{chunk}</span>
              ) : (
                chunk.split(/\s+/).filter(Boolean).map((word) => (
                  <Link
                    key={`${i}-${word}`}
                    to={`/?q=${encodeURIComponent(`t:${word.toLowerCase()}`)}`}
                    className="meta-link"
                    title={`Search for ${word}`}
                  >
                    {word}
                  </Link>
                ))
              ),
            )}
            {card.set_code && (
              <Link
                to={`/?q=${encodeURIComponent(`s:${card.set_code}`)}`}
                className="meta-link set"
                title={`Browse ${card.set_name}`}
              >
                {card.set_code.toUpperCase()} · {card.set_name}
              </Link>
            )}
          </div>
        </div>

        {faces.length > 0 ? (
          <div className="stack gap-3">
            {faces.map((face, i) => (
              <div className="panel" key={i}>
                <h3>{face.name}</h3>
                <div className="row gap-2 wrap" style={{ marginBottom: 'var(--gap-2)' }}>
                  <ManaCost cost={face.mana_cost} />
                  <span className="muted">{face.type_line}</span>
                </div>
                <div className="oracle">
                  <OracleText text={face.oracle_text} />
                </div>
                {face.power && (
                  <span className="pt-badge mono" style={{ marginTop: 'var(--gap-2)', display: 'inline-block' }}>
                    {face.power}/{face.toughness}
                  </span>
                )}
              </div>
            ))}
          </div>
        ) : (
          <div className="oracle">
            <OracleText text={card.oracle_text} />
          </div>
        )}

        <div className="row gap-3 wrap">
          {card.power !== null && (
            <span className="pt-badge mono">
              {card.power}/{card.toughness}
            </span>
          )}
          {card.loyalty !== null && <span className="pt-badge mono">Loyalty {card.loyalty}</span>}
          {(card.keywords ?? []).map((kw) => (
            <Link key={kw} to={`/?q=${encodeURIComponent(`kw:${kw}`)}`} className="chip">
              {kw}
            </Link>
          ))}
        </div>

        <div className="panel">
          <h3>Prices</h3>
          <div className="prices">
            <div className="price-cell">
              <span className="v mono">{money(prices.usd)}</span>
              <span className="label">USD</span>
            </div>
            <div className="price-cell">
              <span className="v mono">{money(prices.usd_foil)}</span>
              <span className="label">USD foil</span>
            </div>
            <div className="price-cell">
              <span className="v mono">{money(prices.eur, '€')}</span>
              <span className="label">EUR</span>
            </div>
            <div className="price-cell">
              <span className="v mono">{money(prices.tix, '')}</span>
              <span className="label">MTGO tix</span>
            </div>
          </div>
        </div>

        <div className="panel">
          <h3>Format legality</h3>
          <div className="legality">
            {FORMAT_ORDER.filter((f) => f in legalities).map((format) => (
              <div key={format}>
                <span style={{ textTransform: 'capitalize' }}>{format}</span>
                <span className={`st ${legalities[format]}`}>
                  {legalities[format].replace('_', ' ')}
                </span>
              </div>
            ))}
          </div>
        </div>

        {tags.length > 0 && (
          <div className="panel">
            <h3>Oracle tags — how the semantic engine understands this card</h3>
            <div className="row wrap gap-1">
              {tags.map((tag) => (
                <Link key={tag} to={`/?q=${encodeURIComponent(`otag:${tag}`)}`} className="chip">
                  {tag}
                </Link>
              ))}
            </div>
          </div>
        )}

        {rulings.length > 0 && (
          <div className="panel">
            <h3>Rulings ({rulings.length})</h3>
            {rulings.map((ruling, i) => (
              <div className="ruling" key={i}>
                <time>{ruling.published_at}</time>
                <div>{ruling.comment}</div>
              </div>
            ))}
          </div>
        )}

        {printings.length > 0 && (
          <div className="panel">
            <h3>Printings ({printings.length})</h3>
            <div className="printings scroll-x">
              <table className="card-list">
                <thead>
                  <tr>
                    <th>Set</th>
                    <th>№</th>
                    <th>Rarity</th>
                    <th>Released</th>
                    <th style={{ textAlign: 'right' }}>USD</th>
                    <th style={{ textAlign: 'right' }}>EUR</th>
                  </tr>
                </thead>
                <tbody>
                  {printings.map((print) => (
                    <tr key={print.scryfall_id ?? `${print.set_code}-${print.collector_number}`}>
                      <td>
                        <span className="mono faint">{print.set_code?.toUpperCase()}</span>{' '}
                        {print.set_name}
                      </td>
                      <td className="mono faint">{print.collector_number}</td>
                      <td style={{ textTransform: 'capitalize' }} className="muted">
                        {print.rarity}
                      </td>
                      <td className="mono faint">{print.released_at}</td>
                      <td className="num">{money(print.prices?.usd)}</td>
                      <td className="num">{money(print.prices?.eur, '€')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        <p className="faint" style={{ fontSize: 13 }}>
          Artist: {card.artist ?? 'Unknown'} · Card data from Scryfall.
        </p>
      </div>
    </section>

    {isZoomed && card.image_normal && (
      <Lightbox
        src={card.image_normal}
        alt={card.name}
        from={zoomed}
        onClose={() => setIsZoomed(false)}
      />
    )}
    </>
  )
}
