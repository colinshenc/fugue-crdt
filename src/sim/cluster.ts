import { Replica, type Message } from '../replica.js'
import type { AgentId, Change } from '../types.js'
import { SimNetwork, type NetworkConfig } from './network.js'

export interface ClusterOptions {
  seed?: number
  network?: Partial<NetworkConfig>
  /** Virtual ms between anti-entropy rounds. Default 1000. */
  syncInterval?: number
  relay?: boolean
}

/**
 * A set of replicas wired together over a simulated network. The fuzz tests
 * and the browser playground both run on this, so anything you can do by
 * clicking in the playground, a test can do from a seed.
 */
export class Cluster {
  readonly net: SimNetwork<Message>
  readonly replicas: Map<AgentId, Replica> = new Map()
  syncInterval: number
  /** Called whenever a replica's text changes because of a remote op. */
  onRemoteChange: ((replica: AgentId, changes: Change[]) => void) | null = null

  private nextSync: number

  constructor(names: AgentId[], options: ClusterOptions = {}) {
    this.net = new SimNetwork<Message>(options.network, options.seed ?? 1)
    this.syncInterval = options.syncInterval ?? 1000
    this.nextSync = this.syncInterval
    for (const name of names) {
      const replica = new Replica(name, names, (to, msg) => this.net.send(name, to, msg), {
        relay: options.relay,
      })
      this.replicas.set(name, replica)
      this.net.register(name, (from, msg) => {
        const changes = replica.receive(from, msg)
        if (changes.length > 0) this.onRemoteChange?.(name, changes)
      })
    }
  }

  get names(): AgentId[] {
    return [...this.replicas.keys()]
  }

  get now(): number {
    return this.net.now
  }

  replica(name: AgentId): Replica {
    const r = this.replicas.get(name)
    if (r === undefined) throw new Error(`no replica named ${name}`)
    return r
  }

  setLink(a: AgentId, b: AgentId, up: boolean): void {
    const wasUp = this.net.isUp(a, b)
    this.net.setLink(a, b, up)
    // Reconnecting triggers an immediate sync instead of waiting for the next round.
    if (up && !wasUp) {
      this.replica(a).sync()
      this.replica(b).sync()
    }
  }

  /** Cuts every link between different groups and connects everything within a group. */
  partition(groups: AgentId[][]): void {
    const groupOf = new Map<AgentId, number>()
    groups.forEach((g, i) => g.forEach((n) => groupOf.set(n, i)))
    const names = this.names
    for (let i = 0; i < names.length; i++) {
      for (let j = i + 1; j < names.length; j++) {
        this.setLink(names[i], names[j], groupOf.get(names[i]) === groupOf.get(names[j]))
      }
    }
  }

  heal(): void {
    this.partition([this.names])
  }

  /** Advances virtual time by `dt` ms, running anti-entropy rounds as they come due. */
  step(dt: number): void {
    const target = this.net.now + dt
    while (this.nextSync <= target) {
      this.net.runUntil(this.nextSync)
      for (const r of this.replicas.values()) r.sync()
      this.nextSync += this.syncInterval
    }
    this.net.runUntil(target)
  }

  /** True when every replica has the same ops and nothing is buffered. */
  converged(): boolean {
    const [first, ...rest] = [...this.replicas.values()]
    const vv = JSON.stringify(sortedVersion(first))
    if (first.doc.pendingCount > 0) return false
    return rest.every(
      (r) => r.doc.pendingCount === 0 && JSON.stringify(sortedVersion(r)) === vv,
    )
  }

  /** Runs until the cluster has converged. Returns false if it gave up. */
  settle(maxTime = 600_000): boolean {
    const deadline = this.net.now + maxTime
    while (this.net.now < deadline) {
      if (this.net.inFlight.length === 0 && this.converged()) return true
      this.step(this.syncInterval / 4)
    }
    return this.net.inFlight.length === 0 && this.converged()
  }
}

function sortedVersion(r: Replica): [string, number][] {
  return Object.entries(r.doc.version()).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
}
