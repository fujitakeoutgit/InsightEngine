/**
 * Every card beside what it compiled to, for reading one against the other.
 *
 *   npx vite-node scripts/audit.ts <cards.json> <out.txt>
 *
 * `coverage.ts` says how much of a card was read; this is for checking that
 * what was read is what the card says. Each card that compiled to anything
 * is written with its rules text, then its spell, triggers, abilities,
 * statics and ways to cast as the engine has them, and any line it took to
 * make no difference at this table. A card graded as playing itself can
 * still be wrong, and this is where that shows.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { compile, normalize } from '../src/game/compiler/compile'
import { isInert } from '../src/game/compiler/statics'
declare const process: { argv: string[] }
const cards = JSON.parse(readFileSync(process.argv[2], 'utf8'))
const j = (x: unknown) => JSON.stringify(x)
const out: string[] = []
let n = 0
for (const c of cards) {
  const k = compile(c)
  const text = c.oracle_text ?? c.card_faces?.[0]?.oracle_text ?? ''
  const busy = k.spell || k.triggers.length || k.activated.length || k.statics.length || k.ways.length || k.skipped.length || k.enchant
  const inert = normalize(c, text).filter((l: string) => isInert(l.toLowerCase()))
  if (!busy && !inert.length) continue
  n += 1
  out.push(`### ${n}. ${c.name} | ${c.type_line} | ${c.mana_cost ?? ''} | ${c.power ?? ''}/${c.toughness ?? ''} [${k.coverage}]`)
  out.push(text.replace(/\([^)]*\)/g, '').trim())
  if (k.spell) out.push(`  SPELL${k.spell.complete ? '' : ' (incomplete)'}: ${j(k.spell.effects)}`)
  if (k.overloaded) out.push(`  OVERLOADED: ${j(k.overloaded.effects)}`)
  if (k.enchant) out.push(`  ENCHANT: ${j(k.enchant)}`)
  for (const t of k.triggers) {
    const { text: _t, effects, complete, when, ...rest } = t
    out.push(`  TRIG ${j(when)} ${Object.keys(rest).length ? j(rest) : ''}${complete ? '' : ' (incomplete)'}: ${j(effects)}`)
  }
  for (const a of k.activated) {
    const cost = Object.fromEntries(Object.entries(a.cost).filter(([, v]) => v !== null && v !== false && v !== 0))
    const flags = [a.sorcery && 'sorcery', a.oncePerTurn && 'once', a.fromHand && 'hand', a.fromGraveyard && 'graveyard', a.only && `only:${a.only.text}`, a.mana && `mana:${j(a.mana)}`].filter(Boolean).join(',')
    out.push(`  ACT ${j(cost)} ${flags}: ${j(a.effects)}`)
  }
  for (const s of k.statics) out.push(`  STATIC ${j(s)}`)
  for (const w of k.ways) out.push(`  WAY ${j(w)}`)
  for (const s of k.skipped) out.push(`  SKIPPED ${s}`)
  for (const l of inert) out.push(`  INERT ${l}`)
  out.push('')
}
writeFileSync(process.argv[3], out.join('\n'))
console.log(n, 'cards written')
