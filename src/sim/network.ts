/**
 * A deterministic, seeded network simulator. Time is virtual (milliseconds),
 * so a test can simulate minutes of flaky networking in a few milliseconds and
 * replay any failure exactly from its seed.
 *
 * Packets can be delayed (latency + random jitter, which also reorders them),
 * lost, duplicated, or dropped because the link between two nodes is cut.
 */

export interface NetworkConfig {
  /** Base one-way delay in ms. */
  latency: number
  /** Extra random delay in ms, uniform in [0, jitter). Causes reordering. */
  jitter: number
  /** Probability that a packet is lost in transit. */
  dropRate: number
  /** Probability that a packet is delivered twice. */
  duplicateRate: number
}

export const DEFAULT_NETWORK: NetworkConfig = {
  latency: 50,
  jitter: 0,
  dropRate: 0,
  duplicateRate: 0,
}

export interface Packet<M> {
  id: number
  from: string
  to: string
  msg: M
  sentAt: number
  deliverAt: number
  /** Decided at send time so the outcome depends only on the seed. */
  lost: boolean
  duplicate: boolean
}

export type NetworkEvent<M> =
  | { type: 'send'; packet: Packet<M> }
  | { type: 'deliver'; packet: Packet<M> }
  | { type: 'drop'; packet: Packet<M>; reason: 'partition' | 'loss' }

/** mulberry32: a tiny, fast, seedable PRNG. */
export function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const linkKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`)

export class SimNetwork<M> {
  now = 0
  config: NetworkConfig
  readonly random: () => number
  /** Called for every send, delivery and drop. Used by the playground to animate packets. */
  listener: ((event: NetworkEvent<M>) => void) | null = null

  private nextId = 0
  private queue: Packet<M>[] = [] // sorted by (deliverAt, id)
  private readonly cut = new Set<string>()
  private readonly handlers = new Map<string, (from: string, msg: M) => void>()

  constructor(config: Partial<NetworkConfig> = {}, seed = 1) {
    this.config = { ...DEFAULT_NETWORK, ...config }
    this.random = rng(seed)
  }

  register(node: string, handler: (from: string, msg: M) => void): void {
    this.handlers.set(node, handler)
  }

  isUp(a: string, b: string): boolean {
    return !this.cut.has(linkKey(a, b))
  }

  setLink(a: string, b: string, up: boolean): void {
    if (up) this.cut.delete(linkKey(a, b))
    else this.cut.add(linkKey(a, b))
  }

  get inFlight(): readonly Packet<M>[] {
    return this.queue
  }

  send(from: string, to: string, msg: M): void {
    const { latency, jitter, dropRate, duplicateRate } = this.config
    const copies = this.random() < duplicateRate ? 2 : 1
    for (let i = 0; i < copies; i++) {
      const packet: Packet<M> = {
        id: this.nextId++,
        from,
        to,
        msg,
        sentAt: this.now,
        deliverAt: this.now + latency + this.random() * jitter,
        lost: this.random() < dropRate,
        duplicate: i > 0,
      }
      this.listener?.({ type: 'send', packet })
      if (!this.isUp(from, to)) {
        this.listener?.({ type: 'drop', packet, reason: 'partition' })
        continue
      }
      this.enqueue(packet)
    }
  }

  /** Delivers, in order, every packet due at or before `time`. */
  runUntil(time: number): void {
    while (this.queue.length > 0 && this.queue[0].deliverAt <= time) {
      const packet = this.queue.shift()!
      this.now = Math.max(this.now, packet.deliverAt)
      if (!this.isUp(packet.from, packet.to)) {
        this.listener?.({ type: 'drop', packet, reason: 'partition' })
      } else if (packet.lost) {
        this.listener?.({ type: 'drop', packet, reason: 'loss' })
      } else {
        this.listener?.({ type: 'deliver', packet })
        this.handlers.get(packet.to)?.(packet.from, packet.msg)
      }
    }
    this.now = Math.max(this.now, time)
  }

  private enqueue(packet: Packet<M>): void {
    // Binary search for the insertion point. Ties go in send order.
    let lo = 0
    let hi = this.queue.length
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (this.queue[mid].deliverAt <= packet.deliverAt) lo = mid + 1
      else hi = mid
    }
    this.queue.splice(lo, 0, packet)
  }
}
