/** Real HTTP contention regression. No intercepted browser requests or external GitHub calls. */
import { chromium, webkit } from '@playwright/test'
import path from 'node:path'

const entry = path.resolve(import.meta.dir, '../tests/fixtures/pr-request-priority/App.tsx')
const bundle = await Bun.build({ entrypoints: [entry], target: 'browser', define: { 'process.env.NODE_ENV': '"production"' } })
if (!bundle.success) throw Error(String(bundle.logs))
const javascript = await bundle.outputs[0].text()
const summary = { identity: 'fixture', revision: 'r1', total: 1, images: 1, documents: 0, links: 0, additions: 1, discovery: { status: 'ready' } }
const snapshot = { type: 'snapshot', page: { identity: 'fixture', revision: 'r1', total: 1, discovery: { status: 'ready' },
  items: [{ kind: 'image', url: 'https://example.com/fixture.png', label: 'Indexed image' }], nextCursor: null } }
const html = '<!doctype html><meta charset="utf-8"><title>PR contention regression</title><style>.invisible{visibility:hidden}.absolute{position:absolute}.fixed{position:fixed}.hidden{display:none}svg{max-width:24px}</style><div id="root"></div><script src="/app.js"></script>'

for (const [name, engine] of [['chromium', chromium], ['webkit', webkit]] as const) {
  let infoRequests = 0, checkRequests = 0, mediaRequests = 0
  const batches: number[] = []
  const gate = Promise.withResolvers<void>()
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0,
    async fetch(request, server) {
      const url = new URL(request.url)
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
  const browser = await engine.launch({ headless: true })
  try {
    const page = await browser.newPage()
    await page.goto(`http://127.0.0.1:${server.port}`, { waitUntil: 'domcontentloaded' })
    await page.locator('a[href="https://github.com/example/test/pull/1"]').hover()
    const deadline = Date.now() + 5_000
    while ((!infoRequests || !checkRequests) && Date.now() < deadline) await Bun.sleep(10)
    if (infoRequests !== 1 || checkRequests !== 1) throw Error(`Unbounded PR admission: ${infoRequests} info, ${checkRequests} checks`)
    const started = performance.now()
    await page.getByTestId('media-rail-pill').click()
    // The gate remains CLOSED until after the tile and WebSocket assertions.
    await page.getByTestId('media-chip').waitFor({ timeout: 5_000 })
    const firstTileMs = performance.now() - started
    await Bun.sleep(250)
    const pongs = await page.evaluate(() => (window as unknown as { pongs: number }).pongs)
    if (mediaRequests !== 1 || infoRequests !== 1 || checkRequests !== 1 || pongs !== 1 || batches.some(size => size > 8)) {
      throw Error('Media or WebSocket was blocked by optional metadata')
    }
    console.log(JSON.stringify({ engine: name, firstTileMs, heldInfo: infoRequests, heldChecks: checkRequests, mediaRequests, pongs }))
    gate.resolve()
    await page.getByRole('link', { name: 'example/test#18 Open', exact: true }).waitFor({ timeout: 5_000 })
    if (batches.join(',') !== '8,8,2') throw Error(`Unexpected batches: ${batches}`)
  } finally { gate.resolve(); await browser.close(); server.stop(true) }
}
