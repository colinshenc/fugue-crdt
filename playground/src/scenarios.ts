import type { Id } from '../../src/index.js'
import { PEERS, type Peer, type Playground } from './controller.js'

export interface Scenario {
  id: string
  title: string
  /** What to watch for while it runs. */
  caption: string
  run(pg: Playground): void
}

/** Types `text` one keystroke at a time, following its own cursor like a person would. */
function type(pg: Playground, peer: Peer, at: number | 'end', text: string, delay: number, interval = 130): number {
  let anchor: Id | null | undefined
  for (let i = 0; i < text.length; i++) {
    pg.after(delay + i * interval, () => {
      const doc = pg.doc(peer)
      const index =
        anchor === undefined ? (at === 'end' ? doc.length : Math.min(at, doc.length)) : doc.positionOf(anchor)
      pg.insert(peer, index, text[i])
      anchor = doc.anchorAt(index + 1)
    })
  }
  return delay + text.length * interval
}

/** Deletes the first occurrence of `text`, if it's still there. */
function erase(pg: Playground, peer: Peer, text: string, delay: number): void {
  pg.after(delay, () => {
    const i = pg.doc(peer).toString().indexOf(text)
    if (i >= 0) pg.delete(peer, i, text.length)
  })
}

export const SCENARIOS: Scenario[] = [
  {
    id: 'same-spot',
    title: 'Three writers, one spot',
    caption:
      'Everyone goes offline and types a line at the end of the same list. When the network heals, each line arrives whole. Weaker list CRDTs can shuffle concurrent keystrokes together; Fugue never interleaves text typed left to right.',
    run(pg) {
      pg.reset('Packing list\n')
      pg.splitAll()
      const a = type(pg, 'alice', 'end', '- passport\n', 300)
      const b = type(pg, 'bob', 'end', '- phone charger\n', 360)
      const c = type(pg, 'carol', 'end', '- sunscreen\n', 420)
      pg.after(Math.max(a, b, c) + 900, () => pg.heal())
    },
  },
  {
    id: 'delete-vs-edit',
    title: 'Delete vs. edit',
    caption:
      'Alice deletes "in room 4" while Bob, offline, adds "(or 5)" right after it. Both edits survive the merge: the deleted words stay deleted and Bob\'s new text lands where those words used to be. Every replica agrees, though maybe not with what either person meant.',
    run(pg) {
      pg.reset('Standup at 10am in room 4.\nBring the demo build.\n')
      pg.splitAll()
      erase(pg, 'alice', ' in room 4', 600)
      const end = (() => {
        let anchor: Id | null = null
        pg.after(400, () => {
          const doc = pg.doc('bob')
          anchor = doc.anchorAt(doc.toString().indexOf('room 4') + 'room 4'.length)
        })
        const text = ' (or 5)'
        for (let i = 0; i < text.length; i++) {
          pg.after(500 + i * 140, () => {
            const doc = pg.doc('bob')
            const index = doc.positionOf(anchor)
            pg.insert('bob', index, text[i])
            anchor = doc.anchorAt(index + 1)
          })
        }
        return 500 + text.length * 140
      })()
      pg.after(end + 1200, () => pg.heal())
    },
  },
  {
    id: 'offline',
    title: 'Carol on a plane',
    caption:
      'Carol is cut off and keeps writing while Alice and Bob carry on together. Their packets to her are lost. When she reconnects, one anti-entropy exchange of version vectors works out exactly which ops each side is missing and sends only those.',
    run(pg) {
      pg.reset('Trip notes\n')
      pg.isolate('carol')
      type(pg, 'alice', 'end', 'Flight lands 14:05.\n', 300)
      type(pg, 'carol', 0, '[draft] ', 600)
      const b = type(pg, 'bob', 'end', 'Hotel is near the station.\n', 3200)
      erase(pg, 'alice', 'Trip ', b + 300)
      pg.after(b + 1800, () => pg.heal())
    },
  },
  {
    id: 'relay',
    title: 'Gossip relay',
    caption:
      'The direct link between Alice and Carol is cut, but both can still reach Bob. Alice\'s keystrokes travel to Carol in two hops: Bob applies each op and relays it on. Turn off "Relay ops" to make Carol wait for the next anti-entropy round instead.',
    run(pg) {
      pg.reset('Group chat\n')
      pg.setLink('alice', 'carol', false)
      const a = type(pg, 'alice', 'end', 'alice: anyone up for lunch?\n', 300)
      const c = type(pg, 'carol', 'end', 'carol: yes, 12:30\n', a + 600)
      pg.after(c + 1500, () => pg.heal())
    },
  },
  {
    id: 'chaos',
    title: 'Chaos monkey',
    caption:
      'For 12 simulated seconds, all three peers make random edits while links flap, 25% of packets are lost and 15% are duplicated. Then the network heals. The run is over when the status turns green and all three digests match.',
    run(pg) {
      pg.reset('Shared doc\n')
      const before = pg.networkConfig
      pg.setNetwork({ dropRate: 0.25, duplicateRate: 0.15, jitter: 900 })
      const words = ['sync ', 'merge ', 'fork ', 'vector ', 'clock ', 'tomb ', 'stone ', 'gossip ', 'quorum ']
      for (let t = 200; t < 12_000; t += 220) {
        pg.after(t, () => {
          const peer = PEERS[Math.floor(Math.random() * 3)]
          const text = pg.doc(peer).toString()
          // Edit whole words at word boundaries, so the merged result stays readable.
          const wordsInDoc = [...text.matchAll(/[a-z]+ /g)]
          if (wordsInDoc.length > 4 && Math.random() < 0.3) {
            const m = wordsInDoc[Math.floor(Math.random() * wordsInDoc.length)]
            pg.delete(peer, m.index!, m[0].length)
          } else {
            const starts = [...text.matchAll(/(^|[ \n])/g)].map((m) => m.index! + m[0].length)
            const at = starts[Math.floor(Math.random() * starts.length)] ?? text.length
            pg.insert(peer, at, words[Math.floor(Math.random() * words.length)])
          }
        })
      }
      for (let t = 600; t < 12_000; t += 900) {
        pg.after(t, () => {
          const [a, b] = [...PEERS].sort(() => Math.random() - 0.5)
          pg.setLink(a, b, !pg.isUp(a, b))
        })
      }
      pg.after(12_200, () => {
        pg.setNetwork(before)
        pg.heal()
      })
    },
  },
]
