/** The accent colour, and the four colours derived from it.
 *
 * The interface was built around one blue, `#8fa9ff` — the Search button, the
 * tab underline, the focus ring — with four relatives doing the other jobs.
 * Measured against that base, every one of them sits within two degrees of hue
 * 226 and differs only in how saturated and how light it is:
 *
 *     role                          Δhue   S × base    ΔL
 *     aether      base              —      1.00        —
 *     aether-hi   hover, links      −0.5   1.00       +7.3
 *     aether-deep ambient blobs     +1.2   0.75      −13.9
 *     chrome      glass, hairlines  −1.9   0.36       −8.8
 *     aether-ink  text on accent    −1.1   0.50      −70.2
 *
 * Those hue deltas are rounding noise in a 6-digit hex, not intent, so the
 * transform treats the family as a single hue. That is what makes a new accent
 * a matter of picking one colour rather than five: change the base and the
 * other four move with it, keeping the relationships the design was drawn
 * with.
 *
 * `--chrome` is the one worth noticing. It is the blue-grey the whole
 * structure is made of — every panel fill, hairline and divider is that colour
 * at some alpha — so it travels with the accent too. Without it a new accent
 * would sit inside a blue-grey frame that no longer matched it.
 */

export const DEFAULT_ACCENT = '#8fa9ff'

const STORE_KEY = 'insight-engine:accent'

/** Saturation multiplier and lightness offset, measured from the base. */
const FAMILY: { name: string; sat: number; light: number }[] = [
  { name: '--aether-hi', sat: 1, light: 7.3 },
  { name: '--aether-deep', sat: 0.749, light: -13.9 },
  { name: '--chrome', sat: 0.363, light: -8.8 },
]

/** How far the ink sits from the accent it is printed on. */
const INK_GAP = 70.2

export interface Hsl { h: number; s: number; l: number }
export interface Hsv { h: number; s: number; v: number }

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n))

export function hexToHsl(hex: string): Hsl {
  const clean = hex.replace('#', '')
  const full = clean.length === 3 ? clean.split('').map((c) => c + c).join('') : clean
  const r = parseInt(full.slice(0, 2), 16) / 255
  const g = parseInt(full.slice(2, 4), 16) / 255
  const b = parseInt(full.slice(4, 6), 16) / 255

  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  if (max === min) return { h: 0, s: 0, l: l * 100 }

  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  let h: number
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6
  else if (max === g) h = ((b - r) / d + 2) / 6
  else h = ((r - g) / d + 4) / 6
  return { h: h * 360, s: s * 100, l: l * 100 }
}

export function hslToHex({ h, s, l }: Hsl): string {
  const sat = clamp(s, 0, 100) / 100
  const light = clamp(l, 0, 100) / 100
  const c = (1 - Math.abs(2 * light - 1)) * sat
  const hp = (((h % 360) + 360) % 360) / 60
  const x = c * (1 - Math.abs((hp % 2) - 1))
  const [r1, g1, b1] =
    hp < 1 ? [c, x, 0] : hp < 2 ? [x, c, 0] : hp < 3 ? [0, c, x]
      : hp < 4 ? [0, x, c] : hp < 5 ? [x, 0, c] : [c, 0, x]
  const m = light - c / 2
  const hex = (v: number) =>
    Math.round(clamp((v + m) * 255, 0, 255)).toString(16).padStart(2, '0')
  return `#${hex(r1)}${hex(g1)}${hex(b1)}`
}

/* HSL is the right space for the transform — the family differs by saturation
 * and lightness, which is exactly what HSL names — but HSV is what colour
 * pickers speak, so the settings sliders work in HSV and convert here. */
export function hslToHsv({ h, s, l }: Hsl): Hsv {
  const sl = s / 100
  const ll = l / 100
  const v = ll + sl * Math.min(ll, 1 - ll)
  return { h, s: (v === 0 ? 0 : 2 * (1 - ll / v)) * 100, v: v * 100 }
}

export function hsvToHsl({ h, s, v }: Hsv): Hsl {
  const sv = s / 100
  const vv = v / 100
  const l = vv * (1 - sv / 2)
  const denom = Math.min(l, 1 - l)
  return { h, s: (denom === 0 ? 0 : (vv - l) / denom) * 100, l: l * 100 }
}

export function isHex(value: string): boolean {
  return /^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(value.trim())
}

export function normalizeHex(value: string): string {
  const clean = value.trim().replace('#', '')
  const full = clean.length === 3 ? clean.split('').map((c) => c + c).join('') : clean
  return `#${full.toLowerCase()}`
}

/** The whole family, derived from one colour. */
export function deriveAccent(baseHex: string): Record<string, string> {
  const base = hexToHsl(baseHex)
  const out: Record<string, string> = { '--aether': normalizeHex(baseHex) }

  for (const { name, sat, light } of FAMILY) {
    out[name] = hslToHex({
      h: base.h,
      s: clamp(base.s * sat, 0, 100),
      l: clamp(base.l + light, 0, 100),
    })
  }

  /* The ink is the one member that cannot be a fixed offset.
   *
   * Measured, it is 70 points darker than the accent, which is right for a
   * base as light as the original. Applied blindly to a dark accent it clamps
   * at black and prints black on near-black. So the distance is kept and the
   * direction is chosen: away from the accent, whichever way there is room. */
  const darkInk = base.l >= 50
  out['--aether-ink'] = hslToHex({
    h: base.h,
    s: clamp(base.s * 0.5, 0, 100),
    l: clamp(base.l + (darkInk ? -INK_GAP : INK_GAP), 4, 96),
  })

  return out
}

/** Apply a saved accent, if there is one.
 *
 * Deliberately does nothing when the stored colour is the default: the
 * stylesheet's own values are the design, and re-deriving them would replace
 * two of the five with values a couple of steps off — the transform treats the
 * family as one hue, and the originals carry a degree or two of drift.
 */
export function applyStoredAccent(): void {
  const stored = readAccent()
  if (stored !== DEFAULT_ACCENT) applyAccent(stored)
}

export function applyAccent(baseHex: string): void {
  const root = document.documentElement
  for (const [name, value] of Object.entries(deriveAccent(baseHex))) {
    root.style.setProperty(name, value)
  }
}

export function readAccent(): string {
  try {
    const stored = localStorage.getItem(STORE_KEY)
    return stored && isHex(stored) ? normalizeHex(stored) : DEFAULT_ACCENT
  } catch {
    return DEFAULT_ACCENT
  }
}

export function saveAccent(baseHex: string): void {
  try {
    localStorage.setItem(STORE_KEY, normalizeHex(baseHex))
  } catch { /* a private window still gets the colour, just not next time */ }
}

/** Back to the palette the app was designed in. */
export function resetAccent(): void {
  try {
    localStorage.removeItem(STORE_KEY)
  } catch { /* nothing to forget */ }
  // Cleared rather than set to the default: with no inline override the
  // stylesheet's own values apply, which is what "reset" should mean.
  const root = document.documentElement
  for (const name of Object.keys(deriveAccent(DEFAULT_ACCENT))) {
    root.style.removeProperty(name)
  }
}
