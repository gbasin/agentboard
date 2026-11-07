/** Compare CLI transcript snapshots before paste, before Return, and after Return. */
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'

const [phase, agent, transcript, snapshot, expectedFile] = process.argv.slice(2)
assert(['before', 'held', 'submitted'].includes(phase), 'phase: before | held | submitted')
assert(agent === 'claude' || agent === 'codex', 'agent: claude | codex')
const rows = readFileSync(transcript, 'utf8').trim().split('\n').map(line => JSON.parse(line))
const prompts: string[] = agent === 'claude'
  ? rows.filter(row => row.type === 'user' && row.promptSource === 'typed').map(row => row.message.content)
  : rows.filter(row => row.type === 'event_msg' && row.payload.type === 'item_completed' && row.payload.item.type === 'UserMessage')
    .map(row => row.payload.item.content.filter((part: { type: string }) => part.type === 'text').map((part: { text: string }) => part.text).join(''))
if (phase === 'before') {
  writeFileSync(snapshot, JSON.stringify(prompts))
} else {
  const before = JSON.parse(readFileSync(snapshot, 'utf8'))
  const expected = phase === 'held' ? before : [...before, readFileSync(expectedFile, 'utf8')]
  assert.deepEqual(prompts, expected, 'Paste must remain held, then submit exactly once with unchanged text')
}
console.log(`PASS: ${agent} ${phase}`)
