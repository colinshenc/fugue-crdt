import { describe, expect, it } from 'vitest'
import { Doc } from '../src/doc.js'
import { rng } from '../src/sim/network.js'
import type { Op } from '../src/types.js'
import { ReferenceFugue, toCharOps } from './reference.js'

/**
 * Differential test: several replicas, each holding both the optimised Doc and
 * the naive reference tree. Random edits happen on random replicas, and ops
 * are delivered to the others in random order. After every step the two
 * implementations must agree, both on the text and on the parent/side each
 * new character is given.
 */
describe('Doc vs. reference Fugue', () => {
  it.each(Array.from({ length: 40 }, (_, i) => i + 1))('agrees on seed %i', (seed) => {
    const random = rng(seed)
    const names = ['alice', 'bob', 'carol', 'dave'].slice(0, 2 + (seed % 3))
    const replicas = names.map((name) => ({
      name,
      doc: new Doc(name),
      ref: new ReferenceFugue(),
      inbox: [] as Op[],
    }))

    // The Doc buffers ops whose dependencies are missing; the reference has no
    // buffer, so it is fed exactly the ops the Doc applied, in the same order.
    const applyToRef = (r: (typeof replicas)[number], ops: readonly Op[]) => {
      for (const op of ops) for (const c of toCharOps(op)) r.ref.apply(c)
    }

    for (let step = 0; step < 300; step++) {
      const r = replicas[Math.floor(random() * replicas.length)]
      const action = random()

      if (action < 0.45) {
        const index = Math.floor(random() * (r.doc.length + 1))
        const expected = r.ref.originsFor(index)
        const op = r.doc.insert(index, word(random))!
        expect({ parent: op.parent, side: op.side }).toEqual(expected)
        applyToRef(r, [op])
        for (const other of replicas) if (other !== r) other.inbox.push(op)
      } else if (action < 0.6 && r.doc.length > 0) {
        const index = Math.floor(random() * r.doc.length)
        const ops = r.doc.delete(index, 1 + Math.floor(random() * Math.min(3, r.doc.length - index)))
        applyToRef(r, ops)
        for (const other of replicas) if (other !== r) other.inbox.push(...ops)
      } else if (r.inbox.length > 0) {
        // Deliver a random subset of the inbox, shuffled.
        const take = r.inbox.filter(() => random() < 0.5)
        r.inbox = r.inbox.filter((op) => !take.includes(op))
        shuffle(take, random)
        applyToRef(r, r.doc.apply(take).applied)
      }

      for (const x of replicas) expect(x.doc.toString()).toBe(x.ref.toString())
    }

    // Deliver everything that's left: all replicas converge, and still agree.
    for (const r of replicas) {
      applyToRef(r, r.doc.apply(r.inbox).applied)
      expect(r.doc.pendingCount).toBe(0)
      expect(r.doc.toString()).toBe(r.ref.toString())
    }
    const texts = new Set(replicas.map((r) => r.doc.toString()))
    expect(texts.size).toBe(1)
  })
})

function word(random: () => number): string {
  const len = random() < 0.7 ? 1 : 2 + Math.floor(random() * 5)
  let s = ''
  for (let i = 0; i < len; i++) s += String.fromCharCode(97 + Math.floor(random() * 26))
  return s
}

function shuffle<T>(xs: T[], random: () => number): void {
  for (let i = xs.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    ;[xs[i], xs[j]] = [xs[j], xs[i]]
  }
}
