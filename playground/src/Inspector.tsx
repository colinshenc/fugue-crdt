import { useMemo } from 'react'
import type { Id, NodeView, Op } from '../../src/index.js'
import type { Peer, Playground } from './controller.js'

const MAX_NODES = 240
const DX = 17
const DY = 19
const PAD = 14

const key = (id: Id) => `${id[0]}:${id[1]}`
const short = (id: Id | null) => (id === null ? 'root' : `${id[0][0]}${id[1]}`)
const glyph = (c: string) => (c === ' ' ? '·' : c === '\n' ? '↵' : c)

/**
 * The selected peer's Fugue tree. x is the node's position in the document
 * (the tree's in-order traversal), y is its depth, so reading the nodes left
 * to right spells the text, tombstones included.
 */
export function TreeView({ pg, peer, docVersion }: { pg: Playground; peer: Peer; docVersion: number }) {
  const layout = useMemo(() => {
    const all = pg.doc(peer).nodes()
    const nodes = all.slice(0, MAX_NODES)
    const depth = new Map<string, number>()
    const byKey = new Map<string, NodeView>(all.map((n) => [key(n.id), n]))
    const depthOf = (n: NodeView): number => {
      // Walk up iteratively: typing builds parent chains as long as the text.
      const chain: NodeView[] = []
      let cur: NodeView | undefined = n
      let base = 0
      while (cur) {
        const known = depth.get(key(cur.id))
        if (known !== undefined) {
          base = known
          break
        }
        chain.push(cur)
        cur = cur.parent === null ? undefined : byKey.get(key(cur.parent))
      }
      for (let i = chain.length - 1; i >= 0; i--) depth.set(key(chain[i].id), ++base)
      return depth.get(key(n.id))!
    }
    const index = new Map<string, number>()
    nodes.forEach((n, i) => index.set(key(n.id), i + 1))
    const placed = nodes.map((n, i) => ({ n, x: PAD + (i + 1) * DX, y: PAD + depthOf(n) * DY }))
    const maxDepth = placed.reduce((m, p) => Math.max(m, p.y), PAD)
    return {
      placed,
      index,
      total: all.length,
      width: PAD * 2 + (nodes.length + 1) * DX,
      height: maxDepth + PAD + 4,
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pg, peer, docVersion])

  const pos = (id: Id | null) => {
    if (id === null) return { x: PAD, y: PAD }
    const i = layout.index.get(key(id))
    const p = i === undefined ? undefined : layout.placed[i - 1]
    return p ? { x: p.x, y: p.y } : null
  }

  return (
    <div className="tree">
      <div className="tree-scroll">
        <svg width={layout.width} height={layout.height} role="img" aria-label={`Fugue tree of ${peer}'s replica`}>
          {layout.placed.map(({ n, x, y }) => {
            const p = pos(n.parent)
            if (!p) return null
            return (
              <line
                key={`e${key(n.id)}`}
                x1={p.x}
                y1={p.y}
                x2={x}
                y2={y}
                className={`edge stroke-${n.id[0]}`}
                strokeDasharray={n.side === 'L' ? '3 3' : undefined}
              />
            )
          })}
          <rect x={PAD - 5} y={PAD - 5} width={10} height={10} className="root-node" />
          {layout.placed.map(({ n, x, y }) => (
            <g key={key(n.id)} className={n.deleted ? 'node tomb' : `node fill-${n.id[0]}`}>
              <title>
                {`${n.id[0]}:${n.id[1]}  "${n.char === '\n' ? '\\n' : n.char}"  ${n.side === 'L' ? 'left' : 'right'} child of ${short(n.parent)}${n.deleted ? '  (deleted)' : ''}`}
              </title>
              <circle cx={x} cy={y} r={7.5} />
              <text x={x} y={y + 0.5}>
                {glyph(n.char)}
              </text>
            </g>
          ))}
        </svg>
      </div>
      <p className="fine">
        {layout.total} nodes, {layout.total - pg.doc(peer).length} of them tombstones.
        {layout.total > MAX_NODES && ` Showing the first ${MAX_NODES}.`} Solid edges are right children,
        dashed edges left children. Hover a node for its id.
      </p>
    </div>
  )
}

export function OpLog({ pg, peer, docVersion }: { pg: Playground; peer: Peer; docVersion: number }) {
  const ops = useMemo(
    () => [...pg.doc(peer).ops()].reverse().slice(0, 120),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pg, peer, docVersion],
  )
  return (
    <div className="oplog">
      <table>
        <thead>
          <tr>
            <th scope="col">id</th>
            <th scope="col">op</th>
            <th scope="col">where</th>
          </tr>
        </thead>
        <tbody>
          {ops.map((op) => (
            <tr key={key(op.id)}>
              <td className={`ink-${op.id[0]}`}>{short(op.id)}</td>
              <td>{describe(op)}</td>
              <td className="muted">
                {op.type === 'ins'
                  ? `${op.side === 'L' ? 'left' : 'right'} of ${short(op.parent)}`
                  : `ids ${short(op.target)}${op.len > 1 ? `…${op.target[1] + op.len - 1}` : ''}`}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="fine">
        Newest first. Consecutive keystrokes are stored as one run, so a typed word is one op.
      </p>
    </div>
  )
}

function describe(op: Op): string {
  if (op.type === 'del') return `delete ${op.len}`
  const text = op.text.replace(/\n/g, '↵')
  return `insert "${text.length > 28 ? text.slice(0, 28) + '…' : text}"`
}
