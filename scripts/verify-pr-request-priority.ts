/** Real HTTP contention regression. No intercepted browser requests or external GitHub calls. */
import path from 'node:path'

const entry = path.resolve(import.meta.dir, '../tests/fixtures/pr-request-priority/App.tsx')
const bundle = await Bun.build({ entrypoints: [entry], target: 'browser', define: { 'process.env.NODE_ENV': '"production"' } })
if (!bundle.success) throw Error(String(bundle.logs))
const javascript = await bundle.outputs[0].text()
const summary = { identity: 'fixture', revision: 'r1', total: 1, images: 1, documents: 0, links: 0, additions: 1, discovery: { status: 'ready' } }
const snapshot = { type: 'snapshot', page: { identity: 'fixture', revision: 'r1', total: 1, discovery: { status: 'ready' },
  items: [{ kind: 'image', url: 'https://example.com/fixture.png', label: 'Indexed image' }], nextCursor: null } }
const html = '<!doctype html><meta charset="utf-8"><title>PR contention regression</title><style>.invisible{visibility:hidden}.absolute{position:absolute}.fixed{position:fixed}.hidden{display:none}svg{max-width:24px}</style><div id="root"></div><script src="/app.js"></script>'

for (const name of ['chromium', 'webkit'] as const) {
  let infoRequests = 0, checkRequests = 0, mediaRequests = 0
  const batches: number[] = []
  const gate = Promise.withResolvers<void>()
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0,
    async fetch(request, server) {
      const url = new URL(request.url)
      if (url.pathname === '/_verification/state') return Response.json({ infoRequests, checkRequests, mediaRequests, batches })
      if (url.pathname === '/_verification/release' && request.method === 'POST') { gate.resolve(); return new Response('released') }
      if (url.pathname === '/ws') {
        if (server.upgrade(request)) return
        return new Response('WebSocket upgrade failed', { status: 400 })
      }
      if (url.pathname === '/app.js') return new Response(javascript, { headers: { 'Content-Type': 'text/javascript; charset=utf-8' } })
      if (url.pathname === '/api/pr-info') {
        infoRequests++
        const { urls } = await request.json() as { urls: string[] }
        batches.push(urls.length)
        await gate.promise
        return Response.json(urls.map(url => ({ url, state: 'OPEN', title: 'Fixture', author: 'fixture' })))
      }
      if (url.pathname === '/api/pr-checks') {
        checkRequests++
        await gate.promise
        return Response.json({ url: url.searchParams.get('url'), state: 'OPEN', checks: [] })
      }
      if (url.pathname.endsWith('/items')) {
        mediaRequests++
        return new Response([snapshot, { type: 'progress', summary }, { type: 'done' }].map(frame => JSON.stringify(frame) + '\n').join(''),
          { headers: { 'Content-Type': 'application/x-ndjson' } })
      }
      return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })
    },
    websocket: { message(socket, message) { socket.send(message) } },
  })
  try {
    const child = Bun.spawn(['node', path.join(import.meta.dir, 'fixtures/prRequestPriorityBrowser.mjs'), name, `http://127.0.0.1:${server.port}`], {
      env: { ...process.env }, stdout: 'inherit', stderr: 'inherit',
    })
    if (await child.exited !== 0) throw Error(`${name} contention verification failed`)
  } finally { gate.resolve(); server.stop(true) }
}
