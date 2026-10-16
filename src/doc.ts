import type {
  AgentId,
  Change,
  DeleteOp,
  Id,
  InsertOp,
  NodeView,
  Op,
  Side,
  Span,
  VersionVector,
} from './types.js'

/**
 * A node of the Fugue tree. Each node is one character (or the root).
 *
 * The document is the in-order traversal of the tree: left children (sorted),
 * the node itself, then right children (sorted). Deleted characters stay in
 * the tree as tombstones so concurrent ops can still reference them.
 */
interface Node {
  /** Index into Doc.agents. -1 for the root. */
  agent: number
  seq: number
  char: string
  deleted: boolean
  parent: Node | null
  side: Side
  /**
   * Children are kept as a linked list per side, sorted by id: the first
   * child on each side, plus `next` for the following sibling. Nearly every
   * node has at most one child, so this is much leaner than an array each.
   */
  firstLeft: Node | null
  firstRight: Node | null
  next: Node | null
  /** The chunk of the flat list holding this node. null for the root. */
  chunk: Chunk | null
}

/**
 * The tree is also stored flattened, in document order, as a list of chunks.
 * The flat list makes "find the i-th visible character" cheap without walking
 * the tree, which can be as deep as the document is long (typing builds a
 * chain of right children).
 */
class Chunk {
  /** Position in Doc.chunks, kept up to date when chunks split. */
  index: number
  nodes: Node[]
  /** Number of non-deleted nodes in this chunk. */
  visible: number

  constructor(index: number, nodes: Node[]) {
    this.index = index
    this.nodes = nodes
    this.visible = 0
    for (const n of nodes) {
      n.chunk = this
      if (!n.deleted) this.visible++
    }
  }
}

const MAX_CHUNK = 512
const SPLIT_SIZE = MAX_CHUNK / 2

const WAIT = 0
const DUPLICATE = 1
const APPLIED = 2

export interface ApplyResult {
  /** Ops that were new to this replica, after trimming any already-seen prefix. */
  applied: Op[]
  /** Edits to the visible text, in the order they happened. */
  changes: Change[]
}

/**
 * A collaborative plain-text document using the Fugue list CRDT
 * (Weidner & Kleppmann, "The Art of the Fugue", 2023).
 *
 * Local edits return ops; send those to other replicas and pass them to
 * `apply` there. `apply` accepts ops in any order, any number of times:
 * ops whose dependencies haven't arrived yet are buffered, and duplicates are
 * ignored. Every replica that has applied the same set of ops has the same text.
 */
export class Doc {
  readonly agent: AgentId

  private readonly agents: AgentId[] = []
  private readonly agentIndex = new Map<AgentId, number>()
  /**
   * byAgent[a][seq] is the node agent `a` inserted with that seq, or null when
   * the seq was used by a delete. The array length is the next expected seq.
   */
  private readonly byAgent: (Node | null)[][] = []
  private readonly root: Node
  private readonly chunks: Chunk[]
  private readonly log: Op[] = []
  private pending: Op[] = []
  private visibleLength = 0
  private readonly me: number

  /**
   * Seek cache: the visible index at which chunk `cacheChunk` starts.
   * Invariant: cacheStart === sum of chunks[0..cacheChunk).visible.
   */
  private cacheChunk = 0
  private cacheStart = 0

  constructor(agent: AgentId) {
    this.agent = agent
    this.me = this.agentId(agent)
    this.root = {
      agent: -1,
      seq: -1,
      char: '',
      deleted: true,
      parent: null,
      side: 'R',
      firstLeft: null,
      firstRight: null,
      next: null,
      chunk: null,
    }
    this.chunks = [new Chunk(0, [])]
  }

  /** Number of visible characters. */
  get length(): number {
    return this.visibleLength
  }

  /** Ops waiting for their dependencies to arrive. */
  get pendingCount(): number {
    return this.pending.length
  }

  /** Total nodes in the tree, including tombstones. */
  get nodeCount(): number {
    let n = 0
    for (const c of this.chunks) n += c.nodes.length
    return n
  }

  toString(): string {
    const out: string[] = []
    for (const c of this.chunks) {
      for (const n of c.nodes) if (!n.deleted) out.push(n.char)
    }
    return out.join('')
  }

  // ---------------------------------------------------------------------------
  // Local edits

  /** Inserts `text` so that its first character ends up at `index`. */
  insert(index: number, text: string): InsertOp | null {
    if (index < 0 || index > this.visibleLength) {
      throw new RangeError(`insert index ${index} out of range 0..${this.visibleLength}`)
    }
    if (text.length === 0) return null

    // Fugue's insert rule. leftOrigin is the visible character before the
    // cursor (or the root). If it has no right children, the new character
    // becomes its right child. Otherwise it becomes the left child of the
    // node right after leftOrigin, tombstones included. That node is the
    // leftmost descendant of leftOrigin's right subtree, so it has no left
    // children yet and the new node lands directly between the two.
    let leftOrigin: Node
    let chunkIndex: number
    let offset: number // where the new nodes go in chunks[chunkIndex]
    if (index === 0) {
      leftOrigin = this.root
      chunkIndex = 0
      offset = 0
    } else {
      const [ci, off] = this.seek(index - 1)
      leftOrigin = this.chunks[ci].nodes[off]
      chunkIndex = ci
      offset = off + 1
    }

    let parent: Node
    let side: Side
    if (leftOrigin.firstRight === null) {
      parent = leftOrigin
      side = 'R'
    } else {
      parent = this.nodeAfter(chunkIndex, offset)
      side = 'L'
    }

    const seq = this.byAgent[this.me].length
    const nodes = this.createRun(this.me, seq, text, parent, side)
    // The new node is parent's only child on that side, so no sorting is needed.
    if (side === 'R') parent.firstRight = nodes[0]
    else parent.firstLeft = nodes[0]
    this.placeNodes(chunkIndex, offset, nodes)

    const op: InsertOp = {
      type: 'ins',
      id: [this.agent, seq],
      parent: parent === this.root ? null : this.idOf(parent),
      side,
      text,
    }
    this.appendLog(op)
    return op
  }

  /** Deletes `length` visible characters starting at `index`. */
  delete(index: number, length = 1): DeleteOp[] {
    if (length <= 0) return []
    if (index < 0 || index + length > this.visibleLength) {
      throw new RangeError(`delete range ${index}+${length} out of range 0..${this.visibleLength}`)
    }
    const ops: DeleteOp[] = []
    const mine = this.byAgent[this.me]
    let [ci, off] = this.seek(index)
    let remaining = length
    let run: DeleteOp | null = null
    while (remaining > 0) {
      const chunk = this.chunks[ci]
      const node = chunk.nodes[off]
      if (!node.deleted) {
        node.deleted = true
        chunk.visible--
        this.visibleLength--
        remaining--
        // Characters typed in one go have consecutive ids, so a selection
        // usually collapses into a handful of ranges.
        if (run !== null && run.target[0] === this.agents[node.agent] && run.target[1] + run.len === node.seq) {
          run.len++
        } else {
          run = { type: 'del', id: [this.agent, mine.length], target: this.idOf(node), len: 1 }
          ops.push(run)
        }
        mine.push(null)
      }
      if (++off === chunk.nodes.length) {
        ci++
        off = 0
      }
    }
    for (const op of ops) this.appendLog(op)
    return ops
  }

  // ---------------------------------------------------------------------------
  // Remote ops

  /**
   * Applies ops from other replicas (or this one; duplicates are skipped).
   * Ops may arrive in any order. Ones whose dependencies are missing wait in
   * a buffer and are retried on every later call.
   */
  apply(ops: readonly Op[]): ApplyResult {
    const result: ApplyResult = { applied: [], changes: [] }
    let queue: Op[] = this.pending.length > 0 ? [...this.pending, ...ops] : (ops as Op[])
    this.pending = []
    while (queue.length > 0) {
      const waiting: Op[] = []
      let progress = false
      for (const op of queue) {
        const status = this.tryApply(op, result)
        if (status === WAIT) waiting.push(op)
        else if (status === APPLIED) progress = true
      }
      queue = waiting
      if (!progress) break
    }
    this.pending = queue
    return result
  }

  private tryApply(op: Op, result: ApplyResult): number {
    const [agentName, seq] = op.id
    const a = this.agentId(agentName)
    const next = this.byAgent[a].length

    if (op.type === 'del') {
      const end = seq + op.len
      if (end <= next) return DUPLICATE
      if (seq > next) return WAIT
      const [targetAgent, targetSeq] = op.target
      const targets: Node[] = []
      for (let i = 0; i < op.len; i++) {
        const t = this.lookup([targetAgent, targetSeq + i])
        if (t === null) return WAIT
        targets.push(t)
      }
      // Deleting is idempotent, so a range we've partly seen is simply
      // applied again in full.
      for (let s = next; s < end; s++) this.byAgent[a].push(null)
      for (const target of targets) {
        if (target.deleted) continue
        const index = this.visibleIndexOf(target)
        target.deleted = true
        target.chunk!.visible--
        this.visibleLength--
        result.changes.push({ type: 'delete', index, length: 1 })
      }
      this.appendLog(op)
      result.applied.push(op)
      return APPLIED
    }

    if (seq + op.text.length <= next) return DUPLICATE
    if (seq > next) return WAIT

    // We may already have a prefix of this run (e.g. a retransmission that
    // overlaps an earlier one). Keep only the new suffix: its first character
    // is the right child of the last character we already have.
    let applied: InsertOp = op
    if (seq < next) {
      applied = {
        type: 'ins',
        id: [agentName, next],
        parent: [agentName, next - 1],
        side: 'R',
        text: op.text.slice(next - seq),
      }
    }
    const parent = applied.parent === null ? this.root : this.lookup(applied.parent)
    if (parent === null) return WAIT

    const change = this.integrate(a, next, parent, applied.side, applied.text)
    this.appendLog(applied)
    result.applied.push(applied)
    result.changes.push(change)
    return APPLIED
  }

  /** Adds a remote run to the tree and the flat list. */
  private integrate(a: number, seq: number, parent: Node, side: Side, text: string): Change {
    const nodes = this.createRun(a, seq, text, parent, side)
    const first = nodes[0]

    // Same-side siblings are ordered by id. Find where `first` goes.
    let prev: Node | null = null
    let sibling = side === 'L' ? parent.firstLeft : parent.firstRight
    while (sibling !== null && this.compare(sibling, first) < 0) {
      prev = sibling
      sibling = sibling.next
    }

    // Where does the new subtree go in the flat list?
    //  - before the subtree of the next sibling, if there is one;
    //  - otherwise, for a right child: after everything in parent's subtree;
    //  - otherwise, for a left child: just before the parent.
    let anchor: Node
    let before: boolean
    if (sibling !== null) {
      anchor = leftmost(sibling)
      before = true
    } else if (side === 'R') {
      anchor = rightmost(parent)
      before = false
    } else {
      anchor = parent
      before = true
    }
    first.next = sibling
    if (prev !== null) prev.next = first
    else if (side === 'L') parent.firstLeft = first
    else parent.firstRight = first

    let chunkIndex: number
    let offset: number
    if (anchor === this.root) {
      // Only happens when the root has no children, i.e. the list is empty.
      chunkIndex = 0
      offset = 0
    } else {
      const chunk = anchor.chunk!
      chunkIndex = chunk.index
      offset = chunk.nodes.indexOf(anchor) + (before ? 0 : 1)
    }
    this.placeNodes(chunkIndex, offset, nodes)
    return { type: 'insert', index: this.visibleIndexOf(first), text, agent: this.agents[a] }
  }

  // ---------------------------------------------------------------------------
  // Sync helpers

  /** How many ops from each agent this replica has applied. */
  version(): VersionVector {
    const vv: VersionVector = {}
    for (let a = 0; a < this.agents.length; a++) {
      if (this.byAgent[a].length > 0) vv[this.agents[a]] = this.byAgent[a].length
    }
    return vv
  }

  /** Every op this replica has that a replica at version `vv` is missing. */
  opsSince(vv: VersionVector): Op[] {
    const out: Op[] = []
    for (const op of this.log) {
      const [agentName, seq] = op.id
      const have = vv[agentName] ?? 0
      if (op.type === 'del') {
        // A partly-seen range is sent whole; the receiver skips what it has.
        if (seq + op.len > have) out.push(op)
        continue
      }
      if (seq + op.text.length <= have) continue
      if (seq >= have) {
        out.push(op)
      } else {
        out.push({
          type: 'ins',
          id: [agentName, have],
          parent: [agentName, have - 1],
          side: 'R',
          text: op.text.slice(have - seq),
        })
      }
    }
    return out
  }

  /** All ops this replica has applied, in a causally valid order. */
  ops(): readonly Op[] {
    return this.log
  }

  // ---------------------------------------------------------------------------
  // Cursors and inspection

  /**
   * The id of the character just before visible position `index`, or null at
   * the start of the document. Store this instead of a number to keep a cursor
   * in place while remote edits arrive.
   */
  anchorAt(index: number): Id | null {
    if (index <= 0) return null
    const [ci, off] = this.seek(Math.min(index, this.visibleLength) - 1)
    return this.idOf(this.chunks[ci].nodes[off])
  }

  /** Turns an anchor from `anchorAt` back into a visible position. */
  positionOf(anchor: Id | null): number {
    if (anchor === null) return 0
    const node = this.lookup(anchor)
    if (node === null) return 0
    // A deleted anchor leaves the cursor where the character used to be.
    return this.visibleIndexOf(node) + (node.deleted ? 0 : 1)
  }

  /** Every node in document order, tombstones included. */
  nodes(): NodeView[] {
    const out: NodeView[] = []
    for (const c of this.chunks) {
      for (const n of c.nodes) {
        out.push({
          id: this.idOf(n),
          char: n.char,
          deleted: n.deleted,
          parent: n.parent === this.root ? null : this.idOf(n.parent!),
          side: n.side,
        })
      }
    }
    return out
  }

  /** The visible text split into runs by author. */
  spans(): Span[] {
    const out: Span[] = []
    let agent = -1
    let buf: string[] = []
    for (const c of this.chunks) {
      for (const n of c.nodes) {
        if (n.deleted) continue
        if (n.agent !== agent) {
          if (buf.length > 0) out.push({ agent: this.agents[agent], text: buf.join('') })
          agent = n.agent
          buf = []
        }
        buf.push(n.char)
      }
    }
    if (buf.length > 0) out.push({ agent: this.agents[agent], text: buf.join('') })
    return out
  }

  // ---------------------------------------------------------------------------
  // Internals

  private agentId(name: AgentId): number {
    let a = this.agentIndex.get(name)
    if (a === undefined) {
      a = this.agents.length
      this.agents.push(name)
      this.agentIndex.set(name, a)
      this.byAgent.push([])
    }
    return a
  }

  /**
   * Appends to the op log, merging with the previous entry when the two are
   * one continuous run: a word typed keystroke by keystroke becomes a single
   * insert, and a run of backspaces a single delete. The merged op means
   * exactly the same thing, so the log, and everything sent from it during
   * sync, stays small. Ops already handed to callers are never mutated.
   */
  private appendLog(op: Op): void {
    const last = this.log[this.log.length - 1]
    if (last !== undefined && last.id[0] === op.id[0] && last.id[1] + opLength(last) === op.id[1]) {
      if (
        last.type === 'ins' &&
        op.type === 'ins' &&
        op.side === 'R' &&
        op.parent !== null &&
        op.parent[0] === op.id[0] &&
        op.parent[1] === op.id[1] - 1
      ) {
        this.log[this.log.length - 1] = { ...last, text: last.text + op.text }
        return
      }
      if (last.type === 'del' && op.type === 'del' && last.target[0] === op.target[0]) {
        if (op.target[1] === last.target[1] + last.len) {
          this.log[this.log.length - 1] = { ...last, len: last.len + op.len }
          return
        }
        if (op.target[1] + op.len === last.target[1]) {
          this.log[this.log.length - 1] = { ...last, target: op.target, len: last.len + op.len }
          return
        }
      }
    }
    this.log.push(op)
  }

  private idOf(n: Node): Id {
    return [this.agents[n.agent], n.seq]
  }

  private lookup(id: Id): Node | null {
    const a = this.agentIndex.get(id[0])
    if (a === undefined) return null
    return this.byAgent[a][id[1]] ?? null
  }

  /** Sibling order: by agent name, then seq. */
  private compare(x: Node, y: Node): number {
    if (x.agent !== y.agent) return this.agents[x.agent] < this.agents[y.agent] ? -1 : 1
    return x.seq - y.seq
  }

  /** Builds a run: the first node hangs off `parent`, each later one off the previous. */
  private createRun(a: number, seq: number, text: string, parent: Node, side: Side): Node[] {
    const byAgent = this.byAgent[a]
    const nodes: Node[] = new Array(text.length)
    let prev = parent
    for (let i = 0; i < text.length; i++) {
      const n: Node = {
        agent: a,
        seq: seq + i,
        char: text[i],
        deleted: false,
        parent: prev,
        side: i === 0 ? side : 'R',
        firstLeft: null,
        firstRight: null,
        next: null,
        chunk: null,
      }
      if (i > 0) prev.firstRight = n
      nodes[i] = n
      byAgent.push(n)
      prev = n
    }
    return nodes
  }

  /** The node at flat position (chunkIndex, offset), moving to the next chunk if needed. */
  private nodeAfter(chunkIndex: number, offset: number): Node {
    let ci = chunkIndex
    let off = offset
    while (off >= this.chunks[ci].nodes.length) {
      off -= this.chunks[ci].nodes.length
      ci++
    }
    return this.chunks[ci].nodes[off]
  }

  /** Inserts nodes into the flat list at chunks[chunkIndex].nodes[offset]. */
  private placeNodes(chunkIndex: number, offset: number, nodes: Node[]): void {
    const chunk = this.chunks[chunkIndex]
    if (nodes.length === 1) chunk.nodes.splice(offset, 0, nodes[0])
    else chunk.nodes.splice(offset, 0, ...nodes)
    for (const n of nodes) n.chunk = chunk
    chunk.visible += nodes.length
    this.visibleLength += nodes.length
    // Keep the seek cache valid: chunks after this one now start later.
    if (chunkIndex < this.cacheChunk) this.cacheStart += nodes.length
    if (chunk.nodes.length > MAX_CHUNK) this.split(chunkIndex)
  }

  private split(ci: number): void {
    const chunk = this.chunks[ci]
    const all = chunk.nodes
    const extra: Chunk[] = []
    for (let i = SPLIT_SIZE; i < all.length; i += SPLIT_SIZE) {
      extra.push(new Chunk(ci + 1 + extra.length, all.slice(i, i + SPLIT_SIZE)))
    }
    chunk.nodes = all.slice(0, SPLIT_SIZE)
    chunk.visible = 0
    for (const n of chunk.nodes) if (!n.deleted) chunk.visible++
    this.chunks.splice(ci + 1, 0, ...extra)
    for (let i = ci + 1 + extra.length; i < this.chunks.length; i++) this.chunks[i].index = i
    // The visible start of chunks at or before ci is unchanged.
    if (this.cacheChunk > ci) this.cacheChunk += extra.length
  }

  /**
   * Finds the visible character at `index`. Returns [chunk index, offset].
   * Edits tend to cluster, so we start from the chunk we used last time.
   */
  private seek(index: number): [number, number] {
    let ci = this.cacheChunk
    let start = this.cacheStart
    const chunks = this.chunks
    while (index < start) {
      ci--
      start -= chunks[ci].visible
    }
    while (index >= start + chunks[ci].visible) {
      start += chunks[ci].visible
      ci++
    }
    this.cacheChunk = ci
    this.cacheStart = start

    const nodes = chunks[ci].nodes
    let remaining = index - start
    for (let off = 0; ; off++) {
      if (!nodes[off].deleted) {
        if (remaining === 0) return [ci, off]
        remaining--
      }
    }
  }

  /** Number of visible characters before `node` in the document. */
  private visibleIndexOf(node: Node): number {
    const chunk = node.chunk!
    const ci = chunk.index
    // Walk from the cached chunk to this one to find where it starts.
    let c = this.cacheChunk
    let start = this.cacheStart
    while (c < ci) start += this.chunks[c++].visible
    while (c > ci) start -= this.chunks[--c].visible
    this.cacheChunk = ci
    this.cacheStart = start

    let index = start
    for (const n of chunk.nodes) {
      if (n === node) return index
      if (!n.deleted) index++
    }
    throw new Error('node missing from its chunk')
  }
}

/** How many sequence numbers an op uses. */
function opLength(op: Op): number {
  return op.type === 'ins' ? op.text.length : op.len
}

/** The first node in `n`'s subtree: keep taking the first left child. */
function leftmost(n: Node): Node {
  while (n.firstLeft !== null) n = n.firstLeft
  return n
}

/** The last node in `n`'s subtree: keep taking the last right child. */
function rightmost(n: Node): Node {
  for (;;) {
    let c = n.firstRight
    if (c === null) return n
    while (c.next !== null) c = c.next
    n = c
  }
}
