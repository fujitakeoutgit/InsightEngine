import { useRef, useState } from 'react'

import { makeDie, type DieState } from '../lib/playtestCache'
import { PlayCoin, type CoinFace } from './PlayCoin'
import { PlayDie } from './PlayDie'

/**
 * A working table, in Settings.
 *
 * The real dice and the real coin, not pictures of them: swatches can show a
 * color, but they cannot show what a die looks like turning over, which is
 * most of what choosing a finish is about. Throw them, flip the coin, and the
 * choice is made against the thing itself.
 *
 * Two differences from the playtest mat, both deliberate. Nothing spawns —
 * this is a place to look at dice, not a supply to draw from, and a fresh die
 * appearing every time you threw one would be clutter with no purpose here.
 * And because nothing spawns, a die thrown into a corner has to be
 * retrievable: each slot is a button that calls its own die home.
 */
export function SkinStage() {
  const matRef = useRef<HTMLDivElement>(null)
  const trays = {
    d20: useRef<HTMLButtonElement>(null),
    d6: useRef<HTMLButtonElement>(null),
  }
  const [dice, setDice] = useState<DieState[]>(() => [makeDie('d20'), makeDie('d6')])
  const [coin, setCoin] = useState<CoinFace>('heads')


  /** No replacement, no putting away: the only state a die has here is where
   *  it is and what it shows. */
  const update = (id: string, next: Partial<DieState>, backInTray = false) =>
    setDice((current) => current.map((d) => {
      if (d.id !== id) return d
      /* A die that has been moved is no longer at home, and has to say so:
       * `PlayDie` places a home die from its tray's measured box and ignores
       * its coordinates entirely, so leaving the flag set would snap it back
       * to the slot the moment anything re-rendered. Dropping it on its own
       * slot puts it home again, which is also how the recall button reads. */
      const moved = next.x !== undefined || next.y !== undefined
      return { ...d, ...next, home: backInTray || (d.home && !moved) }
    }))

  /** Send a die back to its slot. `home` is what `PlayDie` reads to place
   *  itself from the tray's measured box, so setting it is the whole recall. */
  const recall = (kind: 'd20' | 'd6') =>
    setDice((current) => current.map((d) => (d.kind === kind ? { ...d, home: true } : d)))

  const away = (kind: 'd20' | 'd6') => dice.some((d) => d.kind === kind && !d.home)

  return (
    /* Deliberately not `.playtest`. That class is the full-screen table --
       `position: fixed; inset: 0; z-index: 60` over an opaque background --
       so borrowing it here covered the whole Settings page and left only the
       dice visible. Nothing the dice or coin need is scoped under it: their
       rules hang off `.pt-die` and `.pt-coin` directly. */
    <div className="skin-stage">
      <div className="skin-mat pt-mat" ref={matRef}>
        {/* In the middle of the mat rather than captioned underneath it. The
            table says what it is for; a running commentary of what the dice
            just did says nothing you cannot see on the die. */}
        <span className="skin-stage-hint" aria-hidden>Throw a die, or flip the coin</span>
        <div className="pt-tools">
          {(['d20', 'd6'] as const).map((kind) => (
            <button
              key={kind}
              className={`pt-die-tray ${kind} recall${away(kind) ? ' armed' : ''}`}
              ref={trays[kind]}
              onClick={() => recall(kind)}
              disabled={!away(kind)}
              title={`Call the ${kind} back to its slot`}
              aria-label={`Call the ${kind} back to its slot`}
            />
          ))}
          <PlayCoin
            face={coin}
            onFlip={setCoin}
          />
        </div>

        {dice.map((d) => (
          <PlayDie
            key={d.id}
            die={d}
            matRef={matRef}
            trayRef={trays[d.kind]}
            onChange={(next, backInTray) => update(d.id, next, backInTray)}
          />
        ))}
      </div>
    </div>
  )
}
