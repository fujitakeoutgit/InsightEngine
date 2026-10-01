/**
 * Randomness the game can replay.
 *
 * The engine is a pure function of its state and the action applied to it, so
 * a shuffle cannot reach for `Math.random`: the same game would deal two
 * different libraries depending on when you asked. The generator's state lives
 * in the game instead, and every shuffle hands back the seed to use next.
 *
 * That is also what lets undo work. Restoring an earlier state restores the
 * seed with it, so whatever happens next happens exactly as it would have.
 */

/** mulberry32 — a 32-bit seed in, a float in [0, 1) and the next seed out.
 *  Small and fast, and plenty for a card shuffle; it is not cryptography. */
export function next(seed: number): [number, number] {
  const advanced = (seed + 0x6d2b79f5) >>> 0
  let t = advanced
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  return [((t ^ (t >>> 14)) >>> 0) / 4294967296, advanced]
}

/** Fisher-Yates. A biased shuffle would quietly invalidate every draw.
 *  Returns the shuffled copy and the seed to continue from. */
export function shuffle<T>(items: readonly T[], seed: number): [T[], number] {
  const out = [...items]
  let state = seed
  for (let i = out.length - 1; i > 0; i -= 1) {
    const [roll, after] = next(state)
    state = after
    const j = Math.floor(roll * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return [out, state]
}

/** Where a new game's randomness starts. The one impure call, made by the
 *  table when it deals, never by the engine. */
export function randomSeed(): number {
  return Math.floor(Math.random() * 2 ** 32) >>> 0
}
