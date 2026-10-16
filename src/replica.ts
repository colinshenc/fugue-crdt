import { Doc } from './doc.js'
import type { AgentId, Change, Op, VersionVector } from './types.js'

/**
 * The wire protocol between replicas.
 *
 * - `ops`: new operations, sent as soon as they happen (and relayed onward).
 * - `sync`: "here is my version vector". The receiver answers with every op
 *   the sender is missing, so lost or partitioned messages are repaired by the
 *   next sync round. This is anti-entropy: it needs no acknowledgements and no
 *   knowledge of which messages were lost.
 */
export type Message =
  | { type: 'ops'; ops: Op[] }
  | { type: 'sync'; vv: VersionVector; reply: boolean }

export interface ReplicaOptions {
  /** Forward newly received ops to the other peers (gossip). Default true. */
  relay?: boolean
}

/**
 * A Doc plus the replication protocol. Transport-agnostic: give it a `send`
 * function and feed it incoming messages with `receive`. The transport may
 * drop, duplicate, delay or reorder messages freely.
 */
export class Replica {
  readonly doc: Doc
  readonly peers: AgentId[]
  relay: boolean
  private readonly send: (to: AgentId, msg: Message) => void

  constructor(
    id: AgentId,
    peers: AgentId[],
    send: (to: AgentId, msg: Message) => void,
    options: ReplicaOptions = {},
  ) {
    this.doc = new Doc(id)
    this.peers = peers.filter((p) => p !== id)
    this.send = send
    this.relay = options.relay ?? true
  }

  get id(): AgentId {
    return this.doc.agent
  }

  insert(index: number, text: string): void {
    const op = this.doc.insert(index, text)
    if (op !== null) this.broadcast([op])
  }

  delete(index: number, length = 1): void {
    const ops = this.doc.delete(index, length)
    if (ops.length > 0) this.broadcast(ops)
  }

  /** Starts an anti-entropy round with every peer. */
  sync(): void {
    const vv = this.doc.version()
    for (const p of this.peers) this.send(p, { type: 'sync', vv, reply: false })
  }

  /** Handles a message from `from`. Returns the resulting text changes. */
  receive(from: AgentId, msg: Message): Change[] {
    if (msg.type === 'ops') {
      const { applied, changes } = this.doc.apply(msg.ops)
      if (this.relay && applied.length > 0) {
        for (const p of this.peers) if (p !== from) this.send(p, { type: 'ops', ops: applied })
      }
      return changes
    }

    const missing = this.doc.opsSince(msg.vv)
    if (missing.length > 0) this.send(from, { type: 'ops', ops: missing })
    // If they have ops we lack, ask for them in return (but don't loop).
    if (!msg.reply && hasOpsWeLack(msg.vv, this.doc.version())) {
      this.send(from, { type: 'sync', vv: this.doc.version(), reply: true })
    }
    return []
  }

  private broadcast(ops: Op[]): void {
    for (const p of this.peers) this.send(p, { type: 'ops', ops })
  }
}

function hasOpsWeLack(theirs: VersionVector, ours: VersionVector): boolean {
  for (const agent in theirs) if (theirs[agent] > (ours[agent] ?? 0)) return true
  return false
}
