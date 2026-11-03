// The effects runner (plan-execution D14, §10.1) over a fake adapter:
// success records done and notifies, a transient failure backs off under
// the 30 s / 2 m / 10 m schedule and succeeds on retry, three backoffs
// exhaust and the fourth failure fails the effect at once as permanent ones
// do, and a cancelled effect is never run.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Database } from 'bun:sqlite'
import { schemaDb } from './schemaDb'
import { ExecutionStore } from '../plans/execution/executionStore'
import { EffectRunner, type EffectAdapter, type EffectCallResult } from '../plans/execution/effects'
import { landingAdapters, updateBranchAdapter } from '../plans/execution/executionLanding'
import type { EffectRow } from '../plans/execution/executionRows'

const FLOOR = { lint: ['ci'], typecheck: ['ci'], 'unit-tests': ['ci'], 'ci-e2e': ['e2e'] }

let dir: string
let db: Database
let store: ExecutionStore
let executionId: string
let fake: FakeAdapter
let failures: Array<{ effectKey: string; message: string }>
let dones: Array<{ effectKey: string; outcome: unknown }>

/** A scripted adapter: each queued result is returned once, the last repeats. */
class FakeAdapter implements EffectAdapter {
  results: EffectCallResult[] = []
  calls: string[] = []
  async call(effect: EffectRow): Promise<EffectCallResult> {
    this.calls.push(effect.effectKey)
    return this.results.length > 1 ? this.results.shift()! : this.results[0] ?? { ok: true, outcome: null }
  }
}

const ok = (outcome: unknown): EffectCallResult => ({ ok: true, outcome })
const transient = (message = 'gh: Server Error (HTTP 502)'): EffectCallResult => ({ ok: false, error: { argv: ['gh'], exitCode: 1, httpStatus: 502, message } })
const permanent = (message = ' ! [rejected]  abc -> api (non-fast-forward)'): EffectCallResult => ({ ok: false, error: { argv: ['git'], exitCode: 1, stderr: message } })

let clock: number
const CLOCK0 = Date.parse('2026-10-17T09:00:00.000Z')

beforeEach(() => {
  clock = CLOCK0
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-effects-'))
  db = schemaDb(path.join(dir, 'exec.db'))
  store = new ExecutionStore(db, () => new Date(clock))
  const execution = store.insertExecution({
    teamId: 'team', planId: 'plan-1', revision: 1, contentHash: 'h', reportId: 'r', inputHash: 'i',
    landingMode: 'direct', baseBranch: 'master', baseCommit: 'abc', floor: { version: 1, map: FLOOR },
    maxParallel: 3, mergeMethod: 'merge', changes: [{ change: 'api', landed: false }],
  })
  executionId = execution.id
  fake = new FakeAdapter()
  failures = []
  dones = []
})
afterEach(() => {
  db.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

const runner = () => new EffectRunner({
  store, adapter: fake,
  backoffsMs: [30_000, 120_000, 600_000],
  now: () => new Date(clock),
  onFailed: (effect, error) => failures.push({ effectKey: effect.effectKey, message: error.message }),
  onDone: (effect, outcome) => dones.push({ effectKey: effect.effectKey, outcome }),
})
const insert = (key = 'exec:1:api:push:1:0') => store.insertEffect({
  // The key's round segment is the fixture's round id, so two keys are two
  // identities (A1) — one round's effect never adopts another's command.
  executionId, change: 'api', roundId: `round-${key.split(':')[4]}`, kind: 'push', effectKey: key, command: { ref: key },
})
const advance = (ms: number) => { clock += ms }

describe('EffectRunner', () => {
  test('success: the effect is done, its outcome recorded, the follow-on notified', async () => {
    fake.results = [ok({ pushed: true })]
    const effect = insert()
    await runner().runDue('team')
    expect(store.effect(effect.id)).toMatchObject({ state: 'done', outcome: { pushed: true }, tries: 0, finishedAt: new Date(clock).toISOString() })
    expect(dones).toEqual([{ effectKey: effect.effectKey, outcome: { pushed: true } }])
    expect(failures).toEqual([])
  })

  test('a transient failure backs off and the retry succeeds', async () => {
    fake.results = [transient(), ok('made it')]
    const effect = insert()
    await runner().runDue('team')
    const afterFirst = store.effect(effect.id)!
    expect(afterFirst).toMatchObject({ state: 'pending', tries: 1, nextAt: new Date(CLOCK0 + 30_000).toISOString() })
    expect(store.dueEffects('team', new Date(clock).toISOString())).toEqual([])
    advance(30_000)
    await runner().runDue('team')
    expect(store.effect(effect.id)).toMatchObject({ state: 'done', outcome: 'made it', tries: 1 })
    expect(fake.calls).toHaveLength(2)
  })

  test('three transients: three backoffs, the fourth failure fails the effect', async () => {
    fake.results = [transient(), transient(), transient(), transient()]
    const effect = insert()
    const run = runner()
    await run.runDue('team')
    expect(store.effect(effect.id)).toMatchObject({ state: 'pending', tries: 1, nextAt: new Date(CLOCK0 + 30_000).toISOString() })
    advance(30_000); await run.runDue('team')
    expect(store.effect(effect.id)).toMatchObject({ state: 'pending', tries: 2, nextAt: new Date(CLOCK0 + 30_000 + 120_000).toISOString() })
    advance(120_000); await run.runDue('team')
    expect(store.effect(effect.id)).toMatchObject({ state: 'pending', tries: 3, nextAt: new Date(CLOCK0 + 150_000 + 600_000).toISOString() })
    advance(600_000); await run.runDue('team')
    expect(store.effect(effect.id)).toMatchObject({ state: 'failed', tries: 3 })
    expect(failures.map(row => row.effectKey)).toEqual([effect.effectKey])
  })

  test('a permanent failure fails at once, carrying the message', async () => {
    fake.results = [permanent('non-fast-forward')]
    const effect = insert()
    await runner().runDue('team')
    expect(store.effect(effect.id)).toMatchObject({ state: 'failed', error: 'non-fast-forward' })
    expect(failures[0]!.message).toContain('non-fast-forward')
    expect(fake.calls).toHaveLength(1)
  })

  test('a cancelled effect is never run, and a finished execution runs nothing', async () => {
    const effect = insert('exec:1:api:provision:1:0')
    store.cancelEffects(executionId)
    await runner().runDue('team')
    expect(fake.calls).toEqual([])
    expect(store.effect(effect.id)).toMatchObject({ state: 'cancelled' })
    // Stop finishes the execution: a fresh effect of it is not due.
    store.finishExecution(executionId, 'stopped', 'enough')
    insert('exec:1:api:push:2:0')
    await runner().runDue('team')
    expect(fake.calls).toEqual([])
  })

  test('a step re-enqueued under its key returns the recorded row, never a second', () => {
    const first = insert('exec:1:api:open-pr:1:0')
    const again = insert('exec:1:api:open-pr:1:0')
    expect(again.id).toBe(first.id)
    expect(store.effectsOf(executionId)).toHaveLength(1)
  })

  test('an effect settled mid-batch is skipped: its adapter never runs and runDue does not count it (N3)', async () => {
    const first = insert('exec:1:api:push:1:0')
    const second = insert('exec:1:api:push:2:0')
    fake.results = [ok(null)]
    // The first effect's run sweeps the queue like a Stop (O3): the second
    // settles while the first runs.
    const run = new EffectRunner({
      store,
      adapter: {
        call: async effect => {
          if (effect.id === first.id) store.cancelEffects(executionId)
          return fake.call(effect)
        },
      },
      backoffsMs: [30_000, 120_000, 600_000],
      now: () => new Date(clock),
    })
    expect(await run.runDue('team')).toBe(1)
    expect(fake.calls).toEqual([first.effectKey])
    expect(store.effect(second.id)).toMatchObject({ state: 'cancelled' })
  })

  test('a call that times out reads as transient', async () => {
    fake.results = [{
      ok: false,
      error: { argv: ['timeout'], exitCode: null, stderr: 'the effect timed out after 5 ms' },
    }]
    const effect = insert()
    await new EffectRunner({ store, adapter: fake, timeoutMs: 5, backoffsMs: [1, 1, 1], now: () => new Date(clock) }).runOne(effect)
    expect(store.effect(effect.id)).toMatchObject({ state: 'pending', tries: 1 })
  })

  test('a real gh spawn failure through the landing adapter fails at once, with no backoff (D14 gh-spawn row)', async () => {
    // The production composition: the direct mechanism's update-branch
    // adapter over the real landing adapters (ghUpdateBranch → runGh), with
    // a PATH holding no gh — the adapter itself derives the spawn failure.
    const noGh = path.join(dir, 'no-gh-bin')
    fs.mkdirSync(noGh, { recursive: true })
    const effect = store.insertEffect({
      executionId, change: 'api', roundId: 'round-1', kind: 'update-branch',
      effectKey: 'exec:1:api:update-branch:1:0', command: { repo: 'owner/repo', pr: 7, head: 'aaa' },
    })
    const failures: Array<{ effectKey: string; message: string; transient: boolean }> = []
    const runner = new EffectRunner({
      store,
      adapter: updateBranchAdapter(landingAdapters, { env: { PATH: noGh } }),
      backoffsMs: [30_000, 120_000, 600_000],
      now: () => new Date(clock),
      onFailed: (row, error) => failures.push({ effectKey: row.effectKey, message: error.message, transient: error.transient }),
    })
    expect(await runner.runOne(effect)).toBe(true)
    const settled = store.effect(effect.id)!
    expect(settled.state).toBe('failed')
    expect(settled.tries).toBe(0)
    expect(settled.nextAt).toBeNull()
    expect(settled.error).toContain('gh could not be started')
    expect(failures).toHaveLength(1)
    expect(failures[0]!.effectKey).toBe(effect.effectKey)
    expect(failures[0]!.transient).toBe(false)
    expect(failures[0]!.message).toContain('gh could not be started')
  })
})
