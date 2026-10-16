import { describe, expect, it } from 'vitest'
import { Doc } from '../src/doc.js'
import type { Op } from '../src/types.js'

/**
 * Interleaving is the classic text-CRDT anomaly: two people type a word at
 * the same spot while offline, and on merge their letters get shuffled
 * together ("HWeolrllod"). Fugue guarantees that text typed left-to-right by
 * concurrent users never interleaves ("forward non-interleaving").
 */
describe('non-interleaving', () => {
  /** Each user types their word one keystroke (one op) at a time, offline. */
  function typeConcurrently(base: string, at: number, words: Record<string, string>, deleteAt?: number) {
    const origin = new Doc('origin')
    if (base) origin.insert(0, base)
    if (deleteAt !== undefined) origin.delete(deleteAt, 1)

    const logs: Op[][] = []
    for (const [name, word] of Object.entries(words)) {
      const d = new Doc(name)
      d.apply(origin.ops())
      const log: Op[] = []
      for (let i = 0; i < word.length; i++) log.push(d.insert(at + i, word[i])!)
      logs.push(log)
    }

    // Merge with keystrokes from all users interleaved as much as possible.
    const merged = new Doc('merged')
    merged.apply(origin.ops())
    const longest = Math.max(...logs.map((l) => l.length))
    for (let i = 0; i < longest; i++) for (const log of logs) if (log[i]) merged.apply([log[i]])
    return merged.toString()
  }

  it('keeps two concurrent words intact', () => {
    const result = typeConcurrently('', 0, { alice: 'Hello', bob: 'World' })
    expect(['HelloWorld', 'WorldHello']).toContain(result)
  })

  it('keeps words intact when inserted into existing text', () => {
    const result = typeConcurrently('[]', 1, { alice: 'apple', bob: 'banana', carol: 'cherry' })
    expect(result.startsWith('[') && result.endsWith(']')).toBe(true)
    const inner = result.slice(1, -1)
    for (const w of ['apple', 'banana', 'cherry']) expect(inner).toContain(w)
    expect(inner).toHaveLength('applebananacherry'.length)
  })

  it('keeps words intact after the insertion point has been edited before', () => {
    // "X" is deleted first, leaving a tombstone right at the insertion point.
    const result = typeConcurrently('abXcd', 2, { alice: '1234', bob: 'wxyz' }, 2)
    expect(['ab1234wxyzcd', 'abwxyz1234cd']).toContain(result)
  })

  it('is the same on every replica regardless of delivery order', () => {
    const alice = new Doc('alice')
    const bob = new Doc('bob')
    const a = ['H', 'e', 'l', 'l', 'o'].map((c, i) => alice.insert(i, c)!)
    const b = ['W', 'o', 'r', 'l', 'd'].map((c, i) => bob.insert(i, c)!)
    alice.apply(b)
    bob.apply(a)
    expect(alice.toString()).toBe(bob.toString())
    expect(alice.toString()).toBe('HelloWorld')
  })
})
