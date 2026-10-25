/** Real parser/index/HTTP/UI media regression coverage; no fake media frames. */
import { test, expect } from '@playwright/test'
import { mediaFixture } from './helpers/mediaFixture'

test.use({ serviceWorkers: 'block', viewport: { width: 1280, height: 900 } })
test.describe.configure({ timeout: 180_000 })

test('closed rail downloads no pages; opening serves real bounded image bytes', async ({ page, request }) => {
  const fixture = await mediaFixture(request, 2, true)
  const itemRequests: string[] = []
  page.on('request', r => { if (r.url().includes(`/session-media/${fixture.sessionId}/items`)) itemRequests.push(r.url()) })
  try {
    await page.goto('/'); await fixture.select(page)
    await expect(page.getByTestId('media-rail-pill')).toHaveAccessibleName(/3 items/)
    await page.waitForTimeout(500)
    expect(itemRequests).toHaveLength(0)
    await page.getByTestId('media-rail-pill').click()
    const rail = page.getByTestId('media-rail')
    const image = rail.getByTestId('media-thumb').locator('img')
    await expect(image).toBeVisible()
    await expect.poll(() => image.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(96)
    expect(itemRequests).toHaveLength(1)
    const url = await image.getAttribute('src')
    expect(url).toMatch(/^blob:/)
    const items = await fixture.items()
    const response = await request.get(items.items[0].url + '&thumbnail=1')
    expect(response.status()).toBe(200)
    expect(response.headers()['content-type']).toBe('image/png')
    expect((await response.body()).length).toBeLessThan(128 * 1024)
    await image.click()
    await expect(page.getByTestId('media-lightbox')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('media-lightbox')).toHaveCount(0)
    await page.getByLabel('Collapse media rail').click()
    await page.getByTestId('media-rail-pill').click()
    await expect(image).toBeVisible()
    expect(itemRequests).toHaveLength(1)
    await page.screenshot({ path: test.info().outputPath(`media-paged-rail-${test.info().project.name}.png`) })
    await page.setViewportSize({ width: 390, height: 844 })
    await expect(rail).toBeVisible()
    await page.screenshot({ path: test.info().outputPath(`media-paged-mobile-${test.info().project.name}.png`) })
    expect(itemRequests).toHaveLength(1)
  } finally { fixture.cleanup() }
})

test('link pagination loads the next oldest-first page; live additions do not fetch or move the view', async ({ page, request }) => {
  const fixture = await mediaFixture(request, 85)
  let requests = 0
  page.on('request', r => { if (r.url().includes(`/session-media/${fixture.sessionId}/items`)) requests++ })
  try {
    await page.goto('/'); await fixture.select(page)
    await page.getByTestId('media-rail-pill').click()
    const rail = page.getByTestId('media-rail'), strip = page.getByTestId('links-scroll')
    await expect(rail.getByRole('link')).toHaveCount(40)
    expect(requests).toBe(1)
    await expect(rail.getByRole('link').first()).toHaveAttribute('aria-label', /^Item 00000 /)
    await page.getByRole('button', { name: 'Newer links', exact: true }).click()
    await expect.poll(() => requests).toBe(2)
    await expect(rail.getByRole('link').last()).toHaveAttribute('aria-label', /^Item 00079 /)
    const position = await strip.evaluate(el => el.scrollTop)
    fixture.append(85)
    await expect.poll(async () => (await fixture.find())?.mediaSummary?.total, { timeout: 30_000 }).toBe(86)
    await expect(page.getByRole('button', { name: 'Refresh media', exact: true })).toBeVisible()
    expect(requests).toBe(2)
    expect(await strip.evaluate(el => el.scrollTop)).toBe(position)
    await expect(rail.getByRole('link').last()).toHaveAttribute('aria-label', /^Item 00079 /)
  } finally { fixture.cleanup() }
})

test('all 2,366 items remain reachable with bounded pages and a small summary', async ({ request }) => {
  const fixture = await mediaFixture(request, 2366)
  try {
    const session = (await fixture.find())!
    expect(session.media).toBeUndefined()
    expect(Buffer.byteLength(JSON.stringify(session))).toBeLessThan(4096)
    const urls: string[] = [], labels: string[] = []
    let cursor: string | undefined
    do {
      const page = await fixture.items(cursor)
      expect(page.items.length).toBeLessThanOrEqual(40)
      urls.push(...page.items.map(item => item.url)); labels.push(...page.items.map(item => item.label ?? ''))
      cursor = page.nextCursor ?? undefined
    } while (cursor)
    expect(urls).toHaveLength(2366)
    expect(new Set(urls).size).toBe(2366)
    expect(labels[0]).toMatch(/^Item 00000 /)
    expect(labels.at(-1)).toMatch(/^Item 02365 /)
  } finally { fixture.cleanup() }
})

test('a delayed page cannot populate a different selected session', async ({ page, request }) => {
  const first = await mediaFixture(request, 1), second = await mediaFixture(request, 2)
  let release: (() => void) | undefined
  const gate = new Promise<void>(resolve => { release = resolve })
  let intercepted = false
  await page.route(`**/api/session-media/${first.sessionId}/items*`, async route => {
    intercepted = true
    const response = await route.fetch()
    await gate
    await route.fulfill({ response }).catch(() => {})
  })
  try {
    await page.goto('/'); await first.select(page)
    await page.getByTestId('media-rail-pill').click()
    await expect.poll(() => intercepted).toBe(true)
    await second.select(page)
    release!()
    await page.getByTestId('media-rail-pill').click()
    const links = page.getByTestId('media-rail').getByRole('link')
    await expect(links).toHaveCount(2)
    for (const link of await links.all()) await expect(link).toHaveAttribute('href', new RegExp(second.sessionId))
  } finally { release!(); first.cleanup(); second.cleanup() }
})

test('backgrounding cancels optional page work; a closed rail does not refetch on return', async ({ page, request }) => {
  const fixture = await mediaFixture(request, 80)
  let release: (() => void) | undefined
  const gate = new Promise<void>(resolve => { release = resolve })
  let requests = 0, failed = false
  page.on('requestfailed', r => { if (r.url().includes(`/session-media/${fixture.sessionId}/items`)) failed = true })
  await page.route(`**/api/session-media/${fixture.sessionId}/items*`, async route => {
    requests++
    const response = await route.fetch()
    if (requests === 1) await gate
    await route.fulfill({ response }).catch(() => {})
  })
  try {
    await page.goto('/'); await fixture.select(page)
    await page.getByTestId('media-rail-pill').click()
    await expect.poll(() => requests).toBe(1)
    // Lifecycle-event simulation: actual OS suspension is validated separately.
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
      document.dispatchEvent(new Event('visibilitychange'))
      window.dispatchEvent(new Event('pagehide'))
    })
    await expect.poll(() => failed).toBe(true)
    await page.getByLabel('Collapse media rail').click()
    release!()
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' })
      document.dispatchEvent(new Event('visibilitychange'))
      window.dispatchEvent(new Event('pageshow'))
    })
    await page.waitForTimeout(500)
    expect(requests).toBe(1)
    await page.getByTestId('media-rail-pill').click()
    await expect(page.getByTestId('media-rail').getByRole('link')).toHaveCount(40)
    expect(requests).toBe(2)
  } finally { release!(); fixture.cleanup() }
})

test('large media catalogs stay off the socket across reconnect and live updates', async ({ page, request }) => {
  const fixture = await mediaFixture(request, 2366)
  let connections = 0, catalogSnapshots = 0, itemRequests = 0
  const pings: number[] = [], pongs: number[] = [], catalogBytes: number[] = []
  const embeddedMedia: unknown[] = []
  const findMedia = (value: unknown): void => {
    if (!value || typeof value !== 'object') return
    for (const [key, nested] of Object.entries(value)) {
      if (key === 'media') embeddedMedia.push(nested)
      else findMedia(nested)
    }
  }
  await page.addInitScript(() => {
    const Native = window.WebSocket
    window.WebSocket = class extends Native {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols)
        if (new URL(String(url), location.href).pathname === '/ws') {
          ;(window as unknown as { mediaTestSocket: WebSocket }).mediaTestSocket = this
        }
      }
    }
  })
  page.on('request', r => { if (r.url().includes('/items')) itemRequests++ })
  page.on('websocket', ws => {
    connections++
    ws.on('framesent', ({ payload }) => {
      try { const m = JSON.parse(String(payload)); if (m.type === 'ping') pings.push(m.seq) } catch { /* not JSON */ }
    })
    ws.on('framereceived', ({ payload }) => {
      try {
        const m = JSON.parse(String(payload))
        if (m.type === 'pong') pongs.push(m.seq)
        if (['sessions', 'agent-sessions', 'agent-sessions-active', 'session-update'].includes(m.type)) {
          catalogBytes.push(Buffer.byteLength(String(payload))); findMedia(m)
          if (m.type === 'sessions') catalogSnapshots++
        }
      } catch { /* not JSON */ }
    })
  })
  try {
    await page.goto('/'); await fixture.select(page)
    await expect.poll(() => catalogSnapshots).toBeGreaterThan(0)
    await page.evaluate(() => (window as unknown as { mediaTestSocket: WebSocket }).mediaTestSocket.close())
    await expect.poll(() => connections, { timeout: 15_000 }).toBe(2)
    await expect.poll(() => catalogSnapshots, { timeout: 15_000 }).toBeGreaterThanOrEqual(2)
    const session = (await fixture.find())!
    for (let i = 0; i < 6; i++) {
      await page.evaluate(({ sessionId, name }) => {
        ;(window as unknown as { mediaTestSocket: WebSocket }).mediaTestSocket.send(JSON.stringify({ type: 'session-rename', sessionId, newName: name }))
      }, { sessionId: session.id, name: `${fixture.name}-${i}` })
      await page.waitForTimeout(5000)
    }
    await expect.poll(() => pongs.length, { timeout: 30_000 }).toBeGreaterThanOrEqual(2)
    expect(pings.every(seq => pongs.includes(seq))).toBe(true)
    expect(connections).toBe(2)
    expect(embeddedMedia).toHaveLength(0)
    expect(itemRequests).toBe(0)
    expect(Math.max(...catalogBytes)).toBeLessThan(128 * 1024)
    const input = page.locator('.xterm-helper-textarea')
    if (await input.isDisabled()) await page.getByRole('button', { name: 'Show keyboard', exact: true }).click()
    await input.focus()
    const marker = `MEDIA_RECONNECT_INPUT_${fixture.sessionId}`
    await page.keyboard.type(marker); await page.keyboard.press('Enter')
    await expect.poll(() => fixture.capture()).toContain(marker)
  } finally { fixture.cleanup() }
})
