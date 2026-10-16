import { useEffect, useRef } from 'react'
import type { Id } from '../../src/index.js'
import type { Peer, Playground } from './controller.js'

interface Props {
  pg: Playground
  peer: Peer
  /** Changes whenever this peer's document changes, to re-render the colored layer. */
  docVersion: number
}

/**
 * A plain textarea over a colored copy of the same text. The textarea's own
 * text is transparent, so you see each character in its author's color while
 * typing into a normal, native text field.
 */
export function Editor({ pg, peer, docVersion }: Props) {
  const area = useRef<HTMLTextAreaElement>(null)
  const layer = useRef<HTMLPreElement>(null)
  // The selection, stored as character ids so it survives remote edits.
  const anchors = useRef<{ start: Id | null; end: Id | null }>({ start: null, end: null })

  const saveSelection = () => {
    const ta = area.current
    if (!ta) return
    const doc = pg.doc(peer)
    anchors.current = { start: doc.anchorAt(ta.selectionStart), end: doc.anchorAt(ta.selectionEnd) }
  }

  useEffect(() => {
    const ta = area.current!
    ta.value = pg.doc(peer).toString()
    return pg.onDocChange(peer, () => {
      const doc = pg.doc(peer)
      const start = doc.positionOf(anchors.current.start)
      const end = doc.positionOf(anchors.current.end)
      ta.value = doc.toString()
      ta.setSelectionRange(start, end)
      saveSelection()
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pg, peer])

  const onInput = () => {
    const ta = area.current!
    const prev = pg.doc(peer).toString()
    const next = ta.value
    const caret = ta.selectionEnd
    // Find the edited region. Anchoring the diff on the caret keeps the
    // insert at the position actually typed at, even next to repeated letters.
    let suffix = 0
    const maxSuffix = Math.min(prev.length, next.length - caret)
    while (suffix < maxSuffix && prev[prev.length - 1 - suffix] === next[next.length - 1 - suffix]) suffix++
    const endPrev = prev.length - suffix
    const endNext = next.length - suffix
    let start = 0
    while (start < endPrev && start < endNext && prev[start] === next[start]) start++
    if (endPrev > start) pg.delete(peer, start, endPrev - start, true)
    if (endNext > start) pg.insert(peer, start, next.slice(start, endNext), true)
    saveSelection()
  }

  const spans = pg.doc(peer).spans()
  void docVersion

  return (
    <div className="editor">
      <pre ref={layer} className="editor-layer" aria-hidden="true">
        {spans.map((s, i) => (
          <span key={i} className={`ink-${s.agent}`}>
            {s.text}
          </span>
        ))}
        {'​'}
      </pre>
      <textarea
        ref={area}
        id={`editor-${peer}`}
        className="editor-input"
        aria-label={`${peer}'s copy of the document`}
        spellCheck={false}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        onInput={onInput}
        onSelect={saveSelection}
        onKeyUp={saveSelection}
        onMouseUp={saveSelection}
        onFocus={saveSelection}
        onScroll={(e) => {
          if (layer.current) layer.current.scrollTop = e.currentTarget.scrollTop
        }}
      />
    </div>
  )
}
