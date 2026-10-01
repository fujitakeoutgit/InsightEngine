/**
 * What the compiler makes of some rules text.
 *
 *   npx vite-node scripts/try.ts "Draw two cards." ["Type line"]
 *
 * Prints the compiled card as JSON: for trying a wording while writing a
 * pattern for it.
 */

import { compile } from '../src/game/compiler/compile'
import type { Card } from '../src/lib/api'

declare const process: { argv: string[] }

const [text, type = 'Sorcery'] = process.argv.slice(2)
const card = { oracle_id: 'try', name: 'Try', type_line: type, oracle_text: text.replace(/\\n/g, '\n') } as unknown as Card
console.log(JSON.stringify(compile(card), null, 1))
