import { describe, expect, it } from 'vitest'
import { Doc } from '../src/doc.js'
import { rng } from '../src/sim/network.js'

describe('Doc (single replica)', () => {
  it('inserts and deletes', () => {
    const doc = new Doc('alice')
    doc.insert(0, 'helo')
    doc.insert(3, 'l')
    doc.insert(5, ' world')
    expect(doc.toString()).toBe('hello world')
    doc.delete(0, 6)
    expect(doc.toString()).toBe('world')
    expect(doc.length).toBe(5)
    expect(doc.nodeCount).toBe(11) // deleted characters stay as tombstones
  })

  it('rejects out-of-range edits', () => {
    const doc = new Doc('alice')
    doc.insert(0, 'abc')
    expect(() => doc.insert(4, 'x')).toThrow(RangeError)
    expect(() => doc.delete(2, 2)).toThrow(RangeError)
  })

  it('assigns dense sequence numbers', () => {
    const doc = new Doc('alice')
    const ins = doc.insert(0, 'abc')!
    const dels = doc.delete(1, 2)
    expect(ins.id).toEqual(['alice', 0])
    // "bc" were typed together, so deleting them is one ranged op.
    expect(dels).toEqual([{ type: 'del', id: ['alice', 3], target: ['alice', 1], len: 2 }])
    expect(doc.version()).toEqual({ alice: 5 })
  })

  it.each([1, 2, 3, 4, 5])('matches a plain string under random edits (seed %i)', (seed) => {
    const random = rng(seed)
    const doc = new Doc('alice')
    let model = ''
    for (let step = 0; step < 4000; step++) {
      const r = random()
      if (model.length === 0 || r < 0.6) {
        const index = Math.floor(random() * (model.length + 1))
        // Mostly single characters, sometimes a paste big enough to split chunks.
        const len = random() < 0.95 ? 1 + Math.floor(random() * 4) : 200 + Math.floor(random() * 800)
        const text = randomText(random, len)
        doc.insert(index, text)
        model = model.slice(0, index) + text + model.slice(index)
      } else {
        const index = Math.floor(random() * model.length)
        const len = 1 + Math.floor(random() * Math.min(20, model.length - index))
        doc.delete(index, len)
        model = model.slice(0, index) + model.slice(index + len)
      }
      expect(doc.length).toBe(model.length)
      if (step % 250 === 0) expect(doc.toString()).toBe(model)
    }
    expect(doc.toString()).toBe(model)
  })

  it('rebuilds the same document from its own ops', () => {
    const random = rng(42)
    const a = new Doc('alice')
    for (let i = 0; i < 2000; i++) {
      if (a.length > 0 && random() < 0.3) a.delete(Math.floor(random() * a.length), 1)
      else a.insert(Math.floor(random() * (a.length + 1)), randomText(random, 3))
    }
    const b = new Doc('bob')
    b.apply(a.ops())
    expect(b.toString()).toBe(a.toString())
    expect(b.version()).toEqual(a.version())
  })
})

describe('op log compression', () => {
  it('merges keystrokes and backspaces into runs, without changing meaning', () => {
    const doc = new Doc('alice')
    for (const [i, c] of [...'hello world'].entries()) doc.insert(i, c)
    for (let i = 11; i > 6; i--) doc.delete(i - 1, 1) // backspace "world"
    expect(doc.ops()).toEqual([
      { type: 'ins', id: ['alice', 0], parent: null, side: 'R', text: 'hello world' },
      { type: 'del', id: ['alice', 11], target: ['alice', 6], len: 5 },
    ])
    const copy = new Doc('bob')
    copy.apply(doc.ops())
    expect(copy.toString()).toBe('hello ')
    expect(copy.ops()).toEqual(doc.ops())
  })

  it('applies a partly-seen delete range', () => {
    const alice = new Doc('alice')
    alice.insert(0, 'abcdef')
    const first = alice.delete(5, 1) // "f"
    alice.delete(4, 1) // "e", merges into one range in Alice's log
    const bob = new Doc('bob')
    bob.apply([alice.ops()[0], ...first])
    bob.apply(alice.opsSince(bob.version()))
    expect(bob.toString()).toBe('abcd')
    expect(bob.version()).toEqual(alice.version())
  })
})

describe('cursor anchors', () => {
  it('keep a cursor on the same character while remote edits land before it', () => {
    const alice = new Doc('alice')
    const bob = new Doc('bob')
    bob.apply([alice.insert(0, 'hello world')!])

    // Bob's cursor sits after "hello".
    const anchor = bob.anchorAt(5)
    // Alice types at the start; the cursor should shift right with its text.
    bob.apply([alice.insert(0, '>> ')!])
    expect(bob.toString()).toBe('>> hello world')
    expect(bob.positionOf(anchor)).toBe(8)

    // If the anchor character is deleted, the cursor stays where it was.
    bob.apply(alice.delete(7, 1))
    expect(bob.toString()).toBe('>> hell world')
    expect(bob.positionOf(anchor)).toBe(7)
    expect(bob.positionOf(null)).toBe(0)
  })
})

describe('apply', () => {
  it('buffers ops until their dependencies arrive, in any order', () => {
    const alice = new Doc('alice')
    const ops = [alice.insert(0, 'abc')!, alice.insert(3, 'def')!, ...alice.delete(1, 1)]

    const bob = new Doc('bob')
    expect(bob.apply([ops[2]]).applied).toHaveLength(0)
    expect(bob.pendingCount).toBe(1)
    expect(bob.apply([ops[1]]).applied).toHaveLength(0)
    const result = bob.apply([ops[0]])
    expect(result.applied).toHaveLength(3)
    expect(bob.pendingCount).toBe(0)
    expect(bob.toString()).toBe('acdef')
  })

  it('ignores duplicates and trims partially seen runs', () => {
    const alice = new Doc('alice')
    alice.insert(0, 'abc')
    const bob = new Doc('bob')
    bob.apply(alice.ops())
    bob.apply(alice.ops())
    expect(bob.toString()).toBe('abc')

    // A run that overlaps what Bob already has: only "de" is new.
    const overlapping = { type: 'ins', id: ['alice', 1], parent: ['alice', 0], side: 'R', text: 'bcde' } as const
    const carol = new Doc('carol')
    carol.apply(alice.ops())
    // Make the overlap legitimate by having Alice actually type "de".
    alice.insert(3, 'de')
    const { applied } = carol.apply([overlapping])
    expect(applied).toEqual([{ type: 'ins', id: ['alice', 3], parent: ['alice', 2], side: 'R', text: 'de' }])
    expect(carol.toString()).toBe(alice.toString())
  })

  it('reports index-based changes for editors', () => {
    const alice = new Doc('alice')
    const bob = new Doc('bob')
    bob.apply([alice.insert(0, 'hello')!])
    const { changes } = bob.apply([alice.insert(5, '!')!, ...alice.delete(0, 1)])
    expect(changes).toEqual([
      { type: 'insert', index: 5, text: '!', agent: 'alice' },
      { type: 'delete', index: 0, length: 1 },
    ])
  })

  it('serves exactly the missing ops via opsSince', () => {
    const alice = new Doc('alice')
    alice.insert(0, 'hello')
    const bob = new Doc('bob')
    bob.apply(alice.ops())
    alice.insert(5, ' world')
    alice.delete(0, 1)
    const missing = alice.opsSince(bob.version())
    expect(missing).toHaveLength(2)
    bob.apply(missing)
    expect(bob.toString()).toBe('ello world')
  })
})

function randomText(random: () => number, len: number): string {
  let s = ''
  for (let i = 0; i < len; i++) s += String.fromCharCode(97 + Math.floor(random() * 26))
  return s
}
