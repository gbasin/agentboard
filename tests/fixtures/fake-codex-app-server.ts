#!/usr/bin/env bun
// Fake Codex app-server (codex-chat-sessions 4.4): replays one run of the
// recorded smoke transcript over stdio, so tests exercise the real recorded
// JSON-RPC shapes without a Codex install. Spawned as `<fake> app-server`
// (the AppServerClient's argv), selected through KAWAI_CODEX_PATH like the
// real executable.
//
// FAKE_RUN=<n> picks the run (1-based; the transcript splits on each fresh
// `initialize` request; default 1). FAKE_TRANSCRIPT overrides the path.
// Records with a `fake` field (no `dir`) are test doubles: `append` writes a
// line to a file (the rollout writer's stand-in), `gate` waits for a path.
// FAKE_EXIT_AFTER_REPLAY=1 exits 0 once the run is replayed; the default
// stays alive until stdin closes (the driver's end()). FAKE_ENV_NAMES=<file>
// writes the NAMES of the variables the child received (never a value), so
// a test can check what a launch withheld.
//
// Causality: a recorded response waits until the client sent the request
// with that id; a recorded server request is emitted and then waits for the
// client's reply with that id; notifications emit in order. A client request
// whose method does not match the run's recorded sequence fails loudly
// (exit 2), so a replay drift is a test failure, not a silent mismatch.
import { appendFileSync, existsSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// The executable gate's probe (codexExecutable.ts): FAKE_VERSION overrides
// the baseline the fake reports.
if (process.argv.includes('--version')) {
  console.log(`codex-cli ${process.env.FAKE_VERSION ?? '0.163.0'}`)
  process.exit(0)
}

if (!process.argv.includes('app-server')) {
  console.error('fake-codex-app-server must be spawned as `<fake> app-server`')
  process.exit(2)
}

if (process.env.FAKE_ENV_NAMES) writeFileSync(process.env.FAKE_ENV_NAMES, Object.keys(process.env).sort().join('\n'))

const runNumber = Number(process.env.FAKE_RUN ?? '1')
const defaultTranscript = fileURLToPath(
  new URL('../../src/server/chat/codex/__fixtures__/smoke-transcript.jsonl', import.meta.url),
)
const transcriptPath = process.env.FAKE_TRANSCRIPT ?? defaultTranscript

interface Record {
  dir: 'out' | 'in'
  line: string
}
/**
 * Test-double records (never in a recording), told apart by `fake` and
 * carrying no `dir`: `append` writes a line to a file — standing in for
 * Codex's rollout writer, never evidence of its timing; without `line` it
 * writes the rollout user row of the client's latest turn/start input —
 * and `gate` holds
 * the run until a path exists. The run splitter and the id correlator skip
 * them.
 */
type FakeRecord = { fake: 'append'; file: string; line?: string } | { fake: 'gate'; path: string } | { fake: 'assertInput'; input: unknown[] }
type AnyRecord = Record | FakeRecord
const isFake = (record: AnyRecord): record is FakeRecord => 'fake' in record
interface Message {
  jsonrpc?: unknown
  id?: unknown
  method?: unknown
  params?: unknown
  result?: unknown
  error?: unknown
}

const records: AnyRecord[] = (await Bun.file(transcriptPath).text())
  .split('\n')
  .filter(line => line.trim())
  .map(line => JSON.parse(line) as AnyRecord)

// Split into runs at each fresh `initialize` the recorded client sent.
const runs: Array<AnyRecord[]> = []
for (const record of records) {
  if (!isFake(record) && record.dir === 'out' && (JSON.parse(record.line) as Message).method === 'initialize') runs.push([])
  runs.at(-1)!.push(record)
}
const run = runs[runNumber - 1]
if (!run) {
  console.error(`FAKE_RUN=${runNumber} but the transcript has ${runs.length} runs`)
  process.exit(2)
}

type Step = { dir: 'out' | 'in'; message: Message; fake?: undefined } | { dir: 'fake'; message: Message; fake: FakeRecord }
const steps: Step[] = run.map(record => isFake(record)
  ? { dir: 'fake' as const, message: {}, fake: record }
  : { dir: record.dir, message: JSON.parse(record.line) as Message })
// Only the recorded client REQUESTS (method-bearing): the run's replies to
// server requests cross stdin without a method and are matched by id.
const expectedOut = steps
  .filter(step => step.dir === 'out' && step.message.method !== undefined)
  .map(step => String(step.message.method))
/** The client's request ids in arrival order, to correlate responses (N6). */
const sentIds: unknown[] = []
// Older recordings predate optional skill discovery. Answer an unscripted
// skills/list as unsupported, tracking its id offset without weakening the
// recorded-id check for any scripted request (including scripted discovery).
const skippedBefore: number[] = []
let skippedDiscovery = 0
const replies = new Map<unknown, unknown>()
const waiters: Array<{ ready: () => boolean; resume: () => void }> = []
const checkWaiters = () => {
  for (let i = waiters.length - 1; i >= 0; i--) {
    if (waiters[i]!.ready()) {
      waiters[i]!.resume()
      waiters.splice(i, 1)
    }
  }
}
const waitFor = async (ready: () => boolean) => {
  if (ready()) return
  await new Promise<void>(resolve => waiters.push({ ready, resume: resolve }))
}

const emit = (message: Message) => process.stdout.write(`${JSON.stringify(message)}\n`)

/** The latest turn/start params, for an `append` record without a line. */
let lastTurnInput: unknown = null
const rolloutUserRow = () => {
  const input = (lastTurnInput as { input?: Array<{ type?: string; text?: string }> } | null)?.input ?? []
  const content = input.filter(item => item.type === 'text').map(item => ({ type: 'input_text', text: item.text }))
  return JSON.stringify({ timestamp: new Date().toISOString(), type: 'response_item', payload: { type: 'message', role: 'user', content } })
}

const onClientLine = (line: string) => {
  if (!line.trim()) return
  const message = JSON.parse(line) as Message
  if (message.method !== undefined) {
    if (message.method === 'skills/list' && expectedOut[0] !== 'skills/list') {
      skippedDiscovery++
      emit({ id: message.id, error: { code: -32601, message: 'Skill discovery not scripted' } })
      return
    }
    const expected = expectedOut.shift()
    if (expected !== message.method) {
      console.error(`fake-codex-app-server: expected client ${expected ?? '<end of run>'}, got ${String(message.method)}`)
      process.exit(2)
    }
    if (message.id !== undefined) {
      sentIds.push(message.id)
      skippedBefore.push(skippedDiscovery)
    }
    if (message.method === 'turn/start') lastTurnInput = message.params
  } else if (message.id !== undefined) {
    // A reply to a recorded server request; the waiting step consumes it.
    replies.set(message.id, message)
  }
  checkWaiters()
}

let responseOrdinal = 0
;(async () => {
  for (const step of steps) {
    if (step.fake?.fake === 'append') appendFileSync(step.fake.file, `${step.fake.line ?? rolloutUserRow()}\n`)
    else if (step.fake?.fake === 'gate') {
      const gate = step.fake.path
      while (!existsSync(gate)) await Bun.sleep(10)
    } else if (step.fake?.fake === 'assertInput') {
      const input = (lastTurnInput as { input?: unknown[] } | null)?.input
      if (JSON.stringify(input) !== JSON.stringify(step.fake.input)) {
        console.error('fake-codex-app-server: native turn input did not match the expected text/skill identities')
        process.exit(2)
      }
    }
    if (step.dir !== 'in') continue
    const message = step.message
    if (message.method !== undefined && message.id !== undefined) {
      emit(message) // server request: the client's reply continues the run
      await waitFor(() => replies.has(message.id))
    } else if (message.method !== undefined) {
      emit(message) // notification, in order
    } else {
      // N6: correlate by position — a client id drift fails loudly (exit 2)
      // instead of hanging until the test timeout. A step with no id at all
      // mismatches the same way (R2-3) instead of waiting on `undefined`.
      const ordinal = responseOrdinal++
      await waitFor(() => sentIds.length > ordinal)
      const expectedId = typeof message.id === 'number' ? message.id + skippedBefore[ordinal]! : message.id
      if (sentIds[ordinal] !== expectedId) {
        console.error(`fake-codex-app-server: recorded response id ${String(message.id)} but the client's request #${ordinal} carried ${String(sentIds[ordinal])}`)
        process.exit(2)
      }
      emit({ ...message, id: sentIds[ordinal] })
    }
  }
  if (process.env.FAKE_EXIT_AFTER_REPLAY === '1') process.exit(0)
})()

let buffered = ''
;(async () => {
  for await (const chunk of Bun.stdin.stream()) {
    buffered += new TextDecoder().decode(chunk)
    let index
    while ((index = buffered.indexOf('\n')) !== -1) {
      onClientLine(buffered.slice(0, index))
      buffered = buffered.slice(index + 1)
    }
  }
  process.exit(0) // stdin closed: the client ended the child
})()
