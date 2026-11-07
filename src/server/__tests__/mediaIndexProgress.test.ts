import { afterEach, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { MediaIndex } from '../mediaIndex'
import type { AgentSessionRecord } from '../db'
const cleanup: (() => void)[] = []
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn() })
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'media-progress-'))
  cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }))
  const filename = path.join(root, 'index.sqlite'), log = path.join(root, 'main.jsonl')
  const record = { sessionId: 'progress', logFilePath: log, agentType: 'claude' } as AgentSessionRecord
  const open = (readonly = false) => { const index = new MediaIndex(filename, { readonly }); cleanup.push(() => index.close()); return index }
  const index = open()
  return { root, filename, log, record, index, open }
}
const line = (n: number, title = `item ${n}`) => JSON.stringify({ type: 'frame-link', frameUrl: `https://example.com/${n}`, title,
  timestamp: new Date(1_700_000_000_000 + n).toISOString() }) + '\n'
const finish = (index: MediaIndex, job: ReturnType<MediaIndex['startScan']>) => {
  let steps = 0
  while (!index.stepScan(job, { maxBytes: 200, maxMs: 1000 }).done) if (++steps > 10000) throw Error('No progress')
  return index.getSummary(job.record)!
}

test('read-only unknown collection is stable pending, empty completion is ready, writes are rejected', () => {
  const { index, open, record, log } = fixture(), reader = open(true)
  expect(reader.getSummary(record)).toBeUndefined()
  expect(reader.page(record)).toEqual(reader.page(record))
  expect(reader.page(record).discovery).toEqual({ status: 'pending' })
  expect(() => reader.page(record, 'old')).toThrow('Media changed')
  expect(() => reader.scan(record, [])).toThrow('read-only')
  expect(index.scan(record, []).discovery).toEqual({ status: 'ready' })
  fs.writeFileSync(log, '')
  expect(index.scan(record, [log]).discovery).toEqual({ status: 'ready' })
  expect(reader.getSummary(record)?.total).toBe(0)
})

test('small commits are visible through independent WAL reader; resume survives writer reopen', () => {
  const { index, open, record, log, filename } = fixture(), reader = open(true)
  fs.writeFileSync(log, Array.from({ length: 100 }, (_, n) => line(n)).join(''))
  const job = index.startScan(record, [log])
  const first = index.stepScan(job, { maxBytes: 1 })
  expect(first.done).toBe(false)
  expect(first.summary.total).toBe(1)
  expect(first.summary.discovery?.status).toBe('indexing')
  expect(reader.page(record).items[0].label).toBe('item 0')
  const db = new Database(filename)
  try {
    db.exec('BEGIN IMMEDIATE')
    db.query('UPDATE media_sessions SET total=999').run()
    // Reader sees the preceding committed snapshot while a writer holds WAL lock.
    expect(reader.getSummary(record)?.total).toBe(1)
    expect(reader.page(record).total).toBe(1)
    db.exec('ROLLBACK')
  } finally { db.close() }
  const reopened = open()
  const resumed = reopened.startScan(record, [log])
  expect(reopened.stepScan(resumed, { maxBytes: 1 }).summary.total).toBe(2)
  expect(finish(reopened, resumed).total).toBe(100)
  expect(reader.getSummary(record)?.discovery).toEqual({ status: 'ready' })
})

test('cursor snapshot stays frozen through progressive commits; rewriting invalidates it', () => {
  const { index, record, log } = fixture()
  fs.writeFileSync(log, Array.from({ length: 100 }, (_, n) => line(n)).join(''))
  const job = index.startScan(record, [log])
  for (let i = 0; i < 60; i++) index.stepScan(job, { maxBytes: 1 })
  const page = index.page(record)
  expect(page.total).toBe(60)
  finish(index, job)
  const rest = index.page(record, page.nextCursor!)
  expect(rest.total).toBe(60)
  expect(rest.items).toHaveLength(20)
  expect(rest.items[0].label).toBe('item 19')
  fs.writeFileSync(log, Array.from({ length: 100 }, (_, n) => line(n, `edit ${n}`)).join(''))
  const rewrite = index.startScan(record, [log])
  index.stepScan(rewrite, { maxBytes: 1 })
  expect(() => index.page(record, page.nextCursor!)).toThrow('Media changed')
  expect(finish(index, rewrite).total).toBe(100)
})

test('finite EOF snapshot completes despite appended records; partial tail retries only on later growth', () => {
  const { index, record, log } = fixture()
  fs.writeFileSync(log, line(0) + line(1))
  const job = index.startScan(record, [log])
  index.stepScan(job, { maxBytes: 1 })
  fs.appendFileSync(log, line(2))
  expect(finish(index, job).total).toBe(2)
  expect(index.scan(record, [log]).total).toBe(3)
  fs.appendFileSync(log, line(3).slice(0, -2))
  expect(index.scan(record, [log]).total).toBe(3)
  expect(index.scan(record, [log]).discovery).toEqual({ status: 'ready' })
  fs.appendFileSync(log, '}\n')
  expect(index.scan(record, [log]).total).toBe(4)
})

test('deleted and rotated source between steps removes old results and restarts from its new inode', () => {
  const { index, record, log } = fixture()
  fs.writeFileSync(log, line(0) + line(1))
  const job = index.startScan(record, [log])
  index.stepScan(job, { maxBytes: 1 })
  fs.renameSync(log, log + '.old')
  fs.writeFileSync(log, line(2))
  expect(finish(index, job).total).toBe(1)
  expect(index.page(record).items[0].label).toBe('item 2')
  const removed = index.startScan(record, [log])
  fs.unlinkSync(log)
  expect(finish(index, removed).total).toBe(0)
})

test('main file precedes newest subagents, cancellation preserves checkpoint and fences obsolete jobs', () => {
  const { index, record, log, root } = fixture()
  const older = path.join(root, 'a.jsonl'), newer = path.join(root, 'b.jsonl')
  fs.writeFileSync(log, line(0)); fs.writeFileSync(older, line(1)); fs.writeFileSync(newer, line(2))
  fs.utimesSync(older, 1, 1); fs.utimesSync(newer, 2, 2)
  const job = index.startScan(record, [older, newer, log])
  expect(job.sources.map(s => s.path)).toEqual([log, newer, older])
  index.stepScan(job, { maxBytes: 1 })
  index.cancelScan(job)
  expect(index.getSummary(record)?.discovery).toEqual({ status: 'pending' })
  const resumed = index.startScan(record, [older, log, newer])
  expect(() => index.stepScan(job)).toThrow('superseded')
  expect(finish(index, resumed).total).toBe(3)
  index.markFailed(record, 'Retry discovery')
  expect(index.getSummary(record)?.discovery).toEqual({ status: 'failed', message: 'Retry discovery' })
})

test('full long destinations survive, oversized descriptors are disclosed without blocking later results', () => {
  const { index, record, log } = fixture()
  const url = 'https://example.com/' + 'a'.repeat(3000)
  fs.writeFileSync(log, JSON.stringify({ type: 'frame-link', frameUrl: url }) + '\n' +
    JSON.stringify({ type: 'frame-link', frameUrl: 'https://example.com/' + 'z'.repeat(100000) }) + '\n' + line(2))
  const summary = index.scan(record, [log])
  expect(summary.total).toBe(2)
  expect(summary.omittedItems).toBe(1)
  const page = index.page(record)
  expect(page.items).toHaveLength(2)
  expect(page.items.some(item => item.externalUrl === url)).toBe(true)
  expect(page.omittedItems).toBe(1)
  expect(index.scan(record, [log]).omittedItems).toBe(1)
})

test('legacy possibly truncated copy URLs are suppressed until file checkpoint migration rebuilds them', () => {
  const { index, open, record, log, filename } = fixture()
  const url = 'https://example.com/' + 'a'.repeat(3000)
  fs.writeFileSync(log, JSON.stringify({ type: 'frame-link', frameUrl: url }) + '\n')
  index.scan(record, [log])
  const db = new Database(filename)
  db.query("UPDATE media_items SET descriptor_version=0, descriptor=json_set(descriptor,'$.externalUrl',?)").run(url.slice(0,2048))
  db.query("UPDATE media_files SET state=json_set(state,'$.version',2)").run()
  db.close()
  expect(open(true).page(record).items[0].externalUrl).toBeUndefined()
  index.scan(record, [log])
  expect(index.page(record).items[0].externalUrl).toBe(url)
})

test('tool labels and timestamp clamping survive every per-record checkpoint', () => {
  const { index, record, log, open } = fixture()
  const label = JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [
    { type: 'tool_use', id: 'tool1', name: 'Read', input: { file_path: '/tmp/chart.png' } },
  ] } }) + '\n'
  const result = JSON.stringify({ type: 'user', timestamp: '2000-01-01T00:00:00Z', message: { role: 'user', content: [
    { type: 'tool_result', tool_use_id: 'tool1', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'YQ==' } }] },
  ] } }) + '\n'
  fs.writeFileSync(log, line(50) + label + result)
  const job = index.startScan(record, [log])
  index.stepScan(job, { maxBytes: 1 }); index.stepScan(job, { maxBytes: 1 })
  const resumed = open()
  finish(resumed, resumed.startScan(record, [log]))
  const items = resumed.page(record).items
  expect(items[0].kind).toBe('image')
  expect(items[0].label).toContain('chart.png')
  expect(items[1].label).toBe('item 50')
})

test('bounded pages reserve space for the stream snapshot envelope', () => {
  const { index, record, log } = fixture()
  fs.writeFileSync(log, Array.from({ length: 10 }, (_, n) => JSON.stringify({ type: 'frame-link',
    frameUrl: `https://example.com/${n}/` + 'a'.repeat(14000) }) + '\n').join(''))
  index.scan(record, [log])
  let page = index.page(record), items = 0
  for (;;) {
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(64 * 1024 - 512)
    expect(Buffer.byteLength(JSON.stringify({ type: 'snapshot', page }) + '\n')).toBeLessThanOrEqual(64 * 1024)
    items += page.items.length
    if (!page.nextCursor) break
    page = index.page(record, page.nextCursor)
  }
  expect(items).toBe(10)
})

test('warm freshness checks do not rewrite unchanged checkpoints; appends still persist progress', () => {
  const { index, record, log, filename } = fixture()
  fs.writeFileSync(log, line(0))
  const summary = index.scan(record, [log])
  const db = new Database(filename)
  try {
    db.exec(`CREATE TABLE checkpoint_writes (count INTEGER NOT NULL);
      INSERT INTO checkpoint_writes VALUES(0);
      CREATE TRIGGER observe_checkpoint_insert AFTER INSERT ON media_files BEGIN
        UPDATE checkpoint_writes SET count=count+1;
      END;
      CREATE TRIGGER observe_checkpoint_update AFTER UPDATE ON media_files BEGIN
        UPDATE checkpoint_writes SET count=count+1;
      END;`)
    expect(index.scan(record, [log])).toEqual(summary)
    expect(db.query('SELECT count FROM checkpoint_writes').get()).toEqual({ count: 0 })
    fs.appendFileSync(log, line(1))
    expect(index.scan(record, [log]).total).toBe(2)
    expect(db.query('SELECT count FROM checkpoint_writes').get()).toEqual({ count: 1 })
  } finally { db.close() }
})
