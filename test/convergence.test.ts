import { describe, expect, it } from 'vitest'
import { Doc } from '../src/doc.js'
import { Cluster } from '../src/sim/cluster.js'
import { rng } from '../src/sim/network.js'

/**
 * Chaos testing on the simulated network. Each seed drives a different mix of
 * edits, partitions, packet loss, duplication and reordering. When the dust
 * settles, every replica must hold exactly the same text.
 *
 * A failure prints its seed; rerun that seed to replay the exact same history.
 */
const SEEDS = Number(process.env.CHAOS_SEEDS ?? 150)

describe('convergence under network chaos', () => {
  it.each(Array.from({ length: SEEDS }, (_, i) => i + 1))('seed %i', (seed) => {
    const random = rng(seed * 7919)
    const names = ['alice', 'bob', 'carol', 'dave', 'erin'].slice(0, 2 + (seed % 4))
    const cluster = new Cluster(names, {
      seed,
      syncInterval: 500,
      relay: random() < 0.7,
      network: {
        latency: 10 + random() * 100,
        jitter: random() * 300,
        dropRate: random() * 0.3,
        duplicateRate: random() * 0.2,
      },
    })

    for (let step = 0; step < 400; step++) {
      const action = random()
      if (action < 0.05) {
        // Split the cluster into random groups.
        const groups: string[][] = [[], []]
        for (const n of names) groups[random() < 0.5 ? 0 : 1].push(n)
        cluster.partition(groups)
      } else if (action < 0.08) {
        cluster.heal()
      } else if (action < 0.1) {
        const [a, b] = pickTwo(names, random)
        cluster.setLink(a, b, random() < 0.5)
      } else {
        const r = cluster.replica(names[Math.floor(random() * names.length)])
        const len = r.doc.length
        if (len > 0 && random() < 0.3) {
          const index = Math.floor(random() * len)
          r.delete(index, 1 + Math.floor(random() * Math.min(5, len - index)))
        } else {
          r.insert(Math.floor(random() * (len + 1)), text(random))
        }
      }
      cluster.step(random() * 200)
    }

    cluster.heal()
    expect(cluster.settle(), `seed ${seed} did not converge`).toBe(true)

    const docs = names.map((n) => cluster.replica(n).doc)
    const expected = docs[0].toString()
    for (const d of docs) {
      expect(d.toString(), `${d.agent} diverged on seed ${seed}`).toBe(expected)
      expect(d.pendingCount).toBe(0)
    }

    // Order independence: replaying every op into a fresh replica, shuffled
    // so most ops arrive before their dependencies, gives the same text.
    const ops = [...docs[0].ops()]
    for (let i = ops.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1))
      ;[ops[i], ops[j]] = [ops[j], ops[i]]
    }
    const fresh = new Doc('observer')
    fresh.apply(ops)
    expect(fresh.pendingCount).toBe(0)
    expect(fresh.toString()).toBe(expected)
  })
})

function pickTwo(names: string[], random: () => number): [string, string] {
  const i = Math.floor(random() * names.length)
  let j = Math.floor(random() * (names.length - 1))
  if (j >= i) j++
  return [names[i], names[j]]
}

function text(random: () => number): string {
  const len = random() < 0.8 ? 1 : 2 + Math.floor(random() * 8)
  let s = ''
  for (let i = 0; i < len; i++) s += String.fromCharCode(97 + Math.floor(random() * 26))
  return s
}
