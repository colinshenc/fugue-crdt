# Fugue CRDT Lab

[![CI](https://github.com/colinshenc/fugue-crdt/actions/workflows/ci.yml/badge.svg)](https://github.com/colinshenc/fugue-crdt/actions/workflows/ci.yml)

A text document that several people can edit at once, even while offline, written from scratch in TypeScript. There's also a playground where you can mess with the network between three editors (cut links, drop packets, add lag) and check that all three still end up with the same text.

[Try the playground](https://colinshenc.github.io/fugue-crdt/)

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/playground-dark.png">
  <img alt="The playground: three editors side by side, with a diagram underneath showing messages crossing between them after a network split heals." src="docs/playground-light.png">
</picture>

Alice, Bob and Carol each typed a line while cut off from each other (the striped area in the diagram). Once the network came back, their edits crossed over and all three lines came through intact.

## Why I built this

I'd done a project on vector clocks before and wanted to build something real on top of the same ideas. Collaborative editing seemed like the obvious choice. It looks simple from the outside, but making it work without a server turns out to be a pretty deep problem.

## Background

Say a document contains `cat`, and two people edit it at the same moment. Alice adds an `s` at the end ("insert `s` at position 3"). Bob adds `the ` at the start ("insert `the ` at position 0"). By the time Alice's edit reaches Bob, his copy says `the cat`, so position 3 is in the middle of "the". Applied naively, Bob ends up with `thes cat` and Alice with `the cats`. The two copies have drifted apart and nobody notices.

Google Docs avoids this by sending every edit through a central server that decides on one order and fixes up the positions. That works, but only while you're online.

A CRDT (conflict-free replicated data type) takes the other route. Each person edits their own copy, and the data is structured so that any two copies can always be merged, in any order, with the same result every time. No server is needed. Yjs and Automerge are the well-known libraries built on this idea.

The core trick for text is to stop using positions. Each character gets a permanent ID ("Alice's 7th character"), and edits say things like "put `s` after Alice's 3rd character". IDs don't shift when other people type, so an edit means the same thing on every copy. Deleted characters are only hidden, not removed (they're called tombstones), so edits that point at them still work.

That gets every copy to agree, but not necessarily on something useful. If Alice types `Hello` and Bob types `World` at the same spot while offline, some older algorithms merge them into something like `HWeolrllod`. Every copy agrees, and the result is still garbage. This is known as interleaving.

## Fugue

Fugue is an algorithm from a 2023 paper by Matthew Weidner and Martin Kleppmann, [*The Art of the Fugue*](https://arxiv.org/abs/2305.00583), designed specifically to avoid interleaving. With Fugue the example above always comes out as `HelloWorld` or `WorldHello`.

It stores the text as a tree of characters:

```
root
 └─ H
     └─ i              "Hi", typed in order, so each letter hangs off the previous one
         ├─ a ─ !      Alice (offline) types "a!" after the "i"
         └─ b ─ ?      Bob (offline) types "b?" after the "i"

reading the tree left to right gives "Hia!b?"
```

A new character gets attached to the character before the cursor, so normal typing builds a chain. When two people attach text to the same character, their chains become sibling branches. Siblings are always sorted the same way (by the writer's name), and each branch is read all the way through before the next one starts, so nobody's text gets chopped up. Since every copy builds the same tree from the same edits, every copy reads out the same text.

## What's in here

- `src/doc.ts` is the Fugue engine itself, with no dependencies.
- `src/replica.ts` handles syncing copies over a network that can lose, delay, duplicate or reorder messages.
- `src/sim/` is a fake network for testing. It's random but seeded, so a failure can be replayed exactly.
- `playground/` is the web page (React plus a canvas for the diagram).
- `test/` and `bench/` hold the tests and the benchmarks against Yjs and Automerge.

## The playground

Each editor is its own copy of the document, and every character is colored by who typed it. The diagram underneath is a space-time diagram: time moves down the page, each person has a vertical line, and each message is a diagonal line from sender to receiver. Messages that get lost end in a red ×.

The preset scenarios:

- **Three writers, one spot**: everyone goes offline and adds a line in the same place. Each line survives in one piece.
- **Delete vs. edit**: Alice deletes a phrase while Bob is adding words in the middle of it. The phrase is gone, Bob's words survive where it used to be, and all copies agree.
- **Carol on a plane**: Carol is offline for a while and keeps typing. When she reconnects, the copies work out exactly what each one is missing.
- **Gossip relay**: the Alice–Carol link is down, so Alice's edits reach Carol through Bob.
- **Chaos monkey**: 12 seconds of random edits, flaky links, 25% packet loss and duplicate messages, followed by a clean merge.

You can also just type, cut links yourself, or crank up lag and packet loss. The panel at the bottom shows each copy's actual tree and its list of edits.

## Dealing with a bad network

When an edit shows up before something it depends on (for example "add `x` after character 12" arriving before character 12), it waits in a buffer until the missing piece arrives. Duplicates are easy to spot because every edit has a unique ID. If two copies can't reach each other directly, edits get relayed through whoever can reach both.

Lost messages are handled by having copies compare notes every few seconds. Each copy keeps a version vector, which is just one counter per person ("I have your first 40 edits"). This is basically a cousin of the vector clocks from my earlier project. Two copies swap these, and each sends back whatever the other is missing. A single exchange is enough to fix any number of lost messages.

## Performance

I benchmarked against Yjs and Automerge using real editing histories from [josephg/editing-traces](https://github.com/josephg/editing-traces). These are recorded keystroke by keystroke while people wrote an academic paper (`automerge-paper`) and a blog post (`seph-blog1`). "Typing" means applying every keystroke the way an editor would. "Loading" means a new copy receiving the whole history at once. Each run is checked against the real final document.

| History | Library | Typing | Loading | Sync size | Memory |
| --- | --- | ---: | ---: | ---: | ---: |
| automerge-paper (259,778 keystrokes) | this project | **191 ms** | 200 ms | 1.2 MB | 29.7 MB |
| | Yjs 13.6 | 2,104 ms | **16 ms** | 304 KB | **3.3 MB** |
| | Automerge 3.5 | 31,602 ms | 1,501 ms | **126 KB** | n/a |
| seph-blog1 (137,993 keystrokes) | this project | **129 ms** | 365 ms | 2.1 MB | 32.8 MB |
| | Yjs 13.6 | 918 ms | **16 ms** | 330 KB | **3.6 MB** |
| | Automerge 3.5 | 20,039 ms | 862 ms | **215 KB** | n/a |

Typing comes out 7–11× faster than Yjs. That's mostly because finding where a keystroke goes is very cheap here (more on that below). To be fair to the others, Yjs and Automerge do more bookkeeping per edit, and both would speed up a lot if edits were batched.

Yjs wins easily on loading, size and memory, though. It stores runs of typed text as single blocks and uses a compact binary format, while I store one entry per character and send JSON. That's the biggest thing I'd improve next. These are single runs on a shared cloud VM, so treat them as ballpark numbers. I left out Automerge's memory because it lives in WebAssembly and isn't comparable.

To reproduce: `npm run traces && npm run bench`.

## Testing

The test I trust most compares my engine against a second, deliberately naive implementation copied as directly as I could from the paper. Both get the same random edits, and after every step they have to agree on the text and on where each character sits in the tree.

There's also chaos testing: 150 simulated sessions, each with 2–5 people, 400 random actions, links breaking and healing, and up to 30% of messages lost. At the end every copy has to match, and a fresh copy fed all the edits in shuffled order has to match too. I've run 3,000 of these (`CHAOS_SEEDS=3000 npm test`) without a failure. Other tests cover interleaving specifically, thousands of random edits checked against a plain string, out-of-order and duplicate delivery, and cursors staying put while other people type.

To make sure the tests actually catch things, I planted a few bugs on purpose: flipping the sibling order, breaking the position cache, and putting remote characters in the wrong place. Each one failed dozens of tests.

## Implementation notes

Walking the tree to find "the 500th character" would be slow, because typing makes long chains and the tree can get as deep as the document is long. So the characters are also kept in a flat list in reading order, split into chunks of up to 512. Each chunk knows how many visible characters it holds, which lets a lookup skip whole chunks at a time. On top of that, lookups start from wherever the last edit happened. People mostly type near where they just typed, so a lookup usually finds its spot almost immediately.

Most characters have at most one child, so switching children from arrays to a linked list cut memory by about 22%. Consecutive keystrokes also get merged into one "insert this word" edit, and runs of backspaces into one delete. On the big benchmark that took the sync data from 20 MB down to 1.2 MB.

## Using it

```ts
import { Doc } from 'fugue-crdt-lab' // not on npm yet, build it with `npm run build`

const alice = new Doc('alice')
const bob = new Doc('bob')

const op = alice.insert(0, 'Hello')!   // each edit returns an op to send to the others
bob.apply([op])                        // ops can arrive in any order, any number of times

const a = alice.insert(5, ' world')!   // both edit while offline
const b = bob.insert(5, ' there')!
alice.apply([b])
bob.apply([a])
alice.toString() === bob.toString()    // true, both are "Hello world there"

const missing = alice.opsSince(bob.version())   // everything Bob doesn't have yet
const anchor = bob.anchorAt(5)                  // a cursor that survives other people's edits
bob.positionOf(anchor)
```

`Replica` adds the sync protocol on top of `Doc`, and `Cluster` / `SimNetwork` give you the simulated network.

## Running it

```
npm install
npm test             # all tests
npm run dev          # playground on http://localhost:5173
npm run traces       # download the editing histories (once)
npm run bench        # benchmarks
```

## What I'd do next

- Store runs of text as single entries, the way Yjs and the paper's optimized version do. That should cut memory a lot.
- Switch from JSON to a binary format for syncing.
- Connect real browsers over WebSockets or WebRTC instead of simulating everyone in one tab.
- Clean up tombstones eventually. Right now deleted characters stick around forever, which is true of most text CRDTs.

## Credits

Fugue is by Matthew Weidner and Martin Kleppmann (see also their [reference code](https://github.com/mweidner037/fugue)). The editing traces are from Joseph Gentle and contributors (CC BY 4.0). Yjs and Automerge are only used for the benchmarks.

MIT license.
