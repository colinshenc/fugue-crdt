import { Cluster, Doc, type Message, type NetworkConfig, type Op } from '../../src/index.js'

export const PEERS = ['alice', 'bob', 'carol'] as const
export type Peer = (typeof PEERS)[number]
export const LINKS: [Peer, Peer][] = [
  ['alice', 'bob'],
  ['bob', 'carol'],
  ['alice', 'carol'],
]

/** One packet on the space-time diagram. */
export interface PacketRecord {
  id: number
  from: Peer
  to: Peer
  kind: 'ops' | 'sync'
  /** Number of characters carried, for ops packets. */
  chars: number
  sentAt: number
  deliverAt: number
  status: 'flight' | 'delivered' | 'lost' | 'cut'
  /** When the packet stopped (delivery or drop time). */
  endAt: number
  duplicate: boolean
}

export interface EditRecord {
  peer: Peer
  at: number
  kind: 'ins' | 'del'
}

export interface LinkInterval {
  a: Peer
  b: Peer
  from: number
  to: number | null
}

export const DEFAULT_TEXT = 'Shopping list\n- oat milk\n- coffee beans\n'

const HISTORY_MS = 60_000

/**
 * Owns the simulated cluster and everything the UI draws from it. Plain
 * TypeScript so the animation loop can drive it without React re-rendering
 * every frame.
 */
export class Playground {
  cluster!: Cluster
  packets: PacketRecord[] = []
  edits: EditRecord[] = []
  linkHistory: LinkInterval[] = []
  speed = 1
  paused = false
  scenario: string | null = null
  /** Bumped on any change the React tree shows. */
  version = 0
  /** Bumped per peer when its document changes. */
  docVersion: Record<Peer, number> = { alice: 0, bob: 0, carol: 0 }

  private timers: { at: number; run: () => void }[] = []
  private editorListeners = new Map<Peer, () => void>()
  private network: NetworkConfig = { latency: 700, jitter: 400, dropRate: 0, duplicateRate: 0 }
  private relay = true
  private syncInterval = 3000

  constructor() {
    this.reset()
  }

  get now(): number {
    return this.cluster.now
  }

  get networkConfig(): NetworkConfig {
    return this.network
  }

  get relayEnabled(): boolean {
    return this.relay
  }

  doc(peer: Peer): Doc {
    return this.cluster.replica(peer).doc
  }

  reset(text = DEFAULT_TEXT): void {
    this.timers = []
    this.scenario = null
    this.packets = []
    this.edits = []
    this.linkHistory = []
    this.cluster = new Cluster([...PEERS], {
      seed: Math.floor(Math.random() * 2 ** 31),
      network: this.network,
      syncInterval: this.syncInterval,
      relay: this.relay,
    })
    // Every replica starts from the same text, written by a neutral "seed" agent.
    if (text) {
      const seed = new Doc('seed')
      const ops: Op[] = [seed.insert(0, text)!]
      for (const p of PEERS) this.doc(p).apply(ops)
    }
    this.cluster.net.listener = (event) => this.record(event)
    this.cluster.onRemoteChange = (peer) => this.docChanged(peer as Peer)
    for (const p of PEERS) this.docChanged(p)
  }

  // ---------------------------------------------------------------------------
  // Editing

  /** Registers the editor for `peer`; called when its document changes underneath it. */
  onDocChange(peer: Peer, listener: () => void): () => void {
    this.editorListeners.set(peer, listener)
    return () => this.editorListeners.delete(peer)
  }

  insert(peer: Peer, index: number, text: string, fromEditor = false): void {
    if (!text) return
    this.cluster.replica(peer).insert(index, text)
    this.edits.push({ peer, at: this.now, kind: 'ins' })
    this.docChanged(peer, fromEditor)
  }

  delete(peer: Peer, index: number, length: number, fromEditor = false): void {
    if (length <= 0) return
    this.cluster.replica(peer).delete(index, length)
    this.edits.push({ peer, at: this.now, kind: 'del' })
    this.docChanged(peer, fromEditor)
  }

  private docChanged(peer: Peer, fromEditor = false): void {
    this.docVersion[peer]++
    this.version++
    if (!fromEditor) this.editorListeners.get(peer)?.()
  }

  // ---------------------------------------------------------------------------
  // Network

  isUp(a: Peer, b: Peer): boolean {
    return this.cluster.net.isUp(a, b)
  }

  /** True when the peer can't reach anyone. */
  isolated(peer: Peer): boolean {
    return PEERS.every((p) => p === peer || !this.isUp(peer, p))
  }

  setLink(a: Peer, b: Peer, up: boolean): void {
    if (this.isUp(a, b) === up) return
    this.cluster.setLink(a, b, up)
    if (!up) this.linkHistory.push({ a, b, from: this.now, to: null })
    else {
      const open = this.linkHistory.find((l) => l.to === null && sameLink(l, a, b))
      if (open) open.to = this.now
    }
    this.version++
  }

  isolate(peer: Peer): void {
    for (const p of PEERS) if (p !== peer) this.setLink(peer, p, false)
  }

  splitAll(): void {
    for (const [a, b] of LINKS) this.setLink(a, b, false)
  }

  heal(): void {
    for (const [a, b] of LINKS) this.setLink(a, b, true)
  }

  setNetwork(patch: Partial<NetworkConfig>): void {
    this.network = { ...this.network, ...patch }
    this.cluster.net.config = this.network
    this.version++
  }

  setRelay(on: boolean): void {
    this.relay = on
    for (const p of PEERS) this.cluster.replica(p).relay = on
    this.version++
  }

  /** Runs an anti-entropy round right now instead of waiting for the timer. */
  syncNow(): void {
    for (const p of PEERS) this.cluster.replica(p).sync()
  }

  // ---------------------------------------------------------------------------
  // Time

  /** Schedules `run` at simulated time now + `delay` ms. */
  after(delay: number, run: () => void): void {
    this.timers.push({ at: this.now + delay, run })
    this.timers.sort((x, y) => x.at - y.at)
  }

  /** Advances the simulation by `realMs` of wall-clock time. */
  tick(realMs: number): void {
    if (this.paused) return
    let remaining = realMs * this.speed
    while (this.timers.length > 0 && this.timers[0].at <= this.now + remaining) {
      const timer = this.timers.shift()!
      const dt = Math.max(0, timer.at - this.now)
      this.cluster.step(dt)
      remaining -= dt
      timer.run()
    }
    this.cluster.step(remaining)
    if (this.scenario !== null && this.timers.length === 0) {
      this.scenario = null
      this.version++
    }
    this.prune()
  }

  // ---------------------------------------------------------------------------
  // Status

  digest(peer: Peer): string {
    return fnv1a(this.doc(peer).toString())
  }

  /** Number of distinct document states across the three peers. */
  distinctStates(): number {
    return new Set(PEERS.map((p) => this.digest(p))).size
  }

  inFlight(): number {
    return this.cluster.net.inFlight.length
  }

  /**
   * Every replica has applied the same ops. Packets may still be in flight,
   * but they can only carry ops everyone already has.
   */
  converged(): boolean {
    return this.cluster.converged()
  }

  // ---------------------------------------------------------------------------

  private record(event: import('../../src/index.js').NetworkEvent<Message>): void {
    const { packet } = event
    if (event.type === 'send') {
      this.packets.push({
        id: packet.id,
        from: packet.from as Peer,
        to: packet.to as Peer,
        kind: packet.msg.type,
        chars: packet.msg.type === 'ops' ? countChars(packet.msg.ops) : 0,
        sentAt: packet.sentAt,
        deliverAt: packet.deliverAt,
        status: 'flight',
        endAt: packet.deliverAt,
        duplicate: packet.duplicate,
      })
    } else {
      const rec = this.findPacket(packet.id)
      if (rec) {
        rec.status = event.type === 'deliver' ? 'delivered' : event.reason === 'loss' ? 'lost' : 'cut'
        rec.endAt = this.cluster.net.now
      }
    }
    this.version++
  }

  private findPacket(id: number): PacketRecord | undefined {
    for (let i = this.packets.length - 1; i >= 0; i--) if (this.packets[i].id === id) return this.packets[i]
    return undefined
  }

  private prune(): void {
    const cutoff = this.now - HISTORY_MS
    if (this.packets.length > 0 && this.packets[0].endAt < cutoff) {
      this.packets = this.packets.filter((p) => p.endAt >= cutoff || p.status === 'flight')
    }
    if (this.edits.length > 0 && this.edits[0].at < cutoff) this.edits = this.edits.filter((e) => e.at >= cutoff)
    this.linkHistory = this.linkHistory.filter((l) => l.to === null || l.to >= cutoff)
  }
}

function sameLink(l: LinkInterval, a: Peer, b: Peer): boolean {
  return (l.a === a && l.b === b) || (l.a === b && l.b === a)
}

function countChars(ops: Op[]): number {
  let n = 0
  for (const op of ops) n += op.type === 'ins' ? op.text.length : op.len
  return n
}

/** 32-bit FNV-1a, shown as a short hex digest of each replica's text. */
export function fnv1a(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0').slice(0, 6)
}
