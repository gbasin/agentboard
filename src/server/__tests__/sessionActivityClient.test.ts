import { afterEach, expect, test } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { SessionActivityClient } from '../sessionActivityClient'
import { activityKey, type ActivityRequest, type ActivityResponse, type ActivityPatch } from '../sessionActivityProtocol'
import type { Session } from '../../shared/types'
import type { SessionActivity } from '../../shared/activity'

const session = (patch: Partial<Session> = {}): Session => ({
  id: 'board:@1', tmuxWindow: 'board:@1', name: 'test', projectPath: '/private/project',
  source: 'managed', status: 'waiting', lastActivity: '', createdAt: '',
  agentType: 'codex', agentSessionId: 'parent', logFilePath: '/private/parent.jsonl', ...patch,
})
const activity = (running = 1): SessionActivity => ({
  main: { phase: 'model', label: 'Model turn active', tools: [] },
  running, blocked: 0, unknown: 0, total: running, truncated: false, subagents: [],
})
class FakeWorker {
  onmessage: ((e: MessageEvent<ActivityResponse>) => void) | null = null
  onerror: (() => void) | null = null
  onmessageerror: (() => void) | null = null
  requests: ActivityRequest[] = []
  terminated = false
  failDelivery = false
  postMessage(request: ActivityRequest) { if (this.failDelivery) throw new Error('delivery'); this.requests.push(request) }
  terminate() { this.terminated = true }
  scans() { return this.requests.filter(r => r.kind === 'scan') }
  reply(value: SessionActivity | undefined, key = activityKey(session()), id = this.scans().at(-1)!.id) {
    this.onmessage?.({ data: { id, patches: [{ key, activity: value }] } } as MessageEvent<ActivityResponse>)
  }
}
const clients: SessionActivityClient[] = []
afterEach(() => { for (const c of clients.splice(0)) c.dispose() })
function fake(timeoutMs = 10_000, publish?: (patches: ActivityPatch[]) => void) {
  const workers: FakeWorker[] = [], changes: ActivityPatch[][] = []
  const clock = { now: 1000 }
  const client = new SessionActivityClient(publish ?? (patches => changes.push(patches)), () => {
    const worker = new FakeWorker(); workers.push(worker); return worker as unknown as Worker
  }, timeoutMs, () => clock.now)
  clients.push(client)
  return { client, workers, changes, clock }
}

test('refresh is synchronous, strips unrelated data, coalesces scans, and skips unchanged publications', () => {
  const { client, workers, changes } = fake()
  const s = session({ lastUserMessage: 'never cross worker boundary' })
  expect(client.enrich([s])[0].activity).toBeUndefined()
  const worker = workers[0]
  expect(worker.requests.map(r => r.kind)).toEqual(['index', 'scan'])
  expect(JSON.stringify(worker.scans())).not.toContain('never cross')
  client.enrich([s]); client.enrich([s])
  expect(worker.scans()).toHaveLength(1)
  worker.reply(activity())
  expect(worker.scans()).toHaveLength(2)
  worker.reply(activity())
  expect(changes).toHaveLength(1)
  expect(client.enrich([s])[0].activity?.running).toBe(1)
  worker.reply(activity(2))
  expect(changes.at(-1)?.[0].activity?.running).toBe(2)
})

test('late replies cannot resurrect removed/rebound panes or a different tmux incarnation', () => {
  const { client, workers, changes } = fake()
  const first = session(), second = session({ agentSessionId: 'new-parent' })
  client.enrich([first]); client.enrich([second])
  workers[0].reply(activity(), activityKey(first))
  expect(changes).toHaveLength(0)
  const scanId = workers[0].scans().at(-1)!.id
  workers[0].reply(activity(2), activityKey(second), scanId - 1)
  expect(changes).toHaveLength(0)
  workers[0].reply(activity(2), activityKey(second))
  expect(changes).toHaveLength(1)
  const nextRun = session({ ...second, agentboardTags: { boardId: 'b', runId: 'new', serverPid: 200 } })
  expect(client.enrich([nextRun])[0].activity).toBeUndefined()
  client.enrich([])
  workers[0].reply(activity(), activityKey(nextRun))
  expect(changes).toHaveLength(1)
})

test('unsupported and remote sessions never spawn a worker; disposal fences callbacks', () => {
  const { client, workers, changes } = fake()
  const unsupported = [session({ remote: true }), session({ source: 'external' }), session({ agentType: 'pi' }), session({ logFilePath: undefined }), session({ agentSessionId: undefined })]
  expect(client.enrich(unsupported)).toEqual(unsupported)
  expect(workers).toHaveLength(0)
  client.enrich([session()])
  const callback = workers[0].onmessage!
  client.dispose()
  client.setIndex([])
  expect(client.enrich(unsupported)).toBe(unsupported)
  callback({ data: { id: 1, patches: [{ key: activityKey(session()), activity: activity() }] } } as MessageEvent<ActivityResponse>)
  expect(workers[0].terminated).toBe(true)
  expect(changes).toHaveLength(0)
})

test('worker and delivery failures clear stale observations and recover on a later refresh', () => {
  const { client, workers, changes, clock } = fake()
  const links = [{ ownId: 'child', parentId: 'parent', logPath: '/child' }]
  client.setIndex(links)
  client.enrich([session()]); workers[0].reply(activity())
  client.setIndex([])
  expect(workers[0].requests.at(-1)).toEqual({ kind: 'index', links: [] })
  client.enrich([session()])
  const oldCallback = workers[0].onmessage!
  workers[0].onerror!()
  expect(changes.at(-1)?.[0].activity).toBeUndefined()
  expect(workers[0].terminated).toBe(true)
  oldCallback({ data: { id: 2, patches: [{ key: activityKey(session()), activity: activity() }] } } as MessageEvent<ActivityResponse>)
  client.enrich([session()])
  expect(workers).toHaveLength(1)
  clock.now += 1000
  client.enrich([session()])
  workers[1].onmessageerror!()
  clock.now += 1000
  client.enrich([session()])
  workers[2].onmessage!({ data: { id: workers[2].scans()[0].id, error: 'scan failed' } } as MessageEvent<ActivityResponse>)
  clock.now += 1000
  client.enrich([session()])
  workers[3].failDelivery = true
  client.setIndex(links)
  expect(workers[3].terminated).toBe(true)
  clock.now += 1000
  client.enrich([session()])
  workers[4].reply(undefined)
  expect(client.enrich([session()])[0].activity).toBeUndefined()
})

test('timeout and constructor/send failures cannot hold the refresh path or leak workers', async () => {
  const { client, workers, clock } = fake(5)
  client.enrich([session()])
  await new Promise(resolve => setTimeout(resolve, 15))
  expect(workers[0].terminated).toBe(true)
  clock.now += 1000
  client.enrich([session()]); workers[1].reply(activity())
  const broken = new SessionActivityClient(() => {}, () => { throw new Error('cannot start') })
  clients.push(broken)
  expect(() => broken.enrich([session()])).not.toThrow()
  const delivery = new FakeWorker(); delivery.failDelivery = true
  const sender = new SessionActivityClient(() => {}, () => delivery as unknown as Worker)
  clients.push(sender)
  expect(() => sender.enrich([session()])).not.toThrow()
  expect(delivery.terminated).toBe(true)
  const observer = fake(10_000, () => { throw new Error('observer failed') })
  observer.client.enrich([session()]); observer.workers[0].reply(activity())
  expect(observer.client.enrich([session()])[0].activity?.running).toBe(1)
})

test('real activity worker scans Claude/Codex children and handles an index without main-thread I/O', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ab-worker-activity-'))
  const parent = path.join(root, 'parent.jsonl'), child = path.join(root, 'child.jsonl')
  const stamp = new Date().toISOString()
  const line = (type: string) => JSON.stringify({ type: 'event_msg', timestamp: stamp, payload: { type, turn_id: 't' } }) + '\n'
  await fs.writeFile(parent, line('task_started')); await fs.writeFile(child, line('task_started'))
  let resolve!: () => void
  const updated = new Promise<void>(r => { resolve = r })
  const changes: ActivityPatch[][] = []
  const client = new SessionActivityClient(patches => { changes.push(patches); resolve() })
  clients.push(client)
  client.setIndex([{ ownId: 'child', parentId: 'parent', logPath: child }])
  try {
    client.enrich([session({ logFilePath: parent })])
    await Promise.race([updated, new Promise((_, reject) => setTimeout(() => reject(new Error('worker did not respond')), 5000))])
    expect(changes[0][0].activity?.running).toBe(1)
  } finally { client.dispose(); await fs.rm(root, { recursive: true, force: true }) }
})

test('completed I/O progress extends the watchdog without abandoning a slow scan', async () => {
  const { client, workers } = fake(100)
  client.enrich([session()])
  await new Promise(resolve => setTimeout(resolve, 40))
  const id = workers[0].scans()[0].id
  workers[0].onmessage!({ data: { id, progress: true } } as MessageEvent<ActivityResponse>)
  await new Promise(resolve => setTimeout(resolve, 80))
  expect(workers[0].terminated).toBe(false)
  workers[0].reply(activity())
  expect(client.enrich([session()])[0].activity?.running).toBe(1)
})
