import { useEffect, useRef, type RefObject } from 'react'
import { PEERS, type Peer, type Playground } from './controller.js'

/** How much simulated time the diagram shows, in ms. */
const WINDOW = 12_000

interface Palette {
  ink: string
  muted: string
  rule: string
  grid: string
  danger: string
  hatch: string
  peer: Record<Peer, string>
}

function readPalette(el: HTMLElement): Palette {
  const css = getComputedStyle(el)
  const v = (name: string) => css.getPropertyValue(name).trim()
  return {
    ink: v('--ink'),
    muted: v('--ink-2'),
    rule: v('--rule'),
    grid: v('--grid'),
    danger: v('--danger'),
    hatch: v('--hatch'),
    peer: { alice: v('--alice'), bob: v('--bob'), carol: v('--carol') },
  }
}

/**
 * A live Lamport space-time diagram. Each peer is a vertical line under its
 * editor; "now" is the top edge and the past scrolls down. A diagonal line is
 * a packet: it leaves the sender's line when sent and reaches the receiver's
 * when delivered, so in-flight packets fly up into the editors above.
 */
export function Timeline({ pg, columns }: { pg: Playground; columns: RefObject<HTMLDivElement | null> }) {
  const canvas = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const el = canvas.current!
    const ctx = el.getContext('2d')!
    let palette = readPalette(el)
    let frame = 0
    let raf = 0

    const draw = () => {
      raf = requestAnimationFrame(draw)
      if (++frame % 30 === 0) palette = readPalette(el)

      const dpr = window.devicePixelRatio || 1
      const w = el.clientWidth
      const h = el.clientHeight
      if (el.width !== Math.round(w * dpr) || el.height !== Math.round(h * dpr)) {
        el.width = Math.round(w * dpr)
        el.height = Math.round(h * dpr)
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, w, h)

      const now = pg.now
      const top = 2
      const y = (t: number) => top + ((now - t) / WINDOW) * (h - top)
      const lanes = laneCenters(el, columns.current, w)
      const lane = (p: Peer) => lanes[PEERS.indexOf(p)]
      const visible = (t: number) => now - t <= WINDOW

      // Seconds grid.
      ctx.font = '10px "JetBrains Mono", ui-monospace, monospace'
      ctx.textBaseline = 'middle'
      ctx.lineWidth = 1
      for (let s = Math.floor(now / 1000) * 1000; now - s <= WINDOW; s -= 1000) {
        const yy = Math.round(y(s)) + 0.5
        ctx.strokeStyle = palette.grid
        ctx.beginPath()
        ctx.moveTo(0, yy)
        ctx.lineTo(w, yy)
        ctx.stroke()
        const ago = Math.round((now - s) / 1000)
        if (ago > 0 && ago % 2 === 0) {
          ctx.fillStyle = palette.muted
          ctx.fillText(`−${ago}s`, 4, yy - 7)
        }
      }

      // Cut links: hatched walls between the two peers' lines.
      for (const cut of pg.linkHistory) {
        const end = cut.to ?? now
        if (!visible(end)) continue
        const x1 = Math.min(lane(cut.a), lane(cut.b)) + 10
        const x2 = Math.max(lane(cut.a), lane(cut.b)) - 10
        const y1 = y(end)
        const y2 = Math.min(y(cut.from), h)
        ctx.save()
        ctx.beginPath()
        ctx.rect(x1, y1, x2 - x1, y2 - y1)
        ctx.clip()
        ctx.strokeStyle = palette.hatch
        ctx.lineWidth = 1
        for (let x = x1 - (y2 - y1); x < x2; x += 7) {
          ctx.beginPath()
          ctx.moveTo(x, y2)
          ctx.lineTo(x + (y2 - y1), y1)
          ctx.stroke()
        }
        ctx.restore()
      }

      // Process lines.
      for (const p of PEERS) {
        const x = Math.round(lane(p)) + 0.5
        ctx.strokeStyle = palette.peer[p]
        ctx.globalAlpha = 0.55
        ctx.lineWidth = 2
        ctx.setLineDash(pg.isolated(p) ? [4, 4] : [])
        ctx.beginPath()
        ctx.moveTo(x, 0)
        ctx.lineTo(x, h)
        ctx.stroke()
      }
      ctx.setLineDash([])
      ctx.globalAlpha = 1

      // Packets.
      for (const pk of pg.packets) {
        if (!visible(pk.endAt) && pk.status !== 'flight') continue
        const x1 = lane(pk.from)
        const x2 = lane(pk.to)
        const y1 = y(pk.sentAt)
        const span = Math.max(1, pk.deliverAt - pk.sentAt)
        const color = pk.kind === 'ops' ? palette.peer[pk.from] : palette.muted
        const age = (now - pk.endAt) / WINDOW
        ctx.globalAlpha = pk.status === 'flight' ? 1 : Math.max(0.25, 0.9 - age)
        ctx.strokeStyle = color
        ctx.lineWidth = pk.kind === 'ops' ? 1.6 : 1
        ctx.setLineDash(pk.kind === 'sync' ? [3, 3] : [])

        if (pk.status === 'cut' && pk.endAt === pk.sentAt) {
          // Dropped at the sender: the link was already down.
          ctx.setLineDash([])
          drawCross(ctx, x1 + Math.sign(x2 - x1) * 10, y1, 2.5, palette.danger, 0.7)
          continue
        }

        const p = Math.min(1, (Math.min(now, pk.endAt) - pk.sentAt) / span)
        const hx = x1 + (x2 - x1) * p
        const hy = y(Math.min(now, pk.endAt))
        ctx.beginPath()
        ctx.moveTo(x1, y1)
        ctx.lineTo(hx, hy)
        ctx.stroke()
        ctx.setLineDash([])

        if (pk.status === 'flight') {
          ctx.fillStyle = color
          ctx.beginPath()
          ctx.arc(hx, hy, pk.kind === 'ops' ? 3.5 : 2.5, 0, Math.PI * 2)
          ctx.fill()
        } else if (pk.status === 'delivered') {
          drawArrow(ctx, x1, y1, hx, hy, color)
        } else {
          drawCross(ctx, hx, hy, 4, palette.danger)
        }
      }
      ctx.globalAlpha = 1

      // Local edits: a dot on the editing peer's line.
      for (const e of pg.edits) {
        if (!visible(e.at)) continue
        const x = lane(e.peer)
        ctx.fillStyle = e.kind === 'ins' ? palette.peer[e.peer] : palette.ink
        ctx.beginPath()
        ctx.arc(x, y(e.at), e.kind === 'ins' ? 3 : 2.5, 0, Math.PI * 2)
        ctx.fill()
      }
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [pg])

  return (
    <canvas
      ref={canvas}
      className="timeline"
      role="img"
      aria-label="Space-time diagram of packets between the three peers over the last 12 simulated seconds"
    />
  )
}

function drawArrow(ctx: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number, color: string) {
  const angle = Math.atan2(y2 - y1, x2 - x1)
  const size = 6
  ctx.fillStyle = color
  ctx.beginPath()
  ctx.moveTo(x2, y2)
  ctx.lineTo(x2 - size * Math.cos(angle - 0.4), y2 - size * Math.sin(angle - 0.4))
  ctx.lineTo(x2 - size * Math.cos(angle + 0.4), y2 - size * Math.sin(angle + 0.4))
  ctx.closePath()
  ctx.fill()
}

/**
 * x positions of the three process lines. When the editors sit side by side,
 * each line runs straight down from the middle of its editor.
 */
function laneCenters(canvas: HTMLCanvasElement, columns: HTMLDivElement | null, w: number): number[] {
  const even = PEERS.map((_, i) => ((i + 0.5) / PEERS.length) * w)
  if (!columns || columns.children.length !== PEERS.length) return even
  const box = canvas.getBoundingClientRect()
  const centers = [...columns.children].map((c) => {
    const r = c.getBoundingClientRect()
    return r.left + r.width / 2 - box.left
  })
  // Stacked on a narrow screen: fall back to evenly spaced lanes.
  return centers[1] - centers[0] > 40 ? centers : even
}

function drawCross(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, color: string, alpha = 1) {
  ctx.globalAlpha = alpha
  ctx.strokeStyle = color
  ctx.lineWidth = 1.8
  ctx.beginPath()
  ctx.moveTo(x - r, y - r)
  ctx.lineTo(x + r, y + r)
  ctx.moveTo(x + r, y - r)
  ctx.lineTo(x - r, y + r)
  ctx.stroke()
}
