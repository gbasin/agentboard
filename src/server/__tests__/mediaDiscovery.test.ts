import { afterEach, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { MediaDiscoveryClient } from '../mediaDiscovery'
import { DiscoveryRpc } from '../mediaDiscoveryRpc'
import { MediaIndex } from '../mediaIndex'
import type { AgentSessionRecord } from '../db'
import type { MediaPage, MediaSummary, MediaStreamEvent } from '../../shared/media'

const cleanup: (() => void)[] = []
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) fn(); await new Promise(resolve => setTimeout(resolve, 20)) })
const delay = (ms = 10) => new Promise(resolve => setTimeout(resolve, ms))
async function until(check: () => boolean, timeout = 5000) {
  const deadline = performance.now() + timeout
  while (!check()) { if (performance.now() >= deadline) throw Error('Timed out waiting for discovery state'); await delay() }
}
const line = (n: number) => JSON.stringify({ type: 'frame-link', frameUrl: `https://example.com/${n}`, title: `Item ${n}` }) + '\n'
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'media-discovery-'))
  // Worker shutdown is queued; delay file cleanup until its synchronous handler closes SQLite.
  cleanup.push(() => { setTimeout(() => fs.rmSync(root, { recursive: true, force: true }), 100).unref() })
  const indexPath = path.join(root, 'index.sqlite'), log = path.join(root, 'main.jsonl')
  const record = { sessionId: path.basename(root), logFilePath: log, agentType: 'claude', currentWindow: null,
    lastKnownLogSize: null } as AgentSessionRecord
  const changes: MediaSummary[] = []
  const client = new MediaDiscoveryClient((_record, summary) => changes.push(summary), { indexPath, requestTimeoutMs: 3000 })
  cleanup.push(() => client.dispose())
  return { root, log, indexPath, record, client, changes }
}
function largeTail(log: string, first = line(0)) {
  const padding = JSON.stringify({ type: 'ignored-fixture', padding: 'z'.repeat(64 * 1024) }) + '\n'
  fs.writeFileSync(log, first)
  const fd = fs.openSync(log, 'a')
  try { for (let n = 0; n < 600; n++) fs.writeSync(fd, padding) } finally { fs.closeSync(fd) }
}

test('real service streams pending then first committed results while discovery is still indexing', async () => {
  const { client, record, log } = fixture()
  largeTail(log)
  const events: MediaStreamEvent[] = []
  for await (const event of client.watch(record)) events.push(event)
  expect(events[0].type).toBe('snapshot')
  if (events[0].type === 'snapshot') expect(events[0].page.discovery.status).toBe('pending')
  const first = events.find(e => e.type === 'snapshot' && e.page.items.length > 0)
  expect(first?.type).toBe('snapshot')
  if (first?.type === 'snapshot') {
    expect(first.page.discovery.status).toBe('indexing')
    expect(first.page.items[0].label).toBe('Item 0')
  }
  expect(events.filter(e => e.type === 'snapshot')).toHaveLength(2)
  expect(events.at(-1)?.type).toBe('done')
  expect(client.get(record).discovery?.status).toBe('ready')
}, 10000)

test('real reader finishes a cached page while the writer is parsing a large indivisible record', async () => {
  const { record, indexPath, log, root } = fixture()
  fs.writeFileSync(log, line(0))
  const setup = new MediaIndex(indexPath)
  setup.scan(record, [log]); setup.close()
  const failures: string[] = []
  const writer = new DiscoveryRpc('mediaDiscoveryWriterWorker', 5000, m => failures.push(m))
  const reader = new DiscoveryRpc('mediaDiscoveryReaderWorker', 5000, m => failures.push(m))
  cleanup.push(() => writer.dispose()); cleanup.push(() => reader.dispose())
  await writer.request({ kind: 'open', path: indexPath }); await reader.request({ kind: 'open', path: indexPath })
  const slowLog = path.join(root, 'large-record.jsonl')
  fs.writeFileSync(slowLog, JSON.stringify({ type: 'ignored-fixture', padding: 'z'.repeat(48 * 1024 * 1024) }) + '\n')
  const slowRecord = { ...record, sessionId: 'slow', logFilePath: slowLog }
  let writerDone = false
  const writing = writer.request({ kind: 'step', record: slowRecord }).finally(() => { writerDone = true })
  // Give writer command delivery a head start, without waiting for its response.
  await delay(5)
  const page = (await reader.request({ kind: 'page', record })).value as MediaPage
  expect(page.items).toHaveLength(1)
  expect(writerDone).toBe(false)
  await writing
  expect(failures).toEqual([])
}, 10000)

test('dormant discovery stops at a checkpoint after its view aborts and resumes on reopen', async () => {
  const { client, record, log } = fixture()
  largeTail(log)
  const abort = new AbortController()
  for await (const event of client.watch(record, undefined, undefined, abort.signal)) {
    if (event.type === 'snapshot' && event.page.items.length) abort.abort()
  }
  await until(() => client.get(record).discovery?.status === 'pending')
  expect((await client.page(record)).items).toHaveLength(1)
  const retained = client.get(record).total
  await delay(50)
  expect(client.get(record).total).toBe(retained)
  for await (const _event of client.watch(record)) { /* Resume to completion. */ }
  expect(client.get(record).discovery?.status).toBe('ready')
  expect(client.get(record).total).toBe(1)
}, 10000)

test('a file read failure stays visible and explicit retry succeeds after the source is repaired', async () => {
  const { client, record, log } = fixture()
  fs.mkdirSync(log)
  for await (const _event of client.watch(record)) { /* EISDIR is a real worker scan failure. */ }
  expect(client.get(record).discovery?.status).toBe('failed')
  fs.rmdirSync(log); fs.writeFileSync(log, line(0))
  client.invalidate(record)
  for await (const _event of client.watch(record)) { /* Explicitly reopen the dormant view to retry. */ }
  expect(client.get(record).discovery?.status).toBe('ready')
  expect((await client.page(record)).items).toHaveLength(1)
})

test('a growth notification received during a finite scan schedules a follow-up snapshot', async () => {
  const { client, record, log } = fixture()
  largeTail(log)
  const active = { ...record, currentWindow: 'private:@1', lastKnownLogSize: fs.statSync(log).size }
  client.queue(active)
  await until(() => client.get(active).discovery?.status === 'indexing' && client.get(active).total > 0)
  fs.appendFileSync(log, line(1))
  client.queue({ ...active, lastKnownLogSize: fs.statSync(log).size })
  await until(() => client.get(active).discovery?.status === 'ready' && client.get(active).total === 2)
  expect((await client.page(active)).items).toHaveLength(2)
}, 10000)

test('dispose ends an in-flight stream without fetching or scheduling more work', async () => {
  const { client, record, log } = fixture()
  largeTail(log)
  let disposed = false, afterDispose = 0
  for await (const event of client.watch(record)) {
    if (disposed && event.type !== 'done') afterDispose++
    if (event.type === 'snapshot' && event.page.items.length) { disposed = true; client.dispose() }
  }
  expect(disposed).toBe(true)
  expect(afterDispose).toBe(0)
  await expect(client.page(record)).rejects.toThrow('disposed')
})

test('already-aborted dormant view does not create work', async () => {
  const { client, record, log, indexPath } = fixture()
  fs.writeFileSync(log, line(0))
  const abort = new AbortController(); abort.abort()
  const events: MediaStreamEvent[] = []
  for await (const event of client.watch(record, undefined, undefined, abort.signal)) events.push(event)
  expect(events).toEqual([])
  expect(fs.existsSync(indexPath)).toBe(false)
})

test('dormant catalog hydration reads persisted counts without rescanning a missing transcript', async () => {
  const { client, record, log, indexPath } = fixture()
  fs.writeFileSync(log, line(0))
  const writer = new MediaIndex(indexPath)
  writer.scan(record, [log]); writer.close()
  fs.unlinkSync(log)
  client.queue(record)
  await until(() => client.get(record).discovery?.status === 'ready')
  expect(client.get(record).total).toBe(1)
  expect((await client.page(record)).items).toHaveLength(1)
  // Explicit view demand now verifies the missing source and removes stale rows.
  for await (const _event of client.watch(record)) { /* Deliberate discovery. */ }
  expect(client.get(record).total).toBe(0)
})

test('a warm unchanged watch completes without waiting for an impossible summary change', async () => {
  const { client, record, log } = fixture()
  fs.writeFileSync(log, line(0))
  for await (const _event of client.watch(record)) { /* Seed cache and index. */ }
  const events: MediaStreamEvent[] = []
  for await (const event of client.watch(record)) events.push(event)
  expect(events[0].type).toBe('snapshot')
  expect(events.at(-1)?.type).toBe('done')
  expect(events.filter(event => event.type === 'snapshot')).toHaveLength(1)
}, 3000)

test('active to dormant transition updates the queued record and stops background discovery', async () => {
  const { client, record, log } = fixture()
  largeTail(log)
  client.queue({ ...record, currentWindow: 'private:@1' })
  await until(() => client.get(record).discovery?.status === 'indexing' && client.get(record).total > 0)
  client.queue(record)
  await until(() => client.get(record).discovery?.status === 'pending')
  expect((await client.page(record)).items).toHaveLength(1)
  await delay(50)
  expect(client.get(record).discovery?.status).toBe('pending')
})


test('writer replies with the original error even when persisting failed discovery also throws', async () => {
  const { record, log, indexPath } = fixture()
  fs.writeFileSync(log, line(0))
  const setup = new MediaIndex(indexPath)
  setup.scan(record, [log]); setup.close()
  const failures: string[] = []
  const writer = new DiscoveryRpc('mediaDiscoveryWriterWorker', 1000, message => failures.push(message))
  cleanup.push(() => writer.dispose())
  await writer.request({ kind: 'open', path: indexPath })
  const db = new Database(indexPath)
  db.exec('DROP TABLE media_sessions'); db.close()
  const error = await writer.request({ kind: 'step', record }).then(() => null, error => error as Error)
  expect(error?.message).toContain('no such table: media_sessions')
  expect(failures).toEqual([])
})
