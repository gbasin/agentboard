import { expect, test } from 'bun:test'
import { prepareParityMedia } from './parity-media-ready'

const page = { discovery: { status: 'ready' }, total: 4, nextCursor: null, items: [
  { kind: 'image', mediaType: 'image/png' }, { kind: 'document', mediaType: 'text/html' },
  { kind: 'document', mediaType: 'application/pdf' }, { kind: 'link' },
] }
const frames = (events: object[]) => events.map(event => JSON.stringify(event) + '\n').join('')
const ready = { type: 'progress', summary: { discovery: { status: 'ready' } } }
const done = { type: 'done' }

for (const scenario of ['cold', 'warm', 'stale-ready', 'error', 'failed', 'pending-done', 'truncated', 'missing-pdf', 'http-error', 'timeout'] as const) {
  test(`parity media readiness: ${scenario}`, async () => {
    const requests: string[] = []
    let hanging: ReadableStreamDefaultController<Uint8Array> | undefined
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
      const url = new URL(request.url); requests.push(url.pathname + url.search)
      if (url.searchParams.get('stream') !== '1') {
        return Response.json(scenario === 'missing-pdf' ? { ...page, items: page.items.filter(item => item.mediaType !== 'application/pdf') } : page)
      }
      if (scenario === 'http-error') return new Response('unavailable', { status: 503 })
      const initial = { type: 'snapshot', page: scenario === 'warm' || scenario === 'stale-ready' ? page : { discovery: { status: 'pending' }, items: [], total: 0 } }
      const events = scenario === 'error' ? [initial, { type: 'error', message: 'worker failed' }, done]
        : scenario === 'failed' ? [initial, { type: 'progress', summary: { discovery: { status: 'failed', message: 'bad log' } } }, done]
        : scenario === 'pending-done' || scenario === 'stale-ready' ? [initial, done]
        : scenario === 'truncated' ? [initial, ready]
        : [initial, ready, done]
      if (scenario === 'timeout') return new Response(new ReadableStream({ start(controller) { hanging = controller } }), { headers: { 'content-type': 'application/x-ndjson' } })
      // Fragment frames across chunks to exercise stream boundaries.
      const encoded = new TextEncoder().encode(frames(events))
      return new Response(new ReadableStream({ start(controller) {
        controller.enqueue(encoded.slice(0, 7)); controller.enqueue(encoded.slice(7)); controller.close()
      } }), { headers: { 'content-type': 'application/x-ndjson' } })
    } })
    try {
      const result = prepareParityMedia(`http://127.0.0.1:${server.port}`, scenario === 'timeout' ? 30 : 2000)
      if (scenario === 'cold' || scenario === 'warm') {
        await result
        expect(requests).toEqual([
          '/api/session-media/11111111-2222-4333-8444-555555555555/items?stream=1',
          '/api/session-media/11111111-2222-4333-8444-555555555555/items',
        ])
      } else {
        await expect(result).rejects.toThrow()
        if (scenario !== 'missing-pdf') expect(requests).toHaveLength(1)
      }
    } finally {
      try { hanging?.close() } catch { /* Fetch cancellation can close it first. */ }
      server.stop(true)
    }
  })
}
