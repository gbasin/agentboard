import { afterEach, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { createMediaRoutes } from '../mediaRoutes'
import type { AgentSessionRecord } from '../db'
import type { MediaPage } from '../../shared/media'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'media-route-')); roots.push(root)
  const log = path.join(root, 'session.jsonl')
  let current: AgentSessionRecord | null = { sessionId: 'session-12345678-abcdef', logFilePath: log, agentType: 'claude' } as AgentSessionRecord
  const page: MediaPage = { identity: 'a', revision: '1', total: 0, items: [], nextCursor: null }
  let read: () => Promise<MediaPage> = async () => page
  const app = createMediaRoutes({ getRecord: () => current, page: () => read() })
  const image = (data: string) => JSON.stringify({ type: 'user', message: { content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: Buffer.from(data).toString('base64') } }] } })
  const url = (line: string, extra = '') => `/session-12345678-abcdef?path=${encodeURIComponent(log)}&offset=0&index=0&digest=${createHash('sha256').update(line).digest('hex')}${extra}`
  return { log, app, image, url, setRecord: (r: AgentSessionRecord | null) => { current = r }, record: current, setPage: (f: typeof read) => { read = f } }
}

test('same-size rewrites cannot reuse an immutable media reference', async () => {
  const f = fixture(), old = f.image('one'), changed = f.image('two')
  expect(old.length).toBe(changed.length)
  fs.writeFileSync(f.log, old + '\n')
  const initial = await f.app.request(f.url(old))
  expect(await initial.text()).toBe('one')
  expect(initial.headers.get('Cache-Control')).toContain('immutable')
  fs.writeFileSync(f.log, changed + '\n')
  expect((await f.app.request(f.url(old))).status).toBe(409)
  expect(await (await f.app.request(f.url(changed))).text()).toBe('two')
})

test('legacy byte references are not advertised immutable', async () => {
  const f = fixture(), line = f.image('one'); fs.writeFileSync(f.log, line + '\n')
  const response = await f.app.request(f.url(line).replace(/&digest=[^&]+/, ''))
  expect(response.status).toBe(200)
  expect(response.headers.get('Cache-Control')).toBe('no-store')
})

test('bounded external references redirect only http(s), without server-side fetching', async () => {
  const f = fixture()
  for (const [target, status] of [['https://example.com/' + 'x'.repeat(5000), 302], ['javascript:alert(1)', 400]] as const) {
    const line = JSON.stringify({ type: 'frame-link', frameUrl: target, title: 'link' })
    fs.writeFileSync(f.log, line + '\n')
    const response = await f.app.request(f.url(line))
    expect(response.status).toBe(Number(status))
    if (status === 302) expect(response.headers.get('Location')).toBe(target)
  }
})

test('page responses are fenced after asynchronous record reassociation', async () => {
  const f = fixture()
  f.setPage(async () => {
    f.setRecord({ ...f.record!, logFilePath: '/another/log' })
    return { identity: 'old', revision: '1', total: 0, items: [], nextCursor: null }
  })
  expect((await f.app.request('/session-12345678-abcdef/items')).status).toBe(409)
})

test('page failures distinguish stale/invalid cursor and temporary index failure', async () => {
  const f = fixture()
  for (const [code, status] of [['STALE_CURSOR', 409], ['INVALID_CURSOR', 400], ['WORKER_FAILED', 503]] as const) {
    f.setPage(async () => { throw Object.assign(new Error(code), { code }) })
    expect((await f.app.request('/session-12345678-abcdef/items')).status).toBe(status)
  }
})

test('payload routes reject foreign paths and malformed refs', async () => {
  const f = fixture(), line = f.image('one'); fs.writeFileSync(f.log, line + '\n')
  expect((await f.app.request(f.url(line).replace(encodeURIComponent(f.log), encodeURIComponent('/etc/passwd')))).status).toBe(400)
  expect((await f.app.request(f.url(line).replace('index=0', 'index=-1'))).status).toBe(400)
  expect((await f.app.request(f.url(line).replace('digest=', 'digest=invalid'))).status).toBe(400)
})


test('digest-backed payloads can address media beyond the legacy 257-block cutoff', async () => {
  const f = fixture()
  const content = Array.from({ length: 258 }, (_, i) => ({ type: 'image', source: {
    type: 'base64', media_type: 'image/png', data: Buffer.from(`image-${i}`).toString('base64'),
  } }))
  const line = JSON.stringify({ type: 'user', message: { content } })
  fs.writeFileSync(f.log, line + '\n')
  const response = await f.app.request(f.url(line).replace('index=0', 'index=257'))
  expect(response.status).toBe(200)
  expect(await response.text()).toBe('image-257')
})

test('link filters and bounded search are validated before worker dispatch', async () => {
  const f = fixture()
  expect((await f.app.request('/session-12345678-abcdef/items?kind=invalid')).status).toBe(400)
  expect((await f.app.request('/session-12345678-abcdef/items?search=' + 'x'.repeat(201))).status).toBe(400)
  let received: unknown
  const app = createMediaRoutes({ getRecord: () => f.record, page: async (_record, cursor, query) => {
    received = { cursor, query }; return { identity: 'a', revision: '1', total: 0, items: [], nextCursor: null }
  } })
  expect((await app.request('/session-12345678-abcdef/items?kind=links&search=report%20%23')).status).toBe(200)
  expect(received).toEqual({ cursor: undefined, query: { kind: 'links', search: 'report #' } })
})

test('stream=1 selects discovery without calling the blocking JSON page path', async () => {
  const f = fixture()
  let received: unknown
  let pageCalls = 0
  const app = createMediaRoutes({ getRecord: () => f.record,
    page: async () => { pageCalls++; return { identity: 'a', revision: '1', total: 0, items: [], nextCursor: null } },
    watch: async function* (record, cursor, query, signal) {
      received = { record: record.sessionId, cursor, query, signal: !!signal }
      yield { type: 'snapshot', page: { identity: 'a', revision: '1', total: 0, items: [], nextCursor: null, discovery: { status: 'pending' } } }
      yield { type: 'done' }
    },
  })
  const response = await app.request('/session-12345678-abcdef/items?stream=1&kind=links&search=report&cursor=next')
  expect(response.headers.get('Content-Type')).toContain('application/x-ndjson')
  expect((await response.text()).trim().split('\n').map(line => JSON.parse(line).type)).toEqual(['snapshot', 'done'])
  expect(received).toEqual({ record: f.record!.sessionId, cursor: 'next', query: { kind: 'links', search: 'report' }, signal: true })
  expect(pageCalls).toBe(0)
  const json = await app.request('/session-12345678-abcdef/items')
  expect(json.headers.get('Content-Type')).toContain('application/json')
  expect(pageCalls).toBe(1)
})

test('stream inputs are validated before watch dispatch and unavailable discovery fails explicitly', async () => {
  const f = fixture()
  expect((await f.app.request('/session-12345678-abcdef/items?stream=1')).status).toBe(503)
  let watched = false
  const app = createMediaRoutes({ getRecord: () => f.record, page: async () => { throw Error() },
    watch: async function* () { watched = true; yield { type: 'done' } },
  })
  expect((await app.request('/session-12345678-abcdef/items?stream=1&kind=bad')).status).toBe(400)
  expect((await app.request('/session-12345678-abcdef/items?stream=1&cursor=' + 'x'.repeat(8193))).status).toBe(400)
  expect(watched).toBe(false)
})
