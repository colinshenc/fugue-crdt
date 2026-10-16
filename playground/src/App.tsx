import { useEffect, useMemo, useRef, useState } from 'react'
import { LINKS, PEERS, Playground, type Peer } from './controller.js'
import { Editor } from './Editor.js'
import { OpLog, TreeView } from './Inspector.js'
import { SCENARIOS } from './scenarios.js'
import { Timeline } from './Timeline.js'

const REPO_URL = 'https://github.com/colinshenc/fugue-crdt'
const PAPER_URL = 'https://arxiv.org/abs/2305.00583'
const SPEEDS = [0.25, 0.5, 1, 2]
const NAME: Record<Peer, string> = { alice: 'Alice', bob: 'Bob', carol: 'Carol' }

export function App() {
  const pg = useMemo(() => new Playground(), [])
  const [, setVersion] = useState(0)
  const [selected, setSelected] = useState<Peer>('alice')
  const [view, setView] = useState<'tree' | 'ops'>('tree')
  const columnsRef = useRef<HTMLDivElement>(null)

  // One loop drives the simulation; React re-renders only when something changed.
  useEffect(() => {
    let last = performance.now()
    let seen = -1
    let raf = 0
    const loop = (t: number) => {
      raf = requestAnimationFrame(loop)
      pg.tick(Math.min(100, t - last))
      last = t
      if (pg.version !== seen) {
        seen = pg.version
        setVersion(seen)
      }
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [pg])

  const states = pg.distinctStates()
  const converged = pg.converged()
  const inFlight = pg.inFlight()
  const net = pg.networkConfig
  const scenario = SCENARIOS.find((s) => s.id === pg.scenario) ?? null
  const [caption, setCaption] = useState<string | null>(null)

  const packets = `${inFlight} packet${inFlight === 1 ? '' : 's'} in flight`
  const status = converged
    ? { tone: 'ok', label: 'Converged', detail: `every replica at #${pg.digest('alice')}` }
    : states === 1
      ? { tone: 'busy', label: 'Syncing', detail: packets }
      : { tone: 'warn', label: `${states} different versions`, detail: packets }

  return (
    <div className="page">
      <header className="masthead">
        <div className="brand">
          <h1 className="wordmark">
            <span className="wm-main">Fugue</span>
            <span className="wm-sub">CRDT Lab</span>
          </h1>
          <p className="lede">
            Three replicas of one document and a network you can break. Edit any copy, cut links, drop packets,
            then watch every replica end up with the same text, built on a from-scratch implementation of the
            Fugue CRDT.
          </p>
        </div>
        <nav className="toplinks" aria-label="Project links">
          <a href="#how">How it works</a>
          <a href={REPO_URL} target="_blank" rel="noreferrer">
            Source
          </a>
          <a href={PAPER_URL} target="_blank" rel="noreferrer">
            Fugue paper
          </a>
        </nav>
      </header>

      <section className="controls" aria-label="Simulation controls">
        <div className={`status status-${status.tone}`} role="status" aria-live="polite">
          <span className="status-dot" aria-hidden="true" />
          <strong>{status.label}</strong>
          <span>{status.detail}</span>
        </div>

        <div className="control-group">
          <span className="label">Time</span>
          <button
            type="button"
            className="btn"
            id="pause"
            onClick={() => {
              pg.paused = !pg.paused
              pg.version++
            }}
          >
            {pg.paused ? 'Resume' : 'Pause'}
          </button>
          <div className="segmented" role="group" aria-label="Simulation speed">
            {SPEEDS.map((s) => (
              <button
                key={s}
                type="button"
                aria-pressed={pg.speed === s}
                onClick={() => {
                  pg.speed = s
                  pg.version++
                }}
              >
                {s}×
              </button>
            ))}
          </div>
        </div>

        <div className="control-group">
          <span className="label">Links</span>
          {LINKS.map(([a, b]) => {
            const up = pg.isUp(a, b)
            return (
              <button
                key={`${a}-${b}`}
                type="button"
                className={`link-toggle ${up ? 'up' : 'down'}`}
                aria-pressed={up}
                title={up ? 'Click to cut this link' : 'Click to reconnect'}
                onClick={() => pg.setLink(a, b, !up)}
              >
                <span className={`ink-${a}`}>{NAME[a][0]}</span>
                <span className="link-glyph" aria-hidden="true">
                  {up ? '—' : '╳'}
                </span>
                <span className={`ink-${b}`}>{NAME[b][0]}</span>
                <span className="sr-only">
                  {NAME[a]} to {NAME[b]}: {up ? 'connected' : 'cut'}
                </span>
              </button>
            )
          })}
          <button type="button" className="btn" onClick={() => pg.splitAll()}>
            Split all
          </button>
          <button type="button" className="btn" onClick={() => pg.heal()}>
            Heal
          </button>
        </div>

        <div className="control-group sliders">
          <Slider id="latency" label="Latency" value={net.latency} min={50} max={2000} step={50} unit="ms"
            onChange={(v) => pg.setNetwork({ latency: v })} />
          <Slider id="jitter" label="Jitter" value={net.jitter} min={0} max={1500} step={50} unit="ms"
            onChange={(v) => pg.setNetwork({ jitter: v })} />
          <Slider id="loss" label="Loss" value={Math.round(net.dropRate * 100)} min={0} max={60} step={5} unit="%"
            onChange={(v) => pg.setNetwork({ dropRate: v / 100 })} />
          <Slider id="dup" label="Duplicates" value={Math.round(net.duplicateRate * 100)} min={0} max={60} step={5} unit="%"
            onChange={(v) => pg.setNetwork({ duplicateRate: v / 100 })} />
          <label className="check" htmlFor="relay">
            <input id="relay" type="checkbox" checked={pg.relayEnabled} onChange={(e) => pg.setRelay(e.target.checked)} />
            Relay ops
          </label>
          <button type="button" className="btn" onClick={() => pg.syncNow()}>
            Sync now
          </button>
        </div>
      </section>

      <section className="scenarios" aria-label="Scenarios">
        <div className="scenario-buttons">
          <span className="label">Try</span>
          {SCENARIOS.map((s) => (
            <button
              key={s.id}
              type="button"
              className={`chip ${pg.scenario === s.id ? 'running' : ''}`}
              onClick={() => {
                s.run(pg)
                pg.scenario = s.id
                pg.version++
                setCaption(s.caption)
              }}
            >
              {s.title}
            </button>
          ))}
          <button
            type="button"
            className="chip quiet"
            onClick={() => {
              pg.reset()
              pg.heal()
              setCaption(null)
            }}
          >
            Reset
          </button>
        </div>
        <p className="caption">
          {caption ??
            'Type in any of the three editors. Each character is colored by the replica that wrote it. Cut a link or pick a scenario to see what happens when replicas disagree.'}
          {scenario && <span className="running-tag"> Running…</span>}
        </p>
      </section>

      <main className="stage">
        <div className="peers" ref={columnsRef}>
          {PEERS.map((p) => {
            const doc = pg.doc(p)
            const vv = doc.version()
            return (
              <article key={p} className={`peer peer-${p} ${selected === p ? 'selected' : ''}`}>
                <header className="peer-head">
                  <button type="button" className="peer-name" onClick={() => setSelected(p)} aria-pressed={selected === p}
                    title="Inspect this replica">
                    {NAME[p]}
                  </button>
                  {pg.isolated(p) && <span className="badge">offline</span>}
                  <span className="digest" title="Hash of this replica's text">
                    #{pg.digest(p)}
                  </span>
                </header>
                <Editor pg={pg} peer={p} docVersion={pg.docVersion[p]} />
                <footer className="peer-foot">
                  <span className="vv" title="Version vector: ops seen from each replica">
                    {PEERS.map((q) => (
                      <span key={q} className={`ink-${q}`}>
                        {q[0]}
                        {vv[q] ?? 0}
                      </span>
                    ))}
                  </span>
                  {doc.pendingCount > 0 && (
                    <span className="pending" title="Ops waiting for an earlier op they depend on">
                      {doc.pendingCount} buffered
                    </span>
                  )}
                </footer>
              </article>
            )
          })}
        </div>
        <Timeline pg={pg} columns={columnsRef} />
        <ul className="legend">
          <li><i className="lg-ops" /> ops packet</li>
          <li><i className="lg-sync" /> anti-entropy sync</li>
          <li><i className="lg-drop">×</i> lost or blocked</li>
          <li><i className="lg-cut" /> link cut</li>
          <li><i className="lg-dot" /> local edit</li>
        </ul>
      </main>

      <section className="inspector" aria-label="Replica inspector">
        <header className="inspector-head">
          <h2>
            Inside <span className={`ink-${selected}`}>{NAME[selected]}</span>&rsquo;s replica
          </h2>
          <div className="segmented" role="tablist" aria-label="Inspector view">
            <button type="button" role="tab" aria-selected={view === 'tree'} onClick={() => setView('tree')}>
              Fugue tree
            </button>
            <button type="button" role="tab" aria-selected={view === 'ops'} onClick={() => setView('ops')}>
              Op log
            </button>
          </div>
          <div className="segmented" role="group" aria-label="Replica">
            {PEERS.map((p) => (
              <button key={p} type="button" aria-pressed={selected === p} onClick={() => setSelected(p)}>
                {NAME[p]}
              </button>
            ))}
          </div>
        </header>
        {view === 'tree' ? (
          <TreeView pg={pg} peer={selected} docVersion={pg.docVersion[selected]} />
        ) : (
          <OpLog pg={pg} peer={selected} docVersion={pg.docVersion[selected]} />
        )}
      </section>

      <section className="explainer" id="how">
        <h2>How it works</h2>
        <div className="columns">
          <div>
            <h3>A tree, read in order</h3>
            <p>
              Each character is a node in a tree and the document is its in-order traversal. A new character
              becomes the right child of the character before the cursor, or, if that spot is taken, the left
              child of the next one. Siblings sort by replica name, so every replica orders concurrent text the
              same way, and a run typed by one person stays in one piece.
            </p>
          </div>
          <div>
            <h3>Ops that tolerate a bad network</h3>
            <p>
              Ids are (replica, counter) pairs. An op whose parent hasn&rsquo;t arrived waits in a buffer, and a
              duplicate is skipped. Every 3 seconds, replicas swap version vectors and send back whatever the
              other is missing. That one exchange repairs lost packets, healed partitions and late joiners.
            </p>
          </div>
          <div>
            <h3>Tested against the paper</h3>
            <p>
              This page runs the same seeded network simulator as the test suite. Hundreds of chaos runs check
              convergence, and a differential test compares the optimised engine, step by step, with a naive
              transcription of the paper&rsquo;s algorithm. Replaying real editing traces of up to 260k
              keystrokes, it applies local edits 7&ndash;11× faster than Yjs, at the cost of more memory.
            </p>
          </div>
        </div>
      </section>

      <footer className="colophon">
        <span>Fugue CRDT Lab: the CRDT engine, network simulator and this playground, written from scratch in TypeScript.</span>
        <a href={REPO_URL} target="_blank" rel="noreferrer">
          Read the source
        </a>
      </footer>
    </div>
  )
}

interface SliderProps {
  id: string
  label: string
  value: number
  min: number
  max: number
  step: number
  unit: string
  onChange: (v: number) => void
}

function Slider({ id, label, value, min, max, step, unit, onChange }: SliderProps) {
  return (
    <label className="slider" htmlFor={id}>
      <span className="slider-label">
        {label} <output htmlFor={id}>{value}{unit}</output>
      </span>
      <input id={id} type="range" min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(Number(e.target.value))} />
    </label>
  )
}
