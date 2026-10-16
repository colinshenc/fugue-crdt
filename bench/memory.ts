/**
 * Memory used by a fully built document, measured in a fresh process per
 * library: heap after building the doc minus heap after dropping it.
 *
 *   node --expose-gc --import tsx bench/memory.ts <fugue|yjs> <trace>
 */
import { readFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import * as Y from 'yjs'
import { Doc } from '../src/doc.js'

const [lib = 'fugue', name = 'automerge-paper'] = process.argv.slice(2)
const trace = JSON.parse(gunzipSync(readFileSync(new URL(`./traces/${name}.json.gz`, import.meta.url))).toString())
const patches: [number, number, string][] = trace.txns.flatMap((t: { patches: [number, number, string][] }) => t.patches)

const gc = (globalThis as { gc?: () => void }).gc
if (!gc) throw new Error('run with --expose-gc')
const heap = () => {
  for (let i = 0; i < 4; i++) gc()
  return process.memoryUsage().heapUsed
}

function build(): unknown {
  if (lib === 'yjs') {
    const doc = new Y.Doc()
    const text = doc.getText()
    for (const [pos, del, ins] of patches) {
      if (del > 0) text.delete(pos, del)
      if (ins.length > 0) text.insert(pos, ins)
    }
    return doc
  }
  const doc = new Doc('author')
  for (const [pos, del, ins] of patches) {
    if (del > 0) doc.delete(pos, del)
    if (ins.length > 0) doc.insert(pos, ins)
  }
  return doc
}

const holder: { doc: unknown } = { doc: build() }
const alive = heap()
holder.doc = null
const dead = heap()
console.log(JSON.stringify({ lib, trace: name, mb: +((alive - dead) / 1048576).toFixed(1) }))
