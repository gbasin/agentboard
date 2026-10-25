import { expect, test } from 'bun:test'
import { createMediaRoutes } from '../mediaRoutes'
import type { AgentSessionRecord } from '../db'

const record = { sessionId: 'session-12345678-abcdef', logFilePath: '/test/log', agentType: 'claude' } as AgentSessionRecord
const url = `/session-12345678-abcdef?path=%2Ftest%2Flog&offset=0&index=0&digest=${'a'.repeat(64)}&thumbnail=1`
function fixture() {
  let current = record, calls = 0, invalidations = 0
  let get = async () => new Uint8Array([1, 2])
  const app = createMediaRoutes({ getRecord: () => current,
    page: async () => { throw new Error('unused') },
    thumbnail: { get: async () => { calls++; return get() } },
    invalidate: () => { invalidations++ },
  })
  return { app, setGet: (next: typeof get) => { get = next },
    setRecord: (next: AgentSessionRecord) => { current = next },
    counts: () => ({ calls, invalidations }) }
}
test('thumbnail authorization and immutable digest are mandatory before dispatch', async () => {
  const f = fixture()
  expect((await f.app.request(url.replace('%2Ftest%2Flog', '%2Fforeign'))).status).toBe(400)
  expect((await f.app.request(url.replace(/&digest=[^&]+/, ''))).status).toBe(400)
  expect((await f.app.request(url + '&bytes=-1')).status).toBe(400)
  expect(f.counts().calls).toBe(0)
  const response = await f.app.request(url)
  expect(response.status).toBe(200)
  expect(response.headers.get('Content-Type')).toBe('image/png')
  expect(response.headers.get('Cache-Control')).toContain('immutable')
})
test('worker response cannot cross record reassociation', async () => {
  const f = fixture()
  f.setGet(async () => { f.setRecord({ ...record, logFilePath: '/other' }); return new Uint8Array([1]) })
  expect((await f.app.request(url)).status).toBe(409)
})
test('thumbnail errors distinguish fallback, busy, missing and stale repair', async () => {
  const f = fixture()
  for (const [code, status] of [['UNSUPPORTED', 422], ['BUSY', 503], ['NOT_FOUND', 404], ['STALE', 409]] as const) {
    f.setGet(async () => { throw Object.assign(new Error(code), { code }) })
    expect((await f.app.request(url)).status).toBe(status)
  }
  expect(f.counts().invalidations).toBe(1)
})

test('real HTTP disconnect aborts the thumbnail dependency signal', async () => {
  let entered!: () => void, observed!: (aborted: boolean) => void
  const started = new Promise<void>(resolve => { entered = resolve })
  const cancelled = new Promise<boolean>(resolve => { observed = resolve })
  const app = createMediaRoutes({ getRecord: () => record,
    page: async () => { throw new Error('unused') },
    thumbnail: { get: (_ref, signal) => new Promise((_resolve, reject) => {
      entered()
      signal?.addEventListener('abort', () => { observed(true); reject(new Error('aborted')) }, { once: true })
    }) },
  })
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: request => app.fetch(request) })
  const controller = new AbortController()
  const timeout = setTimeout(() => observed(false), 2000)
  try {
    const request = fetch(`http://127.0.0.1:${server.port}${url}`, { signal: controller.signal }).catch(() => null)
    await started
    controller.abort()
    await request
    expect(await cancelled).toBe(true)
  } finally { clearTimeout(timeout); server.stop(true) }
})
