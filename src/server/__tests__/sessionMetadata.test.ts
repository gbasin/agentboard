import { afterEach, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { SessionMetadataClient } from '../sessionMetadataClient'
import type { AgentSessionRecord } from '../db'
import type { MetadataRequest, MetadataResponse, SessionMetadata } from '../sessionMetadataWorker'

const record = (logFilePath = '/private/test.jsonl'): AgentSessionRecord => ({
  id: 1, sessionId: 'metadata-test', logFilePath, projectPath: '/project', slug: null,
  agentType: 'claude', displayName: 'Original', createdAt: '', lastActivityAt: '',
  lastUserMessage: null, currentWindow: 'private:1', isHibernating: false,
  lastResumeError: null, wakeStartedAt: null, lastKnownLogSize: 123,
  isCodexExec: false, launchCommand: null,
})
const metadata = (number: number): SessionMetadata => ({
  prs: [{ url: `https://github.com/a/b/pull/${number}`, repo: 'a/b', number }],
})
class FakeWorker {
  onmessage: ((event: MessageEvent<MetadataResponse>) => void) | null = null
  onerror: (() => void) | null = null
  onmessageerror: (() => void) | null = null
  requests: MetadataRequest[] = []
  postMessage(request: MetadataRequest) { this.requests.push(request) }
  scans() { return this.requests.filter((r) => r.kind === 'scan') }
  reply(value: SessionMetadata, id = this.scans().at(-1)!.id) {
    this.onmessage?.({ data: { id, metadata: value } } as MessageEvent<MetadataResponse>)
  }
}
const clients: SessionMetadataClient[] = []
const roots: string[] = []
afterEach(() => {
  for (const client of clients.splice(0)) client.dispose()
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})
const tick = () => new Promise<void>((resolve) => queueMicrotask(resolve))

function fake() {
  const workers: FakeWorker[] = []
  const changes: { record: AgentSessionRecord; metadata: SessionMetadata }[] = []
  const client = new SessionMetadataClient((record, metadata) => changes.push({ record, metadata }), () => {
    const worker = new FakeWorker()
    workers.push(worker)
    return worker as unknown as Worker
  })
  clients.push(client)
  return { client, workers, changes }
}

test('two views share one scan; a completed unchanged refresh does not republish', async () => {
  const { client, workers, changes } = fake()
  const a = record()
  client.queue(a); client.queue(a)
  await tick()
  client.queue(a)
  expect(workers[0].scans()).toHaveLength(1)
  workers[0].reply(metadata(1))
  expect(client.get(a)).toEqual(metadata(1))
  client.queue(a)
  await tick()
  workers[0].reply(metadata(1))
  expect(changes).toHaveLength(1)
})

test('old path responses and duplicate replies cannot replace a new identity', async () => {
  const { client, workers, changes } = fake()
  const a = record('/a'), b = record('/b')
  client.queue(a); await tick()
  client.queue(b)
  workers[0].reply(metadata(1))
  expect(changes).toHaveLength(0)
  expect(client.get(b).prs).toEqual([])
  await tick()
  workers[0].reply(metadata(2))
  workers[0].reply(metadata(1), 1)
  expect(client.get(b)).toEqual(metadata(2))
  expect(client.get(a).prs).toEqual([])
})

test('growth and late Codex linkage are rescanned without queuing duplicate work', async () => {
  const { client, workers } = fake()
  const a = record()
  client.queue(a); await tick()
  client.queue({ ...a, lastKnownLogSize: 456 })
  client.queue({ ...a, lastKnownLogSize: 789 })
  workers[0].reply(metadata(1)); await tick()
  expect(workers[0].scans()).toHaveLength(2)
  expect(workers[0].scans()[1].record.lastKnownLogSize).toBe(789)
  client.setIndex([{ ownId: 'child', parentId: a.sessionId, logPath: '/child' }])
  workers[0].reply(metadata(2)); await tick()
  expect(workers[0].scans()).toHaveLength(3)
})

test('active rows precede queued history, worker failure retains results, and stop ignores replies', async () => {
  const { client, workers, changes } = fake()
  const a = record()
  client.queue({ ...a, sessionId: 'history', currentWindow: null })
  client.queue(a); await tick()
  expect(workers[0].scans()[0].record.sessionId).toBe(a.sessionId)
  workers[0].reply(metadata(1)); await tick()
  workers[0].onerror?.()
  expect(client.get(a)).toEqual(metadata(1))
  client.queue(a); await tick()
  expect(workers).toHaveLength(1)
  await until(() => workers.length === 2)
  const late = workers[1].onmessage!
  client.dispose()
  late({ data: { id: workers[1].scans()[0].id, metadata: metadata(3) } } as MessageEvent<MetadataResponse>)
  expect(changes).toHaveLength(1)
})

function pr(n: number) {
  return JSON.stringify({ type: 'pr-link', prUrl: `https://github.com/a/b/pull/${n}`, prRepository: 'a/b', prNumber: n }) + '\n'
}
function frame(label: string) {
  return JSON.stringify({ type: 'frame-link', frameUrl: `https://example.com/${label}`, title: label }) + '\n'
}
async function until(predicate: () => boolean) {
  const deadline = Date.now() + 5000
  while (!predicate() && Date.now() < deadline) await Bun.sleep(10)
  expect(predicate()).toBe(true)
}

test('real worker preserves append, same-size rewrite, truncation, new/deleted children, and media-only changes', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'metadata-worker-'))
  roots.push(root)
  const log = path.join(root, 'parent.jsonl')
  const a = record(log)
  fs.writeFileSync(log, pr(1))
  const client = new SessionMetadataClient(() => {}, undefined, path.join(root, 'media.sqlite'))
  clients.push(client)
  client.queue(a)
  await until(() => client.get(a).prs[0]?.number === 1)
  // Same size and deliberately unchanged DB size: filesystem freshness wins.
  fs.writeFileSync(log, pr(2))
  const later = new Date(Date.now() + 2000)
  fs.utimesSync(log, later, later)
  client.queue(a)
  await until(() => client.get(a).prs[0]?.number === 2)
  fs.appendFileSync(log, frame('media'))
  client.queue(a)
  await until(() => client.get(a).mediaSummary?.total === 1)
  const children = path.join(root, 'parent', 'subagents')
  fs.mkdirSync(children, { recursive: true })
  const child = path.join(children, 'agent-1.jsonl')
  fs.writeFileSync(child, pr(3))
  client.queue(a)
  await until(() => client.get(a).prs.length === 2)
  fs.rmSync(child)
  fs.writeFileSync(log, pr(4))
  client.queue(a)
  await until(() => client.get(a).prs.length === 1 && client.get(a).prs[0].number === 4 && client.get(a).mediaSummary?.total === 0)
  fs.rmSync(log)
  client.queue(a)
  await until(() => client.get(a).prs.length === 0)
})

test('real worker receives late and transitive Codex child links', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'metadata-codex-'))
  roots.push(root)
  const a = { ...record(path.join(root, 'parent.jsonl')), agentType: 'codex' as const }
  fs.writeFileSync(a.logFilePath, pr(1))
  const child = path.join(root, 'child.jsonl')
  fs.writeFileSync(child, pr(2))
  const client = new SessionMetadataClient(() => {}, undefined, path.join(root, 'media.sqlite'))
  clients.push(client)
  client.queue(a)
  await until(() => client.get(a).prs.length === 1)
  client.setIndex([
    { ownId: 'child', parentId: a.sessionId, logPath: path.join(root, 'missing.jsonl') },
    { ownId: 'grandchild', parentId: 'child', logPath: child },
  ])
  client.queue(a)
  await until(() => client.get(a).prs.length === 2)
})

test('publication after hibernation, rename, reassociation or deletion never restores old session state', async () => {
  const { SessionRegistry } = await import('../SessionRegistry')
  const { publishSessionMetadata } = await import('../sessionMetadataViews')
  const { toAgentSession } = await import('../agentSessions')
  const registry = new SessionRegistry()
  const a = record()
  const sleeping = { ...toAgentSession({ ...a, currentWindow: null, isHibernating: true }, { cachedPrsOnly: true }), host: 'local', displayName: 'Renamed' }
  registry.setAgentSessions([], [sleeping], [])
  publishSessionMetadata(registry, a, metadata(1), 'local')
  expect(registry.getAll()).toEqual([])
  expect(registry.getAgentSessions().active).toEqual([])
  expect(registry.getAgentSessions().hibernating[0]).toEqual({ ...sleeping, ...metadata(1) })
  // Another log identity and a remote host must not receive A's metadata.
  const other = { ...sleeping, logFilePath: '/new-log' }
  const remote = { ...sleeping, host: 'remote' }
  registry.setAgentSessions([other, remote], [], [])
  publishSessionMetadata(registry, a, metadata(2), 'local')
  expect(registry.getAgentSessions().active).toEqual([other, remote])
  registry.setAgentSessions([], [], [])
  publishSessionMetadata(registry, a, metadata(3), 'local')
  expect(registry.getAgentSessions()).toEqual({ active: [], hibernating: [], history: [] })
})

test('HTTP scans coalesce, resolve fresh descriptors, and reject on shutdown or identity replacement', async () => {
  const { client, workers } = fake()
  const a = record()
  const first = client.scan(a), second = client.scan(a)
  await tick()
  expect(workers[0].scans()).toHaveLength(1)
  workers[0].reply(metadata(7))
  expect(await first).toEqual(metadata(7))
  expect(await second).toEqual(metadata(7))
  const third = client.scan(a).catch((error: Error) => error)
  await tick()
  const replaced = client.scan({ ...a, logFilePath: '/other' }).catch((error: Error) => error)
  client.queue({ ...a, logFilePath: '/third' })
  expect(await replaced).toBeInstanceOf(Error)
  client.dispose()
  expect(await third).toBeInstanceOf(Error)
})

test('HTTP scan errors and worker failures settle pending requests', async () => {
  const { client, workers } = fake()
  const first = client.scan(record()).catch((error: Error) => error)
  await tick()
  workers[0].onmessage?.({ data: { id: 1, error: 'unreadable' } } as MessageEvent<MetadataResponse>)
  expect(await first).toEqual(new Error('unreadable'))
  const second = client.scan(record()).catch((error: Error) => error)
  await tick()
  workers[0].onerror?.()
  expect(await second).toEqual(new Error('Metadata worker failed'))
})

test('real worker preserves image payload byte offsets and session-media URLs', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'metadata-image-'))
  roots.push(root)
  const a = record(path.join(root, 'image.jsonl'))
  const prefix = pr(1)
  const data = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhHGAfKmMIwAAAABJRU5ErkJggg=='
  fs.writeFileSync(a.logFilePath, prefix + JSON.stringify({ type: 'user', message: {
    role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data } }],
  } }) + '\n')
  const client = new SessionMetadataClient(() => {}, undefined, path.join(root, 'media.sqlite'))
  clients.push(client)
  const result = await client.scan(a)
  expect(result.prs).toEqual(metadata(1).prs)
  expect(result.mediaSummary?.total).toBe(1)
  expect('media' in result).toBe(false)
  const page = await client.page(a)
  const descriptor = page.items[0]
  const url = new URL(descriptor.url, 'http://localhost')
  expect(url.pathname).toBe(`/api/session-media/${a.sessionId}`)
  expect(url.searchParams.get('path')).toBe(a.logFilePath)
  expect(url.searchParams.get('offset')).toBe(String(Buffer.byteLength(prefix)))
  expect(url.searchParams.get('index')).toBe('0')
  expect(url.searchParams.get('digest')).toMatch(/^[0-9a-f]{64}$/)
  expect(descriptor.mediaType).toBe('image/png')
  expect(descriptor.bytes).toBe(Buffer.from(data, 'base64').length)
})

test('HTTP reads wait beyond an older in-flight scan, including known growth and index updates', async () => {
  const { client, workers } = fake()
  const a = record()
  client.queue(a); await tick()
  let completed = false
  const fresh = client.scan({ ...a, lastKnownLogSize: 999 }).then((value) => {
    completed = true
    return value
  })
  workers[0].reply(metadata(1)); await tick()
  expect(completed).toBe(false)
  workers[0].reply(metadata(2))
  expect(await fresh).toEqual(metadata(2))
  client.queue(a); await tick()
  client.setIndex([{ ownId: 'child', parentId: a.sessionId, logPath: '/child' }])
  completed = false
  const indexed = client.scan(a).then((value) => { completed = true; return value })
  workers[0].reply(metadata(3)); await tick()
  expect(completed).toBe(false)
  workers[0].reply(metadata(4))
  expect(await indexed).toEqual(metadata(4))
})

test('worker recovery retries interrupted and pending dormant scans without another refresh', async () => {
  const { client, workers } = fake()
  const a = { ...record(), sessionId: 'first', currentWindow: null }
  const b = { ...record(), sessionId: 'second', currentWindow: null }
  client.queue(a); client.queue(b); await tick()
  workers[0].onerror?.()
  await tick()
  expect(workers).toHaveLength(1)
  await until(() => workers.length === 2)
  const first = workers[1].scans()[0].record
  workers[1].reply(metadata(1)); await tick()
  const second = workers[1].scans()[1].record
  workers[1].reply(metadata(2))
  expect(new Set([first.sessionId, second.sessionId])).toEqual(new Set(['first', 'second']))
  expect(client.get(a).prs).toHaveLength(1)
  expect(client.get(b).prs).toHaveLength(1)
})

test('page RPC propagates stale cursor errors and rejects pending requests on worker failure/dispose', async () => {
  const { client, workers } = fake()
  const a = record()
  const first = client.page(a, 'expired').catch((error: Error & { code?: string }) => error)
  const page = workers[0].requests.find(r => r.kind === 'page')!
  expect(page.kind).toBe('page')
  if (page.kind !== 'page') throw Error('Missing page')
  workers[0].onmessage?.({ data: { id: page.id, error: 'Refresh media', code: 'STALE_CURSOR' } } as MessageEvent<MetadataResponse>)
  expect(await first).toMatchObject({ code: 'STALE_CURSOR' })
  const second = client.page(a).catch((error: Error) => error)
  workers[0].onerror?.()
  expect(await second).toBeInstanceOf(Error)
  const third = client.page(a).catch((error: Error) => error)
  client.dispose()
  expect(await third).toBeInstanceOf(Error)
})

test('page response for a replaced identity cannot publish its summary or resolve as current data', async () => {
  const { client, workers, changes } = fake()
  const a = record('/old'), b = record('/new')
  const pending = client.page(a).catch((error: Error) => error)
  const page = workers[0].requests.find(r => r.kind === 'page')!
  if (page.kind !== 'page') throw Error('Missing page')
  client.queue(b)
  workers[0].onmessage?.(new MessageEvent<MetadataResponse>('message', { data: { id: page.id, metadata: metadata(1), page: {
    identity: 'old', revision: 'v1', items: [], total: 0, nextCursor: null,
  } } }))
  expect(await pending).toBeInstanceOf(Error)
  expect(changes).toHaveLength(0)
})

test('payload repair coalesces storms, rejects obsolete identities, and survives worker failure', async () => {
  const { client, workers } = fake()
  const a = record('/old'), b = record('/new')
  client.queue(a); await tick()
  workers[0].reply(metadata(1))
  for (let i = 0; i < 1000; i++) client.invalidate(a)
  await tick()
  expect(workers[0].scans()).toHaveLength(2)
  expect(workers[0].scans()[1].force).toBe(true)
  workers[0].onerror?.()
  await until(() => workers.length === 2)
  expect(workers[1].scans()[0].force).toBe(true)
  workers[1].reply(metadata(2))
  client.invalidate(a); await tick()
  expect(workers[1].scans()).toHaveLength(1)
  client.queue(b); await tick()
  workers[1].reply(metadata(3))
  client.invalidate(a); await tick()
  expect(workers[1].scans()).toHaveLength(2)
})

test('a page waits for a queued repair before reading the index', async () => {
  const { client, workers } = fake()
  const a = record()
  client.invalidate(a)
  const page = client.page(a)
  await tick()
  expect(workers[0].scans()[0].force).toBe(true)
  expect(workers[0].requests.filter(r => r.kind === 'page')).toHaveLength(0)
  workers[0].reply(metadata(1))
  await tick()
  const request = workers[0].requests.find(r => r.kind === 'page')!
  if (request.kind !== 'page') throw Error('Missing page')
  workers[0].onmessage?.(new MessageEvent<MetadataResponse>('message', { data: { id: request.id, metadata: metadata(1), page: {
    identity: 'a', revision: 'new', items: [], total: 0, nextCursor: null,
  } } }))
  expect((await page).revision).toBe('new')
})

test('timed-out page requests retain admission slots until the worker responds', async () => {
  const worker = new FakeWorker()
  const client = new SessionMetadataClient(() => {}, () => worker as unknown as Worker, ':memory:', 10)
  clients.push(client)
  const requests = Array.from({ length: 32 }, () => client.page(record()).catch((error: Error) => error))
  await Promise.all(requests)
  expect(worker.requests.filter(r => r.kind === 'page')).toHaveLength(32)
  for (let i = 0; i < 32; i++) {
    expect(await client.page(record()).catch((error: Error) => error)).toEqual(new Error('Too many pending media requests'))
  }
  expect(worker.requests.filter(r => r.kind === 'page')).toHaveLength(32)
  const first = worker.requests.find(r => r.kind === 'page')!
  if (first.kind !== 'page') throw Error('Missing page')
  worker.onmessage?.(new MessageEvent<MetadataResponse>('message', { data: { id: first.id, error: 'Finished late' } }))
  const next = client.page(record()).catch((error: Error) => error)
  expect(worker.requests.filter(r => r.kind === 'page')).toHaveLength(33)
  client.dispose()
  expect(await next).toBeInstanceOf(Error)
})

test('neighbor RPC shares page admission and rejects mismatched result forms', async () => {
  const worker = new FakeWorker()
  const client = new SessionMetadataClient(() => {}, () => worker as unknown as Worker, ':memory:', 10)
  clients.push(client)
  const jobs = Array.from({ length: 32 }, (_, i) => (i % 2 ? client.page(record()) : client.neighbors(record(), 'anchor')).catch(e => e))
  await Promise.all(jobs)
  expect(worker.requests.filter(r => r.kind === 'page' || r.kind === 'neighbors')).toHaveLength(32)
  expect(await client.neighbors(record(), 'anchor').catch(e => e.message)).toBe('Too many pending media requests')
  const first = worker.requests.find(r => r.kind === 'neighbors')!
  if (first.kind !== 'neighbors') throw Error('Missing neighbors')
  worker.onmessage?.(new MessageEvent<MetadataResponse>('message', { data: { id: first.id, error: 'Done late' } }))
  const next = client.neighbors(record(), 'anchor').catch(e => e.message)
  const request = worker.requests.at(-1)!
  if (request.kind !== 'neighbors') throw Error('Missing neighbors')
  worker.onmessage?.(new MessageEvent<MetadataResponse>('message', { data: { id: request.id, metadata: metadata(1), page: {
    identity: 'a', revision: 'r', total: 0, items: [], nextCursor: null,
  } } }))
  expect(await next).toBe('Missing media detail')
})

test('real metadata worker navigates neighboring images after append and rejects stale anchors', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'metadata-neighbors-')); roots.push(root)
  const a = record(path.join(root, 'images.jsonl'))
  const image = (i: number) => JSON.stringify({ type: 'user', message: { content: [
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: Buffer.from(`image-${i}`).toString('base64') } },
  ] } }) + '\n'
  fs.writeFileSync(a.logFilePath, image(0))
  const client = new SessionMetadataClient(() => {}, undefined, path.join(root, 'media.sqlite')); clients.push(client)
  const first = (await client.page(a)).items[0]
  const initial = await client.neighbors(a, first.url)
  expect(initial.current).toEqual(first); expect(initial.previous).toBeNull(); expect(initial.next).toBeNull()
  fs.appendFileSync(a.logFilePath, image(1))
  const appended = await client.neighbors(a, first.url)
  expect(appended.next).not.toBeNull()
  expect((await client.neighbors(a, appended.next!.url)).previous).toEqual(first)
  fs.writeFileSync(a.logFilePath, image(2))
  const stale = await client.neighbors(a, first.url).catch(error => error)
  expect(stale.code).toBe('STALE_ANCHOR')
})

test('neighbor responses cannot publish or resolve after session reassociation', async () => {
  const { client, workers, changes } = fake()
  const original = record('/old')
  const result = client.neighbors(original, 'anchor').catch(error => error)
  const request = workers[0].requests.find(r => r.kind === 'neighbors')!
  if (request.kind !== 'neighbors') throw Error('Missing neighbors')
  client.queue(record('/new'))
  workers[0].onmessage?.(new MessageEvent<MetadataResponse>('message', { data: { id: request.id, metadata: metadata(1), neighbors: {
    identity: 'old', revision: 'r', current: { kind: 'image', url: 'anchor' }, previous: null, next: null,
  } } }))
  expect((await result).code).toBe('STALE_CURSOR')
  expect(changes).toHaveLength(0)
})
