/**
 * Replays real editing traces through this engine, Yjs and Automerge.
 *
 *   npm run traces   # download the traces once
 *   npm run bench
 *
 * Two measurements per library:
 *   1. local:  apply every keystroke of the trace as a local edit
 *   2. remote: load the whole history into a fresh replica (what a peer
 *              does when it syncs a document for the first time)
 * Each final text is checked against the trace's expected end state.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import * as Automerge from '@automerge/automerge'
import * as Y from 'yjs'
import { Doc } from '../src/doc.js'
import type { Op } from '../src/types.js'

interface Trace {
  startContent: string
  endContent: string
  txns: { patches: [number, number, string][] }[]
}

interface Result {
  trace: string
  library: string
  edits: number
  localMs: number
  remoteMs: number
  bytes: number
  memoryMB: number | null
}

/** Retained heap of a built document, measured in a fresh process (see memory.ts). */
function memoryMB(lib: string, trace: string): number {
  const out = execFileSync(
    process.execPath,
    ['--expose-gc', '--import', 'tsx', new URL('./memory.ts', import.meta.url).pathname, lib, trace],
    { encoding: 'utf8' },
  )
  return JSON.parse(out).mb
}

function load(name: string): Trace {
  const raw = readFileSync(new URL(`./traces/${name}.json.gz`, import.meta.url))
  return JSON.parse(gunzipSync(raw).toString('utf8'))
}

function check(lib: string, actual: string, expected: string) {
  if (actual !== expected) throw new Error(`${lib}: final text does not match the trace`)
}

function benchFugue(trace: Trace): Omit<Result, 'trace' | 'edits' | 'memoryMB'> {
  let t = performance.now()
  const doc = new Doc('author')
  for (const txn of trace.txns) {
    for (const [pos, del, ins] of txn.patches) {
      if (del > 0) doc.delete(pos, del)
      if (ins.length > 0) doc.insert(pos, ins)
    }
  }
  const localMs = performance.now() - t
  check('fugue', doc.toString(), trace.endContent)

  const encoded = JSON.stringify(doc.ops())
  t = performance.now()
  const peer = new Doc('peer')
  peer.apply(JSON.parse(encoded) as Op[])
  const remoteMs = performance.now() - t
  check('fugue (remote)', peer.toString(), trace.endContent)
  return { library: 'fugue-crdt-lab', localMs, remoteMs, bytes: Buffer.byteLength(encoded) }
}

function benchYjs(trace: Trace): Omit<Result, 'trace' | 'edits' | 'memoryMB'> {
  let t = performance.now()
  const doc = new Y.Doc()
  const text = doc.getText()
  for (const txn of trace.txns) {
    for (const [pos, del, ins] of txn.patches) {
      if (del > 0) text.delete(pos, del)
      if (ins.length > 0) text.insert(pos, ins)
    }
  }
  const localMs = performance.now() - t
  check('yjs', text.toString(), trace.endContent)

  const update = Y.encodeStateAsUpdate(doc)
  t = performance.now()
  const peer = new Y.Doc()
  Y.applyUpdate(peer, update)
  const remoteMs = performance.now() - t
  check('yjs (remote)', peer.getText().toString(), trace.endContent)
  return { library: 'Yjs', localMs, remoteMs, bytes: update.byteLength }
}

function benchAutomerge(trace: Trace): Omit<Result, 'trace' | 'edits' | 'memoryMB'> {
  let t = performance.now()
  let doc = Automerge.from<{ text: string }>({ text: '' })
  for (const txn of trace.txns) {
    doc = Automerge.change(doc, (d) => {
      for (const [pos, del, ins] of txn.patches) Automerge.splice(d, ['text'], pos, del, ins)
    })
  }
  const localMs = performance.now() - t
  check('automerge', doc.text, trace.endContent)

  const saved = Automerge.save(doc)
  t = performance.now()
  const peer = Automerge.load<{ text: string }>(saved)
  const remoteMs = performance.now() - t
  check('automerge (remote)', peer.text, trace.endContent)
  return { library: 'Automerge', localMs, remoteMs, bytes: saved.byteLength }
}

const traces = process.argv.slice(2).length > 0 ? process.argv.slice(2) : ['automerge-paper', 'seph-blog1']
const libs = [
  { run: benchFugue, memory: 'fugue' },
  { run: benchYjs, memory: 'yjs' },
  // Automerge keeps its state in WebAssembly memory, outside the JS heap,
  // so its memory isn't comparable here and is reported as n/a.
  { run: benchAutomerge, memory: null },
]
const results: Result[] = []

for (const name of traces) {
  const trace = load(name)
  if (trace.startContent !== '') throw new Error(`${name}: non-empty start content is not supported`)
  const edits = trace.txns.reduce((n, t) => n + t.patches.length, 0)
  console.log(`\n${name}: ${edits.toLocaleString()} edits, ${trace.endContent.length.toLocaleString()} chars at the end`)
  for (const lib of libs) {
    lib.run(trace) // warm-up
    const r = { trace: name, edits, ...lib.run(trace), memoryMB: lib.memory ? memoryMB(lib.memory, name) : null }
    results.push(r)
    console.log(
      `  ${r.library.padEnd(10)} local ${fmt(r.localMs).padStart(8)} ms   remote ${fmt(r.remoteMs).padStart(8)} ms` +
        `   encoded ${(r.bytes / 1024).toFixed(0).padStart(6)} KB   memory ${r.memoryMB === null ? '   n/a' : r.memoryMB.toFixed(1).padStart(6) + ' MB'}`,
    )
  }
}

writeFileSync(new URL('./results.json', import.meta.url), JSON.stringify(
  { node: process.version, date: new Date().toISOString().slice(0, 10), results },
  null,
  2,
) + '\n')

function fmt(ms: number) {
  return ms < 100 ? ms.toFixed(1) : ms.toFixed(0)
}
