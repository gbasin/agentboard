import { afterEach, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { MediaCursorError, MediaIndex } from '../mediaIndex'
import type { AgentSessionRecord } from '../db'
import { MEDIA_PAGE_BYTES, MEDIA_PAGE_ITEMS } from '../../shared/media'

const cleanup: (() => void)[] = []
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn() })
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'media-index-'))
  cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }))
  const dbPath = path.join(root, 'index.sqlite')
  const index = new MediaIndex(dbPath)
  cleanup.push(() => index.close())
  const log = path.join(root, 'main.jsonl')
  const record = { sessionId: 'index-fixture', logFilePath: log, agentType: 'claude' } as AgentSessionRecord
  return { root, dbPath, index, log, record }
}
function line(n: number, title = `item ${n}`, stamp = n) {
  return JSON.stringify({ type: 'frame-link', frameUrl: `https://example.com/${n}`, title,
    timestamp: new Date(1_700_000_000_000 + stamp).toISOString() }) + '\n'
}
function all(index: MediaIndex, record: AgentSessionRecord) {
  const items = []
  let page = index.page(record)
  while (true) {
    expect(page.items.length).toBeLessThanOrEqual(MEDIA_PAGE_ITEMS)
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(MEDIA_PAGE_BYTES)
    items.push(...page.items)
    if (!page.nextCursor) return items
    page = index.page(record, page.nextCursor)
  }
}

test('retains all 2,366+ records on disk, oldest first, with bounded pages and summary-only metadata', () => {
  const { index, log, record } = fixture()
  fs.writeFileSync(log, Array.from({ length: 2366 }, (_, n) => line(n)).join(''))
  const summary = index.scan(record, [log])
  expect(summary.total).toBe(2366)
  expect(summary.links).toBe(2366)
  expect(Buffer.byteLength(JSON.stringify(summary))).toBeLessThan(400)
  const items = all(index, record)
  expect(items).toHaveLength(2366)
  expect(items[0].label).toBe('item 0')
  expect(items.at(-1)?.label).toBe('item 2365')
  expect(index.scan(record, [log])).toEqual(summary)
})

test('append retains cursor snapshot; new first page sees latest additions without shifting old pages', () => {
  const { index, log, record } = fixture()
  fs.writeFileSync(log, Array.from({ length: 60 }, (_, n) => line(n)).join(''))
  const firstSummary = index.scan(record, [log])
  const first = index.page(record)
  fs.appendFileSync(log, line(100, 'new late-discovered old record', -1))
  const nextSummary = index.scan(record, [log])
  expect(nextSummary.revision).not.toBe(firstSummary.revision)
  const continuation = index.page(record, first.nextCursor!)
  expect(continuation.revision).toBe(first.revision)
  expect(continuation.items).toHaveLength(20)
  expect(continuation.nextCursor).toBeNull()
  expect(all(index, record).at(-1)?.label).toBe('new late-discovered old record')
})

test('same-size rewrite, truncation, and deleted source reject old cursors and change immutable URL digest', () => {
  const { index, log, record } = fixture()
  const body = Array.from({ length: 60 }, (_, n) => line(n)).join('')
  fs.writeFileSync(log, body)
  index.scan(record, [log])
  const first = index.page(record)
  const oldUrl = first.items[0].url
  fs.writeFileSync(log, body.replace('item 0', 'ITEM 0'))
  const future = new Date(Date.now() + 1000)
  fs.utimesSync(log, future, future)
  const updated = index.scan(record, [log])
  expect(() => index.page(record, first.nextCursor!)).toThrow(MediaCursorError)
  expect(index.page(record).items[0].url).not.toBe(oldUrl)
  expect(updated.additions).toBe(60) // label-only edit is not newly discovered media
  fs.writeFileSync(log, line(999))
  expect(index.scan(record, [log]).total).toBe(1)
  fs.rmSync(log)
  expect(index.scan(record, [log]).total).toBe(0)
})

test('late/deleted subagents participate in global timestamp order and invalidate removed views', () => {
  const { index, log, record, root } = fixture()
  const child = path.join(root, 'child.jsonl')
  fs.writeFileSync(log, Array.from({ length: 50 }, (_, n) => line(n, undefined, n + 100)).join(''))
  index.scan(record, [log])
  const before = index.page(record)
  fs.writeFileSync(child, line(1000, 'child first', 0))
  index.scan(record, [log, child])
  expect(index.page(record).items[0].label).toBe('child first')
  expect(index.page(record, before.nextCursor!).items).toHaveLength(10)
  const current = index.page(record)
  index.scan(record, [log])
  expect(() => index.page(record, current.nextCursor!)).toThrow(MediaCursorError)
})

test('page URLs stay bounded for oversized external URLs and labels; source digest resolves exact content', () => {
  const { index, log, record } = fixture()
  const source = JSON.stringify({ type: 'frame-link', frameUrl: 'https://example.com/' + 'x'.repeat(100_000), title: 'z'.repeat(100_000) })
  fs.writeFileSync(log, source + '\n')
  index.scan(record, [log])
  const page = index.page(record)
  expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(MEDIA_PAGE_BYTES)
  expect(page.items[0].label).toHaveLength(512)
  const url = new URL(page.items[0].url, 'http://localhost')
  expect(url.pathname).toBe('/api/session-media/index-fixture')
  expect(url.searchParams.get('digest')).toBe(createHash('sha256').update(source).digest('hex'))
})

test('partial UTF-8 lines and label context survive incremental scans and index reopen', () => {
  const { index, log, record, dbPath } = fixture()
  const source = line(0, 'résumé 🦊')
  const bytes = Buffer.from(source)
  const cut = bytes.indexOf(Buffer.from('🦊')) + 2
  fs.writeFileSync(log, bytes.subarray(0, cut))
  expect(index.scan(record, [log]).total).toBe(0)
  fs.appendFileSync(log, bytes.subarray(cut))
  const summary = index.scan(record, [log])
  expect(summary.total).toBe(1)
  const reopened = new MediaIndex(dbPath)
  cleanup.push(() => reopened.close())
  expect(reopened.scan(record, [log])).toEqual(summary)
  expect(reopened.page(record).items[0].label).toBe('résumé 🦊')
})

test('malformed and cross-session cursors fail instead of reading another collection', () => {
  const { index, log, record } = fixture()
  fs.writeFileSync(log, Array.from({ length: 45 }, (_, n) => line(n)).join(''))
  index.scan(record, [log])
  expect(() => index.page(record, 'garbage')).toThrow('Invalid media cursor')
  const cursor = index.page(record).nextCursor!
  const other = { ...record, sessionId: 'other' }
  index.scan(other, [log])
  expect(() => index.page(other, cursor)).toThrow('Media changed')
})

test('encoded byte limit can shorten a page without dropping or duplicating the next item', () => {
  const { index, record, root } = fixture()
  const directory = path.join(root, ...Array.from({ length: 3 }, () => '界'.repeat(70)))
  fs.mkdirSync(directory, { recursive: true })
  const log = path.join(directory, 'long-path.jsonl')
  const source = { ...record, logFilePath: log }
  fs.writeFileSync(log, Array.from({ length: 90 }, (_, n) => line(n, '🦊'.repeat(512))).join(''))
  index.scan(source, [log])
  expect(index.page(source).items.length).toBeLessThan(MEDIA_PAGE_ITEMS)
  const items = all(index, source)
  expect(items).toHaveLength(90)
  expect(new Set(items.map(item => item.url)).size).toBe(90)
})

test('truncated-and-regrown or inode-replaced logs cannot retain a previous paging view', () => {
  const { index, record, log, root } = fixture()
  const body = Array.from({ length: 50 }, (_, n) => line(n)).join('')
  fs.writeFileSync(log, body)
  index.scan(record, [log])
  const first = index.page(record)
  fs.writeFileSync(log, line(999) + body + line(1000))
  index.scan(record, [log])
  expect(() => index.page(record, first.nextCursor!)).toThrow(MediaCursorError)
  const next = index.page(record)
  const replacement = path.join(root, 'replacement')
  fs.writeFileSync(replacement, body)
  fs.renameSync(replacement, log)
  index.scan(record, [log])
  expect(() => index.page(record, next.nextCursor!)).toThrow(MediaCursorError)
})

test('oversized unterminated records are bounded, reported, and discarded only until the next newline', () => {
  const { index, record, log } = fixture()
  const fd = fs.openSync(log, 'w')
  const chunk = Buffer.alloc(1024 * 1024, 120)
  for (let i = 0; i < 65; i++) fs.writeSync(fd, chunk)
  fs.closeSync(fd)
  const omitted = index.scan(record, [log])
  expect(omitted.total).toBe(0)
  expect(omitted.omittedRecords).toBe(1)
  expect(index.scan(record, [log])).toEqual(omitted)
  fs.appendFileSync(log, 'more unfinished bytes')
  expect(index.scan(record, [log])).toEqual(omitted)
  fs.appendFileSync(log, '\n' + line(1))
  const complete = index.scan(record, [log])
  expect(complete.total).toBe(1)
  expect(complete.omittedRecords).toBe(1)
  expect(index.page(record).items[0].label).toBe('item 1')
  fs.writeFileSync(log, line(2))
  const rewritten = index.scan(record, [log])
  expect(rewritten.omittedRecords).toBeUndefined()
  expect(rewritten.revision).not.toBe(complete.revision)
})

test('explicit payload-mismatch invalidation repairs a deep prefix edit hidden by append checkpoints', () => {
  const { index, record, log } = fixture()
  const body = Array.from({ length: 70 }, (_, n) => line(n)).join('')
  fs.writeFileSync(log, body)
  index.scan(record, [log])
  const before = index.page(record)
  const previousUrl = before.items[25].url
  fs.writeFileSync(log, body.replace('item 25', 'ITEM 25') + line(100))
  // Cheap incremental append checks cannot see a changed byte deep in the old prefix.
  index.scan(record, [log])
  expect(index.page(record).items[25].url).toBe(previousUrl)
  // The byte route rejects the old source digest, then queues this repair off-thread.
  index.invalidate(record)
  index.scan(record, [log])
  expect(index.page(record).items[25].label).toBe('ITEM 25')
  expect(index.page(record).items[25].url).not.toBe(previousUrl)
  expect(index.page(record).total).toBe(71)
  expect(() => index.page(record, before.nextCursor!)).toThrow(MediaCursorError)
})

test('missing and backward timestamps retain per-file order across appends', () => {
  const { index, log, record } = fixture()
  const missing = JSON.stringify({ type: 'frame-link', frameUrl: 'https://example.com/missing', title: 'missing' }) + '\n'
  fs.writeFileSync(log, line(0, 'first', 100) + missing + line(1, 'backward', 50))
  index.scan(record, [log])
  expect(all(index, record).map(item => item.label)).toEqual(['first', 'missing', 'backward'])
  const another = JSON.stringify({ type: 'frame-link', frameUrl: 'https://example.com/append', title: 'append missing' }) + '\n'
  fs.appendFileSync(log, another + line(2, 'append backward', 10) + line(3, 'append future', 200))
  index.scan(record, [log])
  expect(all(index, record).map(item => item.label)).toEqual([
    'first', 'missing', 'backward', 'append missing', 'append backward', 'append future',
  ])
})

test('tool caption context has an aggregate byte budget and hashes long IDs without losing association', async () => {
  const { createMediaLineScanner } = await import('../mediaExtractor')
  const { MEDIA_LABEL_BUDGET } = await import('../mediaIndexLabels')
  const found: string[] = []
  const scanner = createMediaLineScanner(entry => { if (entry.label) found.push(entry.label) })
  for (let n = 0; n < 2500; n++) scanner.line(JSON.stringify({ message: { content: [{ type: 'tool_use',
    id: `${n}-` + 'id'.repeat(500), name: 'Read', input: { file_path: '/tmp/' + '界'.repeat(1000) },
  }] } }), n * 10000)
  expect(Buffer.byteLength(JSON.stringify(scanner.labels()))).toBeLessThanOrEqual(MEDIA_LABEL_BUDGET)
  expect(scanner.labels().every(([key, label]) => key.length <= 256 && label.length <= 512)).toBe(true)
  const lastId = '2499-' + 'id'.repeat(500)
  scanner.line(JSON.stringify({ message: { content: [{ type: 'tool_result', tool_use_id: lastId,
    content: [{ type: 'image', source: { data: 'YWJj', media_type: 'image/png' } }],
  }] } }), 30_000_000)
  expect(found[0]).toStartWith('Read · ')
  expect(found[0]).toHaveLength(512)
})

test('disk indexing retains more than 257 media items inside a single valid record', () => {
  const { index, log, record } = fixture()
  fs.writeFileSync(log, JSON.stringify({ message: { content: Array.from({ length: 258 }, (_, n) => ({
    type: 'frame-link', frameUrl: `https://example.com/single-record/${n}`, title: `block ${n}`,
  })) } }) + '\n')
  expect(index.scan(record, [log]).total).toBe(258)
  const items = all(index, record)
  expect(items).toHaveLength(258)
  expect(items.at(-1)?.label).toBe('block 257')
  expect(new URL(items.at(-1)!.url, 'http://localhost').searchParams.get('index')).toBe('257')
})
