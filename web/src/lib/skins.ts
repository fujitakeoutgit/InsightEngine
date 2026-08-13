/**
 * Dice and coin skins.
 *
 * Each skin is a handful of custom properties, not a stylesheet or an asset.
 * The dice and the coin are already drawn entirely in CSS — six gradient faces
 * and a struck disc — so a skin only has to say which colours those rules
 * reach for. Nothing new is rendered, nothing is downloaded, and a skin that
 * is never chosen costs nothing.
 *
 * The defaults are the values the rules were written with, so "Default" is
 * genuinely the original object rather than a skin that happens to resemble it.
 */

export interface Skin {
  id: string
  label: string
  vars: Record<string, string>
}

/** Faces, edge and pips. `--die-face` is an optional overlay painted on top of
 *  the gradient, which is how the patterned skins get their texture without a
 *  second element to hang it on. */
export const DICE_SKINS: Skin[] = [
  {
    id: 'bone',
    label: 'Bone',
    vars: { '--die-hi': '#efe6d2', '--die-lo': '#cdbfa2', '--die-edge': '#a9997a', '--die-pip': '#2b2519' },
  },
  {
    id: 'obsidian',
    label: 'Obsidian',
    vars: { '--die-hi': '#2c3040', '--die-lo': '#12141c', '--die-edge': '#454b60', '--die-pip': '#e8ecff' },
  },
  {
    id: 'ruby',
    label: 'Ruby',
    vars: { '--die-hi': '#a3283c', '--die-lo': '#4d0f1c', '--die-edge': '#d4536b', '--die-pip': '#ffe3e8' },
  },
  {
    id: 'jade',
    label: 'Jade',
    vars: { '--die-hi': '#2f7a5c', '--die-lo': '#123528', '--die-edge': '#4fb589', '--die-pip': '#eafff5' },
  },
  {
    id: 'sapphire',
    label: 'Sapphire',
    vars: { '--die-hi': '#2a4d9b', '--die-lo': '#101f45', '--die-edge': '#5b82d8', '--die-pip': '#e6edff' },
  },
  {
    id: 'amethyst',
    label: 'Amethyst',
    vars: { '--die-hi': '#6b3f9e', '--die-lo': '#2c1748', '--die-edge': '#a276d6', '--die-pip': '#f3e9ff' },
  },
  {
    id: 'marble',
    label: 'Marble',
    vars: {
      '--die-hi': '#f2f3f6', '--die-lo': '#c9cdd8', '--die-edge': '#9aa0b0', '--die-pip': '#22252e',
      '--die-face': 'linear-gradient(118deg, transparent 0 42%, rgba(90,100,125,0.22) 42% 46%, transparent 46% 63%, rgba(90,100,125,0.14) 63% 65%, transparent 65%)',
    },
  },
  {
    id: 'speckled',
    label: 'Speckled',
    vars: {
      '--die-hi': '#3b4256', '--die-lo': '#1b1f2b', '--die-edge': '#5a6379', '--die-pip': '#ffd76e',
      '--die-face': 'radial-gradient(circle at 22% 28%, rgba(255,215,110,0.5) 0 1.2px, transparent 1.3px), radial-gradient(circle at 68% 61%, rgba(255,215,110,0.4) 0 1px, transparent 1.1px), radial-gradient(circle at 44% 79%, rgba(255,255,255,0.3) 0 1px, transparent 1.1px)',
    },
  },
]

/** The coin is one struck disc, so a finish is four stops, a rim and the ink
 *  stamped into it. The reverse is derived from these rather than given its
 *  own set — it is the same metal, struck a shade deeper. */
export const COIN_SKINS: Skin[] = [
  {
    id: 'gold',
    label: 'Gold',
    vars: {
      '--coin-1': '#ffe9a8', '--coin-2': '#f0c34f', '--coin-3': '#c8901f', '--coin-4': '#8a5f14',
      '--coin-rim': '#7a5a1e', '--coin-ink': '#4a3208',
    },
  },
  {
    id: 'silver',
    label: 'Silver',
    vars: {
      '--coin-1': '#f6f8fb', '--coin-2': '#ccd3dd', '--coin-3': '#98a3b2', '--coin-4': '#5f6875',
      '--coin-rim': '#5c6572', '--coin-ink': '#2b3038',
    },
  },
  {
    id: 'copper',
    label: 'Copper',
    vars: {
      '--coin-1': '#ffd2ae', '--coin-2': '#e0894f', '--coin-3': '#a85822', '--coin-4': '#6d3512',
      '--coin-rim': '#6f3a15', '--coin-ink': '#40200a',
    },
  },
  {
    id: 'iron',
    label: 'Iron',
    vars: {
      '--coin-1': '#d5dae2', '--coin-2': '#98a0ac', '--coin-3': '#646c79', '--coin-4': '#3a4049',
      '--coin-rim': '#3c424b', '--coin-ink': '#1d2128',
    },
  },
  {
    id: 'verdigris',
    label: 'Verdigris',
    vars: {
      '--coin-1': '#cfeee0', '--coin-2': '#7fc7ab', '--coin-3': '#43876f', '--coin-4': '#255043',
      '--coin-rim': '#2b5a4a', '--coin-ink': '#143026',
    },
  },
  {
    id: 'rose',
    label: 'Rose gold',
    vars: {
      '--coin-1': '#ffdfd4', '--coin-2': '#eaa892', '--coin-3': '#bf7159', '--coin-4': '#7f4331',
      '--coin-rim': '#844834', '--coin-ink': '#4a2418',
    },
  },
]

const DICE_KEY = 'insight-enigma:die-skin'
const COIN_KEY = 'insight-enigma:coin-skin'

const read = (key: string, fallback: string) => {
  try { return localStorage.getItem(key) ?? fallback } catch { return fallback }
}

export const readDieSkin = () => read(DICE_KEY, 'bone')
export const readCoinSkin = () => read(COIN_KEY, 'gold')

export function writeDieSkin(id: string) {
  try { localStorage.setItem(DICE_KEY, id) } catch { /* private mode */ }
}

export function writeCoinSkin(id: string) {
  try { localStorage.setItem(COIN_KEY, id) } catch { /* private mode */ }
}

/** The custom properties for a chosen pair, ready to spread onto a style prop.
 *  An unknown id falls back to the first skin rather than to nothing, so a
 *  renamed skin degrades to a working table instead of an unstyled one. */
export function skinVars(dieId: string, coinId: string): React.CSSProperties {
  const die = DICE_SKINS.find((s) => s.id === dieId) ?? DICE_SKINS[0]
  const coin = COIN_SKINS.find((s) => s.id === coinId) ?? COIN_SKINS[0]
  return { ...die.vars, ...coin.vars } as React.CSSProperties
}
