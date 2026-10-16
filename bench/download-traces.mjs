// Downloads real-world editing traces from https://github.com/josephg/editing-traces
// (CC BY 4.0, by Joseph Gentle and contributors) into bench/traces/.
import { mkdir, writeFile, access } from 'node:fs/promises'

const BASE = 'https://raw.githubusercontent.com/josephg/editing-traces/master/sequential_traces'
const TRACES = ['automerge-paper', 'seph-blog1']

await mkdir(new URL('./traces/', import.meta.url), { recursive: true })
for (const name of TRACES) {
  const dest = new URL(`./traces/${name}.json.gz`, import.meta.url)
  try {
    await access(dest)
    console.log(`have ${name}`)
    continue
  } catch {}
  const res = await fetch(`${BASE}/${name}.json.gz`)
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`)
  await writeFile(dest, Buffer.from(await res.arrayBuffer()))
  console.log(`downloaded ${name}`)
}
