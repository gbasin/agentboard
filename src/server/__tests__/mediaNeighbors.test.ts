import { afterEach, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { MediaIndex } from '../mediaIndex'
import { parseMediaAnchor } from '../mediaAnchor'
import { createMediaRoutes } from '../mediaRoutes'
import type { AgentSessionRecord } from '../db'
import type { MediaNeighbors } from '../../shared/media'
import { MEDIA_PAGE_BYTES } from '../../shared/media'

const cleanup: (() => void)[] = []
afterEach(() => cleanup.splice(0).reverse().forEach(fn => fn()))
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'media-neighbors-'))
  cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }))
  const index = new MediaIndex(':memory:'); cleanup.push(() => index.close())
  const log = path.join(root, 'main.jsonl')
  const record = { sessionId: 'neighbors-session-12345678', logFilePath: log, agentType: 'claude' } as AgentSessionRecord
  return { root, index, log, record }
}
function image(i: number) {
  return JSON.stringify({ type: 'user', timestamp: new Date(1_700_000_000_000 + i).toISOString(), message: { content: [
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: Buffer.from(`image-${i}`).toString('base64') } },
  ] } }) + '\n'
}
function link(i: number) {
  return JSON.stringify({ type: 'frame-link', frameUrl: `https://example.com/${i}`, timestamp: new Date(1_700_000_000_000 + i).toISOString() }) + '\n'
}

test('neighbor seeks skip thousands of nonimages in both directions without loading pages', () => {
  const { index, log, record } = fixture()
  fs.writeFileSync(log, image(0) + Array.from({ length: 6000 }, (_, i) => link(i + 1)).join('') + image(6001) + image(6002))
  const summary = index.scan(record, [log])
  const first = index.page(record).items[0]
  const initial = index.neighbors(record, first.url)
  expect(initial.identity).toBe(summary.identity)
  expect(initial.current).toEqual(first)
  expect(initial.previous).toBeNull()
  expect(initial.next?.kind).toBe('image')
  expect(initial.next).not.toBeNull()
  const middle = index.neighbors(record, initial.next!.url)
  expect(middle.previous).toEqual(first)
  expect(middle.next).not.toBeNull()
  const end = index.neighbors(record, middle.next!.url)
  expect(end.previous).toEqual(middle.current)
  expect(end.next).toBeNull()
  expect(Buffer.byteLength(JSON.stringify(middle))).toBeLessThan(MEDIA_PAGE_BYTES)
})

test('navigation sees appended images but rejects rewritten, deleted and cross-session anchors', () => {
  const { index, log, record } = fixture()
  fs.writeFileSync(log, image(0)); index.scan(record, [log])
  const first = index.page(record).items[0]
  expect(index.neighbors(record, first.url).next).toBeNull()
  fs.appendFileSync(log, image(1)); index.scan(record, [log])
  expect(index.neighbors(record, first.url).previous).not.toBeNull()
  expect(() => index.neighbors({ ...record, sessionId: 'another-session' }, first.url)).toThrow('Invalid image anchor')
  fs.writeFileSync(log, image(2)); index.scan(record, [log])
  expect(() => index.neighbors(record, first.url)).toThrow('Image changed')
  const next = index.page(record).items[0]
  fs.unlinkSync(log); index.scan(record, [log])
  expect(() => index.neighbors(record, next.url)).toThrow('Image changed')
})

test('image neighbors share global subagent order and reject document/link anchors', () => {
  const { root, index, log, record } = fixture()
  const child = path.join(root, 'child.jsonl')
  fs.writeFileSync(log, image(0) + link(1) + image(4)); fs.writeFileSync(child, image(2))
  index.scan(record, [log, child])
  const items = index.page(record).items
  expect(index.neighbors(record, items[0].url).next).toEqual(items[1])
  expect(index.neighbors(record, items[1].url).previous).toEqual(items[0])
  expect(index.neighbors(record, items[1].url).next).toEqual(items[3])
  expect(() => index.neighbors(record, items[2].url)).toThrow('Invalid image anchor')
  index.scan(record, [log])
  expect(() => index.neighbors(record, items[1].url)).toThrow('Image changed')
})

test('anchor validation rejects noncanonical and unbounded input without touching files', () => {
  const good = `/api/session-media/session?path=%2Flog&offset=0&index=0&digest=${'a'.repeat(64)}`
  expect(parseMediaAnchor('session', good)).toEqual({ path: '/log', offset: 0, index: 0 })
  for (const bad of ['', 'x'.repeat(8193), 'https://host' + good, good + '#x', good + '&index=1',
    good.replace('offset=0', 'offset=01'), good.replace('&index=0', ''), good.replace('index=0', 'index=-1'),
    good.replace('digest=', 'digest=x')]) {
    expect(() => parseMediaAnchor('session', bad)).toThrow('Invalid image anchor')
  }
})

test('neighbor route fences reassociation and distinguishes invalid, stale, absent and busy results', async () => {
  const { index, log, record } = fixture()
  fs.writeFileSync(log, image(0)); index.scan(record, [log])
  const anchor = index.page(record).items[0].url
  const data = index.neighbors(record, anchor)
  let current: AgentSessionRecord | null = record
  let read: () => Promise<MediaNeighbors> = async () => data
  let calls = 0
  const app = createMediaRoutes({ getRecord: () => current, page: async () => { throw Error('unused') },
    neighbors: () => { calls++; return read() } })
  const url = `/${record.sessionId}/neighbors?anchor=${encodeURIComponent(anchor)}`
  const good = await app.request(url)
  expect(good.status).toBe(200)
  expect(good.headers.get('Cache-Control')).toBe('no-store')
  expect(await good.json()).toEqual(data)
  expect((await app.request(`/${record.sessionId}/neighbors?anchor=foreign`)).status).toBe(400)
  expect(calls).toBe(1)
  for (const [code, status] of [['INVALID_ANCHOR', 400], ['STALE_ANCHOR', 409], ['WORKER_FAILED', 503]] as const) {
    read = async () => { throw Object.assign(Error(code), { code }) }
    expect((await app.request(url)).status).toBe(status)
  }
  read = async () => { current = { ...record, logFilePath: '/different' }; return data }
  expect((await app.request(url)).status).toBe(409)
  current = null
  expect((await app.request(url)).status).toBe(404)
})
