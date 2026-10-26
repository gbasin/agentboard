import { afterEach, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { SessionMetadataClient } from '../sessionMetadataClient'
import { FakeMediaDiscovery, pendingMedia } from './fixtures/fakeMediaDiscovery'
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
  mediaSummary: pendingMedia,
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
  const media = new FakeMediaDiscovery()
  const changes: { record: AgentSessionRecord; metadata: SessionMetadata }[] = []
  const client = new SessionMetadataClient((record, metadata) => changes.push({ record, metadata }), () => {
    const worker = new FakeWorker()
    workers.push(worker)
    return worker as unknown as Worker
  }, ':memory:', 30_000, changed => { media.changed = changed; return media })
  clients.push(client)
  return { client, workers, changes, media }
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
  await discover(client, a) // Explicit discovery bypasses the unchanged-size background cooldown.
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
  await discover(client, a)
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
  await discover(client, a)
  expect(client.get(a).mediaSummary?.total).toBe(1)
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

test('real metadata worker navigates neighboring images after append and rejects stale anchors', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'metadata-neighbors-')); roots.push(root)
  const a = record(path.join(root, 'images.jsonl'))
  const image = (i: number) => JSON.stringify({ type: 'user', message: { content: [
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: Buffer.from(`image-${i}`).toString('base64') } },
  ] } }) + '\n'
  fs.writeFileSync(a.logFilePath, image(0))
  const client = new SessionMetadataClient(() => {}, undefined, path.join(root, 'media.sqlite')); clients.push(client)
  await discover(client, a)
  const first = (await client.page(a)).items[0]
  const initial = await client.neighbors(a, first.url)
  expect(initial.current).toEqual(first); expect(initial.previous).toBeNull(); expect(initial.next).toBeNull()
  fs.appendFileSync(a.logFilePath, image(1))
  await discover(client, a)
  const appended = await client.neighbors(a, first.url)
  expect(appended.previous).not.toBeNull()
  expect((await client.neighbors(a, appended.previous!.url)).next).toEqual(first)
  fs.writeFileSync(a.logFilePath, image(2))
  await discover(client, a)
  const stale = await client.neighbors(a, first.url).catch(error => error)
  expect(stale.code).toBe('STALE_ANCHOR')
})

test('real worker keeps link search and image neighbors independent in the shared detail pipeline', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'metadata-links-neighbors-')); roots.push(root)
  const a = record(path.join(root, 'mixed.jsonl'))
  const image = (i: number) => ({ type: 'user', message: { content: [
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: Buffer.from(`image-${i}`).toString('base64') } },
  ] } })
  fs.writeFileSync(a.logFilePath, [image(0),
    { type: 'assistant', message: { role: 'assistant', content: 'Finished [Review report](https://example.com/report).' } },
    image(1),
  ].map(value => JSON.stringify(value) + '\n').join(''))
  const client = new SessionMetadataClient(() => {}, undefined, path.join(root, 'media.sqlite')); clients.push(client)
  await discover(client, a)
  const media = await client.page(a, undefined, { kind: 'media' })
  expect(media.total).toBe(2)
  expect(media.items.map(item => item.kind)).toEqual(['image', 'image'])
  const [links, neighbors] = await Promise.all([
    client.page(a, undefined, { kind: 'links', search: 'review report' }),
    client.neighbors(a, media.items[0].url),
  ])
  expect(links.total).toBe(1)
  expect(links.items[0].externalUrl).toBe('https://example.com/report')
  expect(neighbors.current).toEqual(media.items[0])
  expect(neighbors.previous).toBeNull()
  expect(neighbors.next).toEqual(media.items[1])
  expect((await client.neighbors(a, media.items[1].url)).previous).toEqual(media.items[0])
  expect((await client.page(a, undefined, { kind: 'links', search: 'missing' })).total).toBe(0)
})

async function discover(client: SessionMetadataClient, record: AgentSessionRecord) {
  for await (const event of client.watch(record)) {
    if (event.type === 'error') throw new Error(event.message)
  }
}

test('PR persistence resolves while media discovery is still pending, without media RPCs on the PR worker', async () => {
  const { client, workers, media, changes } = fake()
  const a = record()
  const result = client.scan(a)
  await tick()
  workers[0].reply(metadata(1))
  expect((await result).mediaSummary?.discovery?.status).toBe('pending')
  expect(media.queued).toHaveLength(1)
  expect(workers[0].requests.map(r => r.kind)).toEqual(['index', 'scan'])
  media.publish(a, { ...pendingMedia, revision: 'partial', total: 4, discovery: { status: 'indexing', bytesRead: 10, bytesTotal: 20, filesDone: 0, filesTotal: 1 } })
  expect(changes.at(-1)?.metadata.prs).toEqual(metadata(1).prs)
  client.queue(a); await tick()
  workers[0].reply(metadata(2))
  expect(changes.at(-1)?.metadata.mediaSummary?.total).toBe(4)
  expect(client.get(a).prs).toEqual(metadata(2).prs)
})

test('media reads, navigation, stream cancellation and failures do not depend on PR completion', async () => {
  const { client, workers, media } = fake()
  const a = record(), query = { kind: 'links' as const, search: 'report' }
  client.queue(a); await tick() // Leave PR scan deliberately unresolved.
  expect((await client.page(a, 'cursor', query)).revision).toBe('indexed')
  expect((await client.neighbors(a, 'anchor')).current.url).toBe('anchor')
  const controller = new AbortController()
  for await (const _event of client.watch(a, 'cursor', query, controller.signal)) { /* finite stream */ }
  expect(media.calls).toEqual([['page', a, 'cursor', query], ['neighbors', a, 'anchor'], ['watch', a, 'cursor', query, controller.signal]])
  expect(workers[0].requests.map(r => r.kind)).toEqual(['index', 'scan'])
  media.failure = Object.assign(new Error('old page'), { code: 'STALE_CURSOR' })
  expect(await client.page(a).catch(error => error.code)).toBe('STALE_CURSOR')
  workers[0].reply(metadata(3))
  workers[0].onerror?.()
  media.failure = null
  expect((await client.page(a)).revision).toBe('indexed')
  expect(client.get(a).prs).toEqual(metadata(3).prs)
})

test('late media publication cannot cross identities or survive disposal; repair and linkage delegate', async () => {
  const { client, media, changes } = fake()
  const old = record('/old'), current = record('/new')
  client.queue(old); client.queue(current)
  media.publish(old, { ...pendingMedia, total: 99 })
  expect(changes).toHaveLength(0)
  client.invalidate(old)
  client.invalidate(current)
  expect(media.invalidated).toEqual([current])
  const links = [{ ownId: 'child', parentId: current.sessionId, logPath: '/child' }]
  client.setIndex(links)
  expect(media.links).toEqual(links)
  media.publish(current, pendingMedia)
  expect(changes).toHaveLength(1)
  client.dispose()
  expect(media.disposed).toBe(true)
  media.publish(current, { ...pendingMedia, total: 12 })
  expect(changes).toHaveLength(1)
  expect(await client.page(current).catch(error => error.message)).toBe('Metadata worker disposed')
})
