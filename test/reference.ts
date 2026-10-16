/**
 * A deliberately naive Fugue, transcribed as directly as possible from the
 * tree algorithm in Weidner & Kleppmann's paper: one char per op, nodes hold
 * subtree sizes, and every lookup walks the tree. It's slow, but it's short
 * enough to check by eye, so the optimised Doc is tested against it.
 */
import type { Id, Op, Side } from '../src/types.js'

interface RNode {
  id: Id
  char: string
  deleted: boolean
  parent: RNode | null
  side: Side
  left: RNode[]
  right: RNode[]
  /** Visible characters in this subtree. */
  size: number
}

export interface CharOp {
  type: 'ins'
  id: Id
  parent: Id | null
  side: Side
  char: string
}

export interface CharDel {
  type: 'del'
  target: Id
}

/** Splits Doc ops into one-char ops, the form the paper's algorithm uses. */
export function toCharOps(op: Op): (CharOp | CharDel)[] {
  if (op.type === 'del') {
    const [agent, seq] = op.target
    return Array.from({ length: op.len }, (_, i) => ({ type: 'del' as const, target: [agent, seq + i] as const }))
  }
  const [agent, seq] = op.id
  return [...op.text].map((char, i) => ({
    type: 'ins' as const,
    id: [agent, seq + i] as const,
    parent: i === 0 ? op.parent : ([agent, seq + i - 1] as const),
    side: i === 0 ? op.side : ('R' as const),
    char,
  }))
}

const key = (id: Id) => `${id[0]}:${id[1]}`

export class ReferenceFugue {
  readonly root: RNode = {
    id: ['', -1],
    char: '',
    deleted: true,
    parent: null,
    side: 'R',
    left: [],
    right: [],
    size: 0,
  }
  private readonly byId = new Map<string, RNode>([[key(this.root.id), this.root]])

  has(id: Id | null): boolean {
    return id === null || this.byId.has(key(id))
  }

  /** What the paper's insert generator would choose for an insert at `index`. */
  originsFor(index: number): { parent: Id | null; side: Side } {
    const leftOrigin = index === 0 ? this.root : this.at(index - 1)
    if (leftOrigin.right.length === 0) {
      return { parent: leftOrigin === this.root ? null : leftOrigin.id, side: 'R' }
    }
    let rightOrigin = leftOrigin.right[0]
    while (rightOrigin.left.length > 0) rightOrigin = rightOrigin.left[0]
    return { parent: rightOrigin.id, side: 'L' }
  }

  apply(op: CharOp | CharDel): void {
    if (op.type === 'del') {
      const node = this.byId.get(key(op.target))!
      if (node.deleted) return
      node.deleted = true
      for (let n: RNode | null = node; n !== null; n = n.parent) n.size--
      return
    }
    if (this.byId.has(key(op.id))) return
    const parent = op.parent === null ? this.root : this.byId.get(key(op.parent))!
    const node: RNode = {
      id: op.id,
      char: op.char,
      deleted: false,
      parent,
      side: op.side,
      left: [],
      right: [],
      size: 0,
    }
    const siblings = op.side === 'L' ? parent.left : parent.right
    let i = 0
    while (i < siblings.length && less(siblings[i].id, node.id)) i++
    siblings.splice(i, 0, node)
    this.byId.set(key(node.id), node)
    for (let n: RNode | null = node; n !== null; n = n.parent) n.size++
  }

  /** The visible node at `index`. */
  at(index: number): RNode {
    let node = this.root
    let remaining = index
    outer: for (;;) {
      for (const c of node.left) {
        if (remaining < c.size) {
          node = c
          continue outer
        }
        remaining -= c.size
      }
      if (!node.deleted) {
        if (remaining === 0) return node
        remaining--
      }
      for (const c of node.right) {
        if (remaining < c.size) {
          node = c
          continue outer
        }
        remaining -= c.size
      }
      throw new Error(`index ${index} out of range`)
    }
  }

  toString(): string {
    const out: string[] = []
    // In-order traversal with an explicit stack: chains can be deep.
    const stack: [RNode, number][] = [[this.root, 0]]
    while (stack.length > 0) {
      const top = stack[stack.length - 1]
      const [node, state] = top
      const nl = node.left.length
      if (state < nl) {
        top[1]++
        stack.push([node.left[state], 0])
      } else if (state === nl) {
        top[1]++
        if (!node.deleted) out.push(node.char)
      } else if (state - nl - 1 < node.right.length) {
        top[1]++
        stack.push([node.right[state - nl - 1], 0])
      } else {
        stack.pop()
      }
    }
    return out.join('')
  }
}

function less(a: Id, b: Id): boolean {
  return a[0] !== b[0] ? a[0] < b[0] : a[1] < b[1]
}
