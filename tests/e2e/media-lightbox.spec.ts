/** Newest-first image navigation across bounded media pages and lifecycle transitions. */
import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import fs from 'node:fs'
import { PNG } from 'pngjs'
import { mediaFixture, TINY_PNG } from './helpers/mediaFixture'
import type { SessionMedia } from '../../src/shared/types'

test.use({ serviceWorkers: 'block', viewport: { width: 1280, height: 900 } })
test.describe.configure({ timeout: 180_000 })

async function gallery(request: APIRequestContext) {
  const fixture = await mediaFixture(request, 0)
  const imagePositions = new Set([0, 122, 124, 125])
  const start = Date.now()
  const lines: string[] = []
  for (let i = 0; i < 126; i++) {
    const timestamp = new Date(start + i).toISOString()
    if (imagePositions.has(i)) {
      const image = PNG.sync.read(Buffer.from(TINY_PNG, 'base64')); image.data[0] = i
      lines.push(JSON.stringify({ type: 'user', sessionId: fixture.sessionId, timestamp,
        message: { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG.sync.write(image).toString('base64') } }] },
      }))
    } else if (i % 3 === 0) {
      lines.push(JSON.stringify({ type: 'assistant', sessionId: fixture.sessionId, timestamp,
        message: { role: 'assistant', content: [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: Buffer.from(`%PDF-1.4 gallery ${i}`).toString('base64') } }] },
      }))
    } else lines.push(JSON.stringify({ type: 'frame-link', sessionId: fixture.sessionId, timestamp,
      frameUrl: `https://example.com/${fixture.sessionId}/${i}`, title: `Link ${i}` }))
  }
  fs.appendFileSync(fixture.logPath, lines.join('\n') + '\n')
  await expect.poll(async () => (await fixture.find())?.mediaSummary?.total, { timeout: 30_000 }).toBe(126)
  const images: SessionMedia[] = []
  let cursor: string | undefined
  do {
    const page = await fixture.items(cursor)
    images.push(...page.items.filter(item => item.kind === 'image'))
    cursor = page.nextCursor ?? undefined
  } while (cursor)
  expect(images).toHaveLength(4)
  // Independently pin chronology: /items and /neighbors must agree on newest first.
  const offsets = images.map(image => Number(new URL(image.url, 'http://localhost').searchParams.get('offset')))
  expect(offsets).toEqual([...offsets].sort((a, b) => b - a))
  return { ...fixture, images }
}

async function visibility(page: Page, visible: boolean) {
  await page.evaluate(visible => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visible ? 'visible' : 'hidden' })
    document.dispatchEvent(new Event('visibilitychange'))
    window.dispatchEvent(new Event(visible ? 'pageshow' : 'pagehide'))
  }, visible)
}

test('newest-first image navigation skips long non-image gaps without loading intervening rail pages', async ({ page, request }) => {
  const fixture = await gallery(request)
  let pageRequests = 0, neighborRequests = 0
  const terminalInput: string[] = []
  page.on('request', req => {
    const pathname = new URL(req.url()).pathname
    if (pathname === `/api/session-media/${fixture.sessionId}/items`) pageRequests++
    if (pathname === `/api/session-media/${fixture.sessionId}/neighbors`) neighborRequests++
  })
  page.on('websocket', ws => ws.on('framesent', ({ payload }) => {
    try { const frame = JSON.parse(String(payload)); if (frame.type === 'terminal-input') terminalInput.push(frame.data) } catch { /* binary frame */ }
  }))
  try {
    await page.goto('/'); await fixture.select(page)
    await page.setViewportSize({ width: 390, height: 844 })
    expect(pageRequests).toBe(0)
    await page.getByTestId('media-rail-pill').click()
    await page.getByTestId('media-thumb').first().click()
    const dialog = page.getByTestId('media-lightbox')
    const original = dialog.getByRole('link', { name: 'Open original', exact: true })
    await expect(original).toHaveAttribute('href', fixture.images[0].url)
    await expect(dialog.getByRole('button', { name: 'Previous image', exact: true })).toBeDisabled()
    expect(pageRequests).toBe(1)
    const beforeInput = terminalInput.length
    await dialog.getByRole('button', { name: 'Next image', exact: true }).click()
    await expect(original).toHaveAttribute('href', fixture.images[1].url, { timeout: 15_000 })
    expect(pageRequests).toBe(1)
    await dialog.getByRole('button', { name: 'Next image', exact: true }).click()
    await expect(original).toHaveAttribute('href', fixture.images[2].url)
    await expect(dialog.getByRole('button', { name: 'Next image', exact: true })).toBeEnabled()
    await page.keyboard.press('ArrowRight')
    await expect(original).toHaveAttribute('href', fixture.images[3].url)
    await expect(dialog.getByRole('button', { name: 'Next image', exact: true })).toBeDisabled()
    expect(pageRequests).toBe(1)
    await expect(dialog.getByRole('button', { name: 'Previous image', exact: true })).toBeEnabled()
    await page.keyboard.press('ArrowLeft')
    await expect(original).toHaveAttribute('href', fixture.images[2].url)
    await dialog.getByRole('button', { name: 'Previous image', exact: true }).click()
    await expect(original).toHaveAttribute('href', fixture.images[1].url)
    await dialog.getByRole('button', { name: 'Previous image', exact: true }).click()
    await expect(original).toHaveAttribute('href', fixture.images[0].url, { timeout: 15_000 })
    expect(pageRequests).toBe(1)
    expect(neighborRequests).toBeGreaterThanOrEqual(4)
    expect(neighborRequests).toBeLessThanOrEqual(7)
    await page.keyboard.type('LIGHTBOX_KEYS_STAY_LOCAL')
    await page.screenshot({ path: test.info().outputPath(`lightbox-mobile-${test.info().project.name}.png`) })
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await page.waitForTimeout(350)
    await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute('data-testid'))).toBe('media-thumb')
    expect(terminalInput).toHaveLength(beforeInput)
    await page.getByLabel('Collapse media rail').click()
    const finalNeighbors = neighborRequests
    await page.waitForTimeout(300)
    expect(pageRequests).toBe(1)
    expect(neighborRequests).toBe(finalNeighbors)
  } finally { fixture.cleanup() }
})

test('backgrounding a pending navigation cancels it and does not replay the move on return', async ({ page, request }) => {
  const fixture = await gallery(request)
  let requests = 0, aborted = false, release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  page.on('requestfailed', req => { if (req.url().includes('/neighbors?')) aborted = true })
  await page.route(`**/api/session-media/${fixture.sessionId}/neighbors*`, async route => {
    requests++
    const response = await route.fetch()
    if (requests === 2) await gate
    await route.fulfill({ response }).catch(() => {})
  })
  try {
    await page.goto('/'); await fixture.select(page)
    await page.setViewportSize({ width: 390, height: 844 })
    await page.getByTestId('media-rail-pill').click()
    await page.getByTestId('media-thumb').first().click()
    const dialog = page.getByTestId('media-lightbox')
    const original = dialog.getByRole('link', { name: 'Open original', exact: true })
    await expect(original).toHaveAttribute('href', fixture.images[0].url)
    await expect(dialog.getByRole('button', { name: 'Next image', exact: true })).toBeEnabled()
    await dialog.getByRole('button', { name: 'Next image', exact: true }).focus()
    await page.keyboard.press('Enter')
    await expect.poll(() => requests).toBe(2)
    await expect(original).toHaveAttribute('href', fixture.images[1].url)
    await expect.poll(() => page.evaluate(() => Boolean(document.activeElement?.closest('[data-testid="media-lightbox"]')))).toBe(true)
    const modifier = await page.evaluate(() => navigator.platform.toUpperCase().includes('MAC') ? 'Control+Alt' : 'Control+Shift')
    await page.keyboard.press(`${modifier}+Comma`)
    await expect(page.getByRole('button', { name: 'Close settings', exact: true })).toHaveCount(0)
    await expect(dialog).toBeVisible()
    await visibility(page, false)
    await expect.poll(() => aborted).toBe(true)
    release()
    await visibility(page, true)
    await expect(original).toHaveAttribute('href', fixture.images[1].url)
    await expect.poll(() => requests).toBe(3)
    await page.waitForTimeout(500)
    expect(requests).toBe(3)
    await dialog.getByRole('button', { name: 'Next image', exact: true }).click()
    await expect(original).toHaveAttribute('href', fixture.images[2].url, { timeout: 15_000 })
    await expect.poll(() => requests).toBe(4)
  } finally { release(); fixture.cleanup() }
})
