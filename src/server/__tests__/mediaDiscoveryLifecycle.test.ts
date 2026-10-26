import { afterEach, expect, spyOn, test } from 'bun:test'
import { MediaDiscoveryClient, type MediaDiscoveryRpc } from '../mediaDiscovery'
import type { AgentSessionRecord } from '../db'
import type { CodexSubagentLink } from '../logMatchWorkerTypes'
import type { MediaSummary } from '../../shared/media'

type Command = Parameters<MediaDiscoveryRpc['request']>[0]
type Response = Awaited<ReturnType<MediaDiscoveryRpc['request']>>
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const pause = () => new Promise(resolve => setTimeout(resolve, 1))
async function until(check: () => boolean) {
  for (let n = 0; n < 2000; n++) { if (check()) return; await pause() }
  throw Error('Coordinator did not reach expected state')
}
const cleanups: (() => void)[] = []
afterEach(() => { for (const dispose of cleanups.splice(0)) dispose() })
const record = (id = 'main', active = true) => ({ sessionId: id, logFilePath: `/fixture/${id}.jsonl`,
  agentType: 'claude', currentWindow: active ? '@1' : null, lastKnownLogSize: 1 }) as AgentSessionRecord
const summary = (id = 'main', ready = false): MediaSummary => ({ identity: id, revision: '1', total: 0,
  images: 0, documents: 0, links: 0, additions: 0,
  discovery: ready ? { status: 'ready' } : { status: 'indexing', bytesRead: 1, bytesTotal: 10, filesDone: 0, filesTotal: 1 } })
class FakeRpc implements MediaDiscoveryRpc {
  exited = false
  disposed = false
  calls: Command[] = []
  steps: { command: Extract<Command, { kind: 'step' }>; result: ReturnType<typeof deferred<Response>> }[] = []
  idle = Promise.resolve()
  open?: () => Promise<Response>
  cancel?: () => Promise<Response>
  request(command: Command): Promise<Response> {
    this.calls.push(command)
    if (command.kind === 'open') return this.open?.() ?? Promise.resolve({ id: 0, value: null })
    if (command.kind === 'cancel' && this.cancel) return this.cancel()
    if (command.kind === 'step') {
      const result = deferred<Response>()
      this.steps.push({ command, result })
      return result.promise
    }
    if (command.kind === 'page') return Promise.resolve({ id: 0, value: {
      identity: command.record.sessionId, revision: '1', total: 0, items: [], nextCursor: null, discovery: { status: 'pending' },
    } })
    return Promise.resolve({ id: 0, value: summary(command.record.sessionId) })
  }
  whenIdle() { return this.idle }
  dispose() { this.disposed = true; for (const step of this.steps) step.result.reject(Error('disposed')) }
  finish(n: number, done = false) {
    const step = this.steps[n]
    step.result.resolve({ id: n, value: summary(step.command.record.sessionId, done), done })
  }
}
function fixture() {
  const writers: FakeRpc[] = [], readers: FakeRpc[] = []
  const client = new MediaDiscoveryClient(() => {}, { createRpc: name => {
    const rpc = new FakeRpc()
    ;(name.includes('Writer') ? writers : readers).push(rpc)
    return rpc
  } })
  cleanups.push(() => client.dispose())
  return { client, writers, readers }
}

test('timed-out unfinished work retains ownership until native settlement and resumes on the same writer', async () => {
  const { client, writers } = fixture()
  client.queue(record())
  await until(() => writers[0]?.steps.length === 1)
  const writer = writers[0], native = deferred<void>()
  writer.idle = native.promise
  writer.steps[0].result.reject(Object.assign(Error('timeout'), { code: 'MEDIA_TIMEOUT' }))
  await until(() => client.get(record()).discovery?.status === 'failed')
  client.queue(record('other'))
  await pause()
  expect(writer.steps).toHaveLength(1)
  native.resolve()
  await until(() => writer.steps.length === 2)
  writer.finish(1, true)
  await until(() => writer.steps.length === 3)
  expect(writer.steps.map(step => step.command.record.sessionId).sort()).toEqual(['main', 'main', 'other'])
  expect(writers).toHaveLength(1)
  expect(writer.calls.filter(call => call.kind === 'cancel')).toHaveLength(0)
  writer.finish(2, true)
})

test('confirmed exit replaces only the affected worker role', async () => {
  const { client, writers, readers } = fixture()
  const first = client.page(record())
  await first
  readers[0].exited = true
  const second = client.page(record())
  await second
  expect(writers).toHaveLength(1)
  expect(readers).toHaveLength(2)
  writers[0].exited = true
  await client.page(record())
  expect(writers).toHaveLength(2)
  expect(readers).toHaveLength(2)
})

test('an opening error does not poison future retries or replace a living worker', async () => {
  let attempts = 0
  const writer = new FakeRpc(), reader = new FakeRpc(), created: string[] = []
  writer.open = () => ++attempts === 1 ? Promise.reject(Error('temporary open failure')) : Promise.resolve({ id: 0, value: null })
  const client = new MediaDiscoveryClient(() => {}, { createRpc: name => { created.push(name); return name.includes('Writer') ? writer : reader } })
  cleanups.push(() => client.dispose())
  await expect(client.page(record())).rejects.toThrow('temporary open failure')
  await client.page(record())
  expect(attempts).toBe(2)
  expect(created).toHaveLength(2)
})

test('dispose while writer is opening cannot create a reader after late native success', async () => {
  const opening = deferred<Response>(), writer = new FakeRpc(), created: string[] = []
  writer.open = () => opening.promise
  const client = new MediaDiscoveryClient(() => {}, { createRpc: name => { created.push(name); return writer } })
  const page = client.page(record())
  client.dispose()
  opening.resolve({ id: 0, value: null })
  await expect(page).rejects.toThrow('disposed')
  expect(created).toEqual(['mediaDiscoveryWriterWorker'])
  expect(writer.disposed).toBe(true)
})

test('a viewed session preempts one of 32 retained background scanners', async () => {
  const { client, writers } = fixture()
  for (let n = 0; n < 32; n++) client.queue(record(`background-${n}`))
  for (let n = 0; n < 31; n++) {
    await until(() => writers[0]?.steps.length === n + 1)
    writers[0].finish(n)
  }
  await until(() => writers[0].steps.length === 32)
  const controller = new AbortController(), stream = client.watch(record('viewed', false), undefined, undefined, controller.signal)[Symbol.asyncIterator]()
  await stream.next()
  const next = stream.next()
  writers[0].finish(31)
  await until(() => writers[0].steps.length === 33)
  expect(writers[0].calls.filter(call => call.kind === 'cancel')).toHaveLength(1)
  expect(writers[0].steps[32].command.record.sessionId).toBe('viewed')
  controller.abort()
  await next
  await stream.return?.()
})

test('index updates during a pending step coalesce into the latest next-step payload', async () => {
  const { client, writers } = fixture()
  client.queue(record())
  await until(() => writers[0]?.steps.length === 1)
  const updates: CodexSubagentLink[][] = Array.from({ length: 20 }, (_, n) => [{ ownId: `child-${n}`, parentId: 'parent', logPath: `/fixture/child-${n}.jsonl` }])
  for (const links of updates) client.setIndex(links)
  expect(writers[0].calls.filter(call => call.kind !== 'open')).toHaveLength(1)
  writers[0].finish(0)
  await until(() => writers[0].steps.length === 2)
  expect(writers[0].steps[1].command.links).toEqual(updates.at(-1))
  writers[0].finish(1)
  await until(() => writers[0].steps.length === 3)
  expect(writers[0].steps[2].command.links).toBeUndefined()
})

test('a continuously viewed scan yields a slice to background work after four foreground slices', async () => {
  const { client, writers } = fixture()
  client.queue(record('background'))
  await until(() => writers[0]?.steps.length === 1)
  const controller = new AbortController(), stream = client.watch(record('viewed', false), undefined, undefined, controller.signal)[Symbol.asyncIterator]()
  await stream.next()
  const next = stream.next()
  writers[0].finish(0)
  for (let n = 1; n <= 4; n++) {
    await until(() => writers[0].steps.length === n + 1)
    expect(writers[0].steps[n].command.record.sessionId).toBe('viewed')
    writers[0].finish(n)
  }
  await until(() => writers[0].steps.length === 6)
  expect(writers[0].steps[5].command.record.sessionId).toBe('background')
  controller.abort()
  await next
  await stream.return?.()
})

test('a timed-out cancellation waits for native settlement before retrying and releasing queued work', async () => {
  const { client, writers } = fixture()
  client.queue(record())
  await until(() => writers[0]?.steps.length === 1)
  const writer = writers[0], native = deferred<void>()
  let cancels = 0
  writer.idle = native.promise
  writer.cancel = () => ++cancels === 1
    ? Promise.reject(Object.assign(Error('cancel timeout'), { code: 'MEDIA_TIMEOUT' }))
    : Promise.resolve({ id: 0, value: summary(), done: true })
  client.queue(record('main', false))
  writer.finish(0)
  await until(() => cancels === 1 && client.get(record()).discovery?.status === 'failed')
  client.queue(record('other'))
  await pause()
  expect(writer.steps).toHaveLength(1)
  expect(cancels).toBe(1)
  native.resolve()
  await until(() => writer.steps.length === 2)
  expect(cancels).toBe(2)
  expect(writer.steps[1].command.record.sessionId).toBe('other')
  expect(writers).toHaveLength(1)
  writer.finish(1, true)
})

test('queueing an existing job restarts the pump after initial worker opening fails', async () => {
  const writer = new FakeRpc(), reader = new FakeRpc()
  let opens = 0
  writer.open = () => ++opens === 1 ? Promise.reject(Error('initial open failure')) : Promise.resolve({ id: 0, value: null })
  const client = new MediaDiscoveryClient(() => {}, { createRpc: name => name.includes('Writer') ? writer : reader })
  cleanups.push(() => client.dispose())
  client.queue(record())
  await until(() => client.get(record()).discovery?.status === 'failed')
  expect(writer.steps).toHaveLength(0)
  client.queue(record())
  await until(() => writer.steps.length === 1)
  expect(opens).toBe(2)
  writer.finish(0, true)
  await until(() => client.get(record()).discovery?.status === 'ready')
})

test('completed active work skips unchanged refreshes but rescans changed size or subagent index generation', async () => {
  const { client, writers } = fixture()
  const active = record()
  client.queue(active)
  await until(() => writers[0]?.steps.length === 1)
  writers[0].finish(0, true)
  await until(() => client.get(active).discovery?.status === 'ready')
  for (let n = 0; n < 20; n++) client.queue({ ...active })
  await pause()
  expect(writers[0].steps).toHaveLength(1)

  const grown = { ...active, lastKnownLogSize: 2 }
  client.queue(grown)
  await until(() => writers[0].steps.length === 2)
  expect(writers[0].steps[1].command.record.lastKnownLogSize).toBe(2)
  writers[0].finish(1, true)
  // The previous ready summary can remain cached while the new step is pending.
  await pause()
  const links = [{ ownId: 'child', parentId: active.sessionId, logPath: '/fixture/child.jsonl' }]
  client.setIndex(links)
  client.queue(grown)
  await until(() => writers[0].steps.length === 3)
  expect(writers[0].steps[2].command.links).toEqual(links)
  writers[0].finish(2, true)
  await pause()
  client.setIndex(links.map(link => ({ ...link })))
  client.queue(grown)
  await pause()
  expect(writers[0].steps).toHaveLength(3)
})

test('unchanged active work rescans at the 30 second fallback for child growth and same-size rewrites', async () => {
  const { client, writers } = fixture()
  let now = 100_000
  const clock = spyOn(performance, 'now').mockImplementation(() => now)
  try {
    client.queue(record())
    await until(() => writers[0]?.steps.length === 1)
    writers[0].finish(0, true)
    await until(() => client.get(record()).discovery?.status === 'ready')
    now += 29_999
    client.queue(record())
    await pause()
    expect(writers[0].steps).toHaveLength(1)
    now++
    client.queue(record())
    await until(() => writers[0].steps.length === 2)
    expect(writers[0].steps[1].command.record.lastKnownLogSize).toBe(1)
    expect(writers[0].steps[1].command.links).toBeUndefined()
    writers[0].finish(1, true)
    await pause()
  } finally { clock.mockRestore() }
})

test('hydrating persisted indexing state reports pending without starting a dormant scan', async () => {
  const { client, writers, readers } = fixture()
  const dormant = record('dormant', false)
  client.queue(dormant)
  await until(() => client.get(dormant).revision === '1')
  expect(readers[0].calls.filter(call => call.kind === 'summary')).toHaveLength(1)
  expect(client.get(dormant).discovery).toEqual({ status: 'pending' })
  expect(writers[0].steps).toHaveLength(0)
})
