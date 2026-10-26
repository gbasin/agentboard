import { describe, expect, test } from 'bun:test'
import {
  GhRequestQueue,
  runGhRequest,
  type GhResult,
  type GhProcess,
} from '../ghRequestQueue'

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
const request = { repo: 'owner/repo', number: 1, fields: 'state' }
const stream = (text = '') => new Blob([text]).stream()

function processFixture() {
  const exit = Promise.withResolvers<number>()
  const kills: string[] = []
  const proc: GhProcess = {
    stdout: stream('{"state":"OPEN"}'),
    stderr: stream('diagnostic'),
    exited: exit.promise,
    kill: (signal) => {
      kills.push(signal)
    },
  }
  return { proc, exit, kills }
}

describe('PR gh admission', () => {
  test('shares four slots across tiers and starts waiting jobs in FIFO order', async () => {
    const started: string[] = []
    const pending = Array.from({ length: 7 }, () =>
      Promise.withResolvers<GhResult>()
    )
    const queue = new GhRequestQueue(async (r) => {
      started.push(`${r.number}:${r.fields}`)
      return pending[r.number].promise
    })
    const results = Array.from({ length: 7 }, (_, i) =>
      queue.request('o/r', i, i % 2 ? 'checks' : 'info')
    )
    expect(started).toEqual(['0:info', '1:checks', '2:info', '3:checks'])
    pending[2].resolve({})
    await tick()
    expect(started.at(-1)).toBe('4:info')
    pending[0].resolve({})
    await tick()
    expect(started.at(-1)).toBe('5:checks')
    pending.forEach((p) => p.resolve({}))
    await Promise.all(results)
    expect(started).toHaveLength(7)
  })

  test('deduplicates running and queued keys even at capacity; new keys fail closed', async () => {
    const pending = Promise.withResolvers<GhResult>()
    let starts = 0
    const queue = new GhRequestQueue(
      async () => {
        starts++
        return pending.promise
      },
      1,
      128
    )
    const first = queue.request('o/r', 0, 'info')
    const results = Array.from({ length: 127 }, (_, i) =>
      queue.request('o/r', i + 1, 'info')
    )
    expect(queue.request('o/r', 0, 'info')).toBe(first)
    expect(queue.request('o/r', 127, 'info')).toBe(results[126])
    expect(await queue.request('o/r', 128, 'info')).toBeNull()
    expect(await queue.request('o/r', 0, 'checks')).toBeNull()
    expect(starts).toBe(1)
    pending.resolve({ state: 'OPEN' })
    await Promise.all([first, ...results])
    expect(starts).toBe(128)
    expect(await queue.request('o/r', 128, 'info')).toEqual({ state: 'OPEN' })
  })

  test('runner errors release admission and allow the next FIFO job', async () => {
    const queue = new GhRequestQueue(async (r) => {
      if (r.number === 1) throw new Error('missing gh')
      return { state: 'OPEN' }
    }, 1)
    expect(await queue.request('o/r', 1, 'info')).toBeNull()
    expect(await queue.request('o/r', 2, 'info')).toEqual({ state: 'OPEN' })
  })

  test('timeout kills but retains admission until actual exit', async () => {
    const fixture = processFixture()
    let starts = 0
    const queue = new GhRequestQueue((r) => {
      starts++
      return starts === 1
        ? runGhRequest(r, () => fixture.proc, 10)
        : Promise.resolve({})
    }, 1)
    const first = queue.request('o/r', 1, 'info')
    const second = queue.request('o/r', 2, 'checks')
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(fixture.kills).toEqual(['SIGKILL'])
    expect(starts).toBe(1)
    expect(queue.request('o/r', 1, 'info')).toBe(first)
    fixture.exit.resolve(0)
    expect(await first).toBeNull()
    await second
    expect(starts).toBe(2)
  })

  test('drains stderr concurrently, supplies explicit environment and parses stdout', async () => {
    const fixture = processFixture()
    let drained = false
    fixture.proc.stderr = new ReadableStream({
      pull(controller) {
        drained = true
        controller.close()
        fixture.exit.resolve(0)
      },
    })
    const result = await runGhRequest(request, (args, options) => {
      expect(args).toEqual([
        'gh',
        'pr',
        'view',
        '1',
        '--repo',
        'owner/repo',
        '--json',
        'state',
      ])
      expect(options.env).toBeDefined()
      expect(options.env.NODE_ENV).toBeUndefined()
      return fixture.proc
    })
    expect(drained).toBe(true)
    expect(result).toEqual({ state: 'OPEN' })
    expect(fixture.kills).toEqual([])
  })

  test('pipe failure kills process and still waits for exit before freeing the slot', async () => {
    const fixture = processFixture()
    fixture.proc.stderr = new ReadableStream({
      start(c) {
        c.error(new Error('read failed'))
      },
    })
    let settled = false
    const result = runGhRequest(request, () => fixture.proc).then((value) => {
      settled = true
      return value
    })
    await tick()
    expect(fixture.kills).toEqual(['SIGKILL'])
    expect(settled).toBe(false)
    fixture.exit.resolve(1)
    expect(await result).toBeNull()
  })

  test('rejects invalid JSON and nonzero exits', async () => {
    for (const [stdout, code] of [
      ['no json', 0],
      ['{}', 1],
      ['null', 0],
    ] as const) {
      const fixture = processFixture()
      fixture.proc.stdout = stream(stdout)
      fixture.exit.resolve(code)
      expect(await runGhRequest(request, () => fixture.proc)).toBeNull()
    }
  })
})
