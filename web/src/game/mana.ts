/**
 * Mana: what a cost asks for, and which of your sources should pay it.
 *
 * Pure, and blind to cards. The engine describes each untapped permanent as a
 * `ManaSource` — what one activation makes, what it costs to activate, how
 * much we would rather keep it — and `autotap` finds the cheapest set of
 * activations that pays. Cheapest is the point: any tapper can find *a* way to
 * pay, but paying `{G}` with Command Tower when a Forest was sitting right
 * there costs you the white spell you were going to cast next.
 */

export const COLORS = ['W', 'U', 'B', 'R', 'G'] as const
export type Color = (typeof COLORS)[number]

/** A kind of mana. `C` is colorless mana — what Sol Ring makes and `{C}`
 *  demands — which is not the same thing as generic: generic is a cost, and
 *  any kind of mana pays it. */
export type ManaType = Color | 'C'
export const MANA_TYPES: readonly ManaType[] = [...COLORS, 'C']

export type ManaPool = Record<ManaType, number>

export function emptyPool(): ManaPool {
  return { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 }
}

const isColor = (symbol: string): symbol is Color =>
  (COLORS as readonly string[]).includes(symbol)

const isManaType = (symbol: string): symbol is ManaType =>
  symbol === 'C' || isColor(symbol)

/** A mana cost, read. */
export interface Cost {
  /** `{3}`: any mana at all. */
  generic: number
  /** One entry per symbol that wants a particular kind of mana, listing the
   *  kinds that will do: `{G}` is `['G']`, `{G/W}` is `['G', 'W']`, `{C}` is
   *  `['C']`. */
  pips: ManaType[][]
  /** `{2/W}`: one white, or two of anything. */
  twobrid: Color[]
  /** `{W/P}`: one white, or 2 life. `{G/W/P}` is `['G', 'W']`. */
  phyrexian: Color[][]
  /** How many `{X}` it carries. X is chosen as the spell is cast, and paid as
   *  generic once it has been. */
  x: number
}

const SYMBOL = /\{([^}]+)\}/g

/** Read a printed cost — `{2}{G}{G/W}{G/P}{X}{C}` and the rest.
 *
 * A split card prints both halves, `{1}{R} // {2}{G}`; only the first is read,
 * because only one half is ever cast at a time and the caller knows which. */
export function parseCost(text: string | null | undefined): Cost {
  const cost: Cost = { generic: 0, pips: [], twobrid: [], phyrexian: [], x: 0 }
  const half = (text ?? '').split('//')[0]
  for (const [, raw] of half.matchAll(SYMBOL)) {
    const symbol = raw.toUpperCase()
    if (/^\d+$/.test(symbol)) {
      cost.generic += Number(symbol)
    } else if (symbol === 'X' || symbol === 'Y' || symbol === 'Z') {
      cost.x += 1
    } else if (isManaType(symbol)) {
      cost.pips.push([symbol])
    } else if (symbol === 'S') {
      // Snow wants mana from a snow source. Paid as generic until a deck that
      // cares turns up; no sample deck does.
      cost.generic += 1
    } else {
      const parts = symbol.split('/')
      if (parts[parts.length - 1] === 'P') {
        const colors = parts.slice(0, -1).filter(isColor)
        if (colors.length) cost.phyrexian.push(colors)
      } else if (parts.length === 2 && parts[0] === '2' && isColor(parts[1])) {
        cost.twobrid.push(parts[1])
      } else if (parts.length > 1 && parts.every(isManaType)) {
        cost.pips.push(parts as ManaType[])
      }
      // Anything else — {HW}, {½}, {∞} — belongs to a joke set, not a game.
    }
  }
  return cost
}

/** A cost written back out the way it is printed — with any tax already in
 *  its generic part, so it reads as what you actually have to pay. */
export function formatCost(cost: Cost): string {
  const symbols = [
    ...Array.from({ length: cost.x }, () => 'X'),
    ...(cost.generic || (!cost.pips.length && !cost.twobrid.length && !cost.phyrexian.length && !cost.x)
      ? [String(cost.generic)] : []),
    ...cost.twobrid.map((color) => `2/${color}`),
    ...cost.pips.map((pip) => pip.join('/')),
    ...cost.phyrexian.map((colors) => `${colors.join('/')}/P`),
  ]
  return symbols.map((s) => `{${s}}`).join('')
}

/** How much of each kind of mana some costs want — the rest of your hand,
 *  when deciding which land you can spare. A hybrid pip is split between its
 *  colors, since either would do. */
export function demand(costs: readonly Cost[]): ManaPool {
  const wanted = emptyPool()
  for (const cost of costs) {
    for (const pip of cost.pips) for (const kind of pip) wanted[kind] += 1 / pip.length
    for (const color of cost.twobrid) wanted[color] += 0.5
    for (const colors of cost.phyrexian) for (const color of colors) wanted[color] += 0.5 / colors.length
  }
  return wanted
}

/** Something on the battlefield that can make mana. */
export interface ManaSource {
  /** The permanent's iid. */
  id: string
  /** One activation's mana: an entry per mana it makes, each listing the kinds
   *  that mana may be. Forest is `[['G']]`, Command Tower in a three-color deck
   *  `[['W','B','G']]`, Sol Ring `[['C'], ['C']]`, a Signet `[['W'], ['B']]`. */
  makes: ManaType[][]
  /** Generic mana spent to activate it — a Signet's `{1}`. */
  input?: number
  /** How much we would rather not tap it. See `sourcePenalty`. */
  penalty: number
}

/** What a source looks like beyond the mana it makes. */
export interface SourceTraits {
  /** A creature tapped for mana is a creature that is not attacking. */
  creature?: boolean
  /** It does something else as well, which tapping it for mana gives up. */
  abilities?: boolean
}

/**
 * How reluctant the tapper should be to use a source.
 *
 * One per activation, so fewer activations win, and then more for everything
 * that makes a source worth keeping untapped: each extra color it could make
 * (it can still pay for whatever you cast next), the colors your hand is
 * waiting on, being a creature, having another use.
 */
export function sourcePenalty(
  makes: ManaType[][],
  traits: SourceTraits = {},
  wanted: Partial<ManaPool> = {},
): number {
  const kinds = new Set(makes.flat())
  const colors = [...kinds].filter((kind) => kind !== 'C').length
  let penalty = 1 + 0.3 * Math.max(0, colors - 1)
  for (const kind of kinds) penalty += 0.1 * Math.min(5, wanted[kind] ?? 0)
  if (traits.creature) penalty += 2
  if (traits.abilities) penalty += 1
  return penalty
}

/** Made and not spent. It floats, and empties at the end of the step. */
export const WASTE = 0.4

/** Paying 2 life for a Phyrexian symbol instead of the mana, in penalty
 *  units: worth it rather than tapping a creature, not rather than a land. */
export const LIFE_COST = 3

/** One source's activation and the mana it made. */
export interface Tap {
  id: string
  mana: ManaType[]
}

export interface Payment {
  taps: Tap[]
  /** Paid for Phyrexian symbols rather than mana. */
  life: number
  /** The pool once the cost is paid: what was floating, plus what was made,
   *  less what was spent. */
  pool: ManaPool
}

/* --- the search ------------------------------------------------------- *
 *
 * Paying is an assignment: each mana the cost needs is paid by one mana some
 * source makes. Most sources make exactly one mana per tap — every land,
 * Command Tower, a mana creature — and for those the cheapest assignment is a
 * min-cost flow, solved exactly in a few milliseconds however big the board.
 *
 * What breaks the flow is a source whose tap is all-or-nothing: Sol Ring makes
 * two mana whether you need one or two, and a Signet takes a mana before it
 * gives two. Those are few, so each way of using them is tried in turn and the
 * flow fills in the rest. An earlier version searched every combination of
 * every source; it was exact too, and took fifteen seconds to tap out for X.
 */

/** Sources that are interchangeable for paying. Seven Forests are one supply
 *  of seven, not seven decisions. */
interface Group {
  members: ManaSource[]
  makes: ManaType[][]
  input: number
  penalty: number
  /** Taps all-or-nothing — more than one mana, or an input — so it is
   *  enumerated rather than left to the flow. */
  fixed: boolean
}

const ORDER = (kind: ManaType) => MANA_TYPES.indexOf(kind)

function groupSources(sources: readonly ManaSource[]): Group[] {
  const groups = new Map<string, Group>()
  for (const source of sources) {
    const makes = source.makes.map((unit) => [...unit].sort((a, b) => ORDER(a) - ORDER(b)))
    const input = source.input ?? 0
    const key = JSON.stringify([makes, input, source.penalty])
    const known = groups.get(key)
    if (known) {
      known.members.push(source)
    } else {
      groups.set(key, {
        members: [source], makes, input, penalty: source.penalty,
        fixed: makes.length !== 1 || input > 0,
      })
    }
  }
  return [...groups.values()]
}

/** Mana the cost needs, gathered by what will pay it. */
interface Need {
  /** Kinds that pay it; null for generic. */
  accepts: readonly ManaType[] | null
  /** Only mana made without an activation cost may pay it. See `needsFor`. */
  base: boolean
  count: number
}

/** Mana on offer, and what spending one costs. */
interface Offer {
  types: readonly ManaType[]
  base: boolean
  capacity: number
  cost: number
  /** Floating mana, or the `unit`th mana of group `group`'s activations. */
  from: { pool: ManaType } | { group: number; unit: number }
}

/**
 * The cost's mana, plus what the chosen Signets need fed to them.
 *
 * A Signet's input has to exist before the Signet is used, so it cannot be the
 * Signet's own output. With every input a single mana the rule is exactly: at
 * least one input is paid by mana that needed no input itself. After that the
 * Signets can pay for each other in some order — Forest into Orzhov Signet,
 * its white into Selesnya Signet — so the rest may be paid by anything. A
 * larger input is rare enough to be held to the stricter rule throughout.
 */
function needsFor(pips: readonly ManaType[][], generic: number, inputs: number, chainable: boolean) {
  const byKind = new Map<string, Need>()
  for (const pip of pips) {
    const key = pip.join('')
    const known = byKind.get(key)
    if (known) known.count += 1
    else byKind.set(key, { accepts: pip, base: false, count: 1 })
  }
  const needs = [...byKind.values()]
  if (generic > 0) needs.push({ accepts: null, base: false, count: generic })
  if (inputs > 0 && chainable) {
    needs.push({ accepts: null, base: true, count: 1 })
    if (inputs > 1) needs.push({ accepts: null, base: false, count: inputs - 1 })
  } else if (inputs > 0) {
    needs.push({ accepts: null, base: true, count: inputs })
  }
  return needs
}

const fits = (offer: Offer, need: Need) =>
  (!need.base || offer.base)
  && (!need.accepts || offer.types.some((kind) => need.accepts!.includes(kind)))

type Arc = [from: number, to: number, capacity: number, cost: number]

/** Successive shortest paths, with Bellman-Ford for the negative arcs.
 *  Returns how much flowed, at what cost, and the flow along each arc. */
function minCostFlow(nodes: number, arcs: readonly Arc[], source: number, sink: number, want: number) {
  const head: number[][] = Array.from({ length: nodes }, () => [])
  const to: number[] = []
  const cap: number[] = []
  const price: number[] = []
  for (const [u, v, c, w] of arcs) {
    head[u].push(to.length); to.push(v); cap.push(c); price.push(w)
    head[v].push(to.length); to.push(u); cap.push(0); price.push(-w)
  }

  let flow = 0
  let total = 0
  while (flow < want) {
    const dist = new Array<number>(nodes).fill(Infinity)
    const via = new Array<number>(nodes).fill(-1)
    dist[source] = 0
    for (let round = 0; round < nodes; round += 1) {
      let changed = false
      for (let u = 0; u < nodes; u += 1) {
        if (dist[u] === Infinity) continue
        for (const e of head[u]) {
          if (cap[e] > 0 && dist[u] + price[e] < dist[to[e]] - 1e-9) {
            dist[to[e]] = dist[u] + price[e]
            via[to[e]] = e
            changed = true
          }
        }
      }
      if (!changed) break
    }
    if (dist[sink] === Infinity) break

    // The reverse of edge e is e ^ 1, and its head is e's tail.
    let push = want - flow
    for (let v = sink; v !== source; v = to[via[v] ^ 1]) push = Math.min(push, cap[via[v]])
    for (let v = sink; v !== source; v = to[via[v] ^ 1]) {
      cap[via[v]] -= push
      cap[via[v] ^ 1] += push
    }
    flow += push
    total += push * dist[sink]
  }
  return { flow, cost: total, along: arcs.map((arc, i) => arc[2] - cap[2 * i]) }
}

interface Plan {
  score: number
  /** Activations of each all-or-nothing group. The rest are read off `spent`. */
  counts: number[]
  offers: Offer[]
  needs: Need[]
  /** How much each offer gave each need. */
  spent: number[][]
}

/** The cheapest plan for one reading of the cost — every `{2/W}` and `{W/P}`
 *  already decided — or null if the sources cannot pay it. */
function cheapest(
  pips: readonly ManaType[][],
  generic: number,
  pool: ManaPool,
  groups: readonly Group[],
): Plan | null {
  const fixed = groups.flatMap((group, g) => (group.fixed ? [g] : []))
  const counts = groups.map(() => 0)
  // Never more activations of one kind than there is mana to pay.
  const ceiling = pips.length + generic
  let best: Plan | null = null

  const solve = (overhead: number) => {
    let inputs = 0
    let chainable = true
    const offers: Offer[] = []
    for (const kind of MANA_TYPES) {
      if (pool[kind] > 0) {
        offers.push({ types: [kind], base: true, capacity: pool[kind], cost: 0, from: { pool: kind } })
      }
    }
    groups.forEach((group, g) => {
      if (!group.fixed) {
        offers.push({
          types: group.makes[0], base: true, capacity: group.members.length,
          cost: group.penalty, from: { group: g, unit: 0 },
        })
        return
      }
      if (!counts[g]) return
      inputs += counts[g] * group.input
      if (group.input > 1) chainable = false
      // Already paid for by `overhead`, so spending it is free — better than
      // free, since it is no longer wasted.
      group.makes.forEach((types, unit) => offers.push({
        types, base: group.input === 0, capacity: counts[g], cost: -WASTE, from: { group: g, unit },
      }))
    })
    const needs = needsFor(pips, generic, inputs, chainable)
    const want = needs.reduce((n, need) => n + need.count, 0)

    // Node 0 is the source, then the offers, then the needs, then the sink.
    const sink = offers.length + needs.length + 1
    const arcs: Arc[] = []
    offers.forEach((offer, i) => arcs.push([0, 1 + i, offer.capacity, offer.cost]))
    needs.forEach((need, j) => arcs.push([1 + offers.length + j, sink, need.count, 0]))
    const pairs: [number, number][] = []
    offers.forEach((offer, i) => needs.forEach((need, j) => {
      if (!fits(offer, need)) return
      pairs.push([i, j])
      arcs.push([1 + i, 1 + offers.length + j, want, 0])
    }))

    const result = minCostFlow(sink + 1, arcs, 0, sink, want)
    if (result.flow < want) return
    const made = offers.reduce((n, offer) => n + (offer.cost < 0 ? offer.capacity : 0), 0)
    const score = overhead + result.cost + made * WASTE
    if (best && score >= best.score - 1e-9) return

    const spent = offers.map(() => needs.map(() => 0))
    const first = offers.length + needs.length
    pairs.forEach(([i, j], k) => { spent[i][j] = result.along[first + k] })
    best = { score, counts: [...counts], offers, needs, spent }
  }

  // Every way of using the all-or-nothing sources, the flow doing the rest.
  const choose = (index: number, overhead: number) => {
    if (best && overhead >= best.score) return
    if (index === fixed.length) {
      solve(overhead)
      return
    }
    const g = fixed[index]
    const group = groups[g]
    const limit = Math.min(group.members.length, ceiling)
    for (let n = 0; n <= limit; n += 1) {
      counts[g] = n
      choose(index + 1, overhead + n * group.penalty)
    }
    counts[g] = 0
  }

  choose(0, 0)
  return best
}

/**
 * The cheapest way to pay `cost` from the pool and these sources, or null if
 * there is none.
 *
 * Floating mana is spent first and costs nothing. Each `{2/W}` and `{W/P}` can
 * be paid two ways, so every combination is tried and the cheapest kept —
 * there are rarely more than two such symbols. Life is only offered while you
 * have it to pay.
 */
export function autotap(
  cost: Cost,
  sources: readonly ManaSource[],
  { x = 0, pool = emptyPool(), life = Infinity }: { x?: number; pool?: ManaPool; life?: number } = {},
): Payment | null {
  const groups = groupSources(sources)
  const generic = cost.generic + cost.x * Math.max(0, x)
  const choices = cost.twobrid.length + cost.phyrexian.length

  let best: { plan: Plan; score: number; life: number } | null = null
  for (let mask = 0; mask < 1 << choices; mask += 1) {
    const pips = [...cost.pips]
    let paidLife = 0
    let extra = 0
    cost.twobrid.forEach((color, i) => {
      if (mask & (1 << i)) extra += 2
      else pips.push([color])
    })
    cost.phyrexian.forEach((colors, i) => {
      if (mask & (1 << (cost.twobrid.length + i))) paidLife += 2
      else pips.push(colors)
    })
    if (paidLife > life) continue

    const plan = cheapest(pips, generic + extra, pool, groups)
    if (!plan) continue
    const score = plan.score + (paidLife / 2) * LIFE_COST
    if (!best || score < best.score) best = { plan, score, life: paidLife }
  }
  return best && settle(best.plan, groups, pool, best.life)
}

/** Turn a plan into taps — which sources, making what — and the pool after. */
function settle(plan: Plan, groups: readonly Group[], pool: ManaPool, life: number): Payment {
  const after = { ...pool }

  // How many of each group are tapped. A one-mana source is tapped once for
  // each mana the flow took from it.
  const tappedOf = groups.map((group, g) => {
    if (group.fixed) return plan.counts[g]
    return plan.offers.reduce((n, offer, i) => (
      'group' in offer.from && offer.from.group === g
        ? n + plan.spent[i].reduce((sum, v) => sum + v, 0)
        : n
    ), 0)
  })
  // Per group, per activation, the kind each of its mana was spent as.
  const made = groups.map((group, g) =>
    Array.from({ length: tappedOf[g] }, () => group.makes.map((): ManaType | null => null)))

  plan.offers.forEach((offer, i) => plan.needs.forEach((need, j) => {
    let left = plan.spent[i][j]
    if (!left) return
    if ('pool' in offer.from) {
      after[offer.from.pool] -= left
      return
    }
    const kind = need.accepts
      ? offer.types.find((k) => need.accepts!.includes(k))!
      : offer.types[0]
    const { group: g, unit } = offer.from
    for (const activation of made[g]) {
      if (!left) break
      if (activation[unit] === null) {
        activation[unit] = kind
        left -= 1
      }
    }
  }))

  const taps: Tap[] = []
  made.forEach((activations, g) => activations.forEach((units, a) => {
    const mana = units.map((kind, unit) => {
      if (kind !== null) return kind
      // Made and not spent: it floats.
      const floating = groups[g].makes[unit][0]
      after[floating] += 1
      return floating
    })
    taps.push({ id: groups[g].members[a].id, mana })
  }))
  return { taps, life, pool: after }
}
