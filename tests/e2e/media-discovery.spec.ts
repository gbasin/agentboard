/** Browser stream lifecycle with real session/terminal/payload fixtures and controlled delivery. */
import { test, expect, type Page } from '@playwright/test'
import { mediaFixture } from './helpers/mediaFixture'

test.use({ serviceWorkers: 'block', viewport: { width: 1280, height: 900 } })
test.describe.configure({ timeout: 180_000 })

async function installDeliveryGate(page: Page, sessionId: string) {
  await page.addInitScript(sessionId => {
    const native = window.fetch.bind(window)
    const requests: { controller: ReadableStreamDefaultController<Uint8Array>; aborted: boolean }[] = []
    ;(window as unknown as { discoveryTest: unknown }).discoveryTest = {
      requests,
      send(index: number, event: unknown) { requests[index].controller.enqueue(new TextEncoder().encode(JSON.stringify(event) + '\n')) },
      finish(index: number) { requests[index].controller.enqueue(new TextEncoder().encode('{"type":"done"}\n')); requests[index].controller.close() },
    }
    window.fetch = async (input, init) => {
      if (!String(input).includes(`/api/session-media/${sessionId}/items?`)) return native(input, init)
      let record!: { controller: ReadableStreamDefaultController<Uint8Array>; aborted: boolean }
      const body = new ReadableStream<Uint8Array>({ start(controller) {
        record = { controller, aborted: false }; requests.push(record)
        init?.signal?.addEventListener('abort', () => { record.aborted = true; controller.error(new DOMException('Aborted', 'AbortError')) }, { once: true })
      } })
      return new Response(body, { headers: { 'Content-Type': 'application/x-ndjson' } })
    }
  }, sessionId)
}
async function send(page: Page, index: number, event: unknown) {
  await page.evaluate(({ index, event }) => (window as any).discoveryTest.send(index, event), { index, event })
}
async function visibility(page: Page, visible: boolean) {
  await page.evaluate(visible => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visible ? 'visible' : 'hidden' })
    document.dispatchEvent(new Event('visibilitychange'))
    window.dispatchEvent(new Event(visible ? 'pageshow' : 'pagehide'))
  }, visible)
}

test('renders the first streamed item before completion and freezes it through progress, backgrounding and hydration', async ({ page, request }) => {
  const fixture = await mediaFixture(request, 2, true)
  const found = (await fixture.find())!, indexed = await fixture.items()
  const image = indexed.items.find(item => item.kind === 'image')!
  const discovery = { status: 'indexing', bytesRead: 1, bytesTotal: 10, filesDone: 0, filesTotal: 1 }
  const snapshot = (items: unknown[], revision = indexed.revision) => ({ type: 'snapshot', page: { ...indexed, revision, items, nextCursor: null, discovery } })
  try {
    await installDeliveryGate(page, fixture.sessionId)
    await page.goto('/'); await fixture.select(page)
    await page.setViewportSize({ width: 390, height: 844 })
    await page.getByTestId('media-rail-pill').click()
    await expect.poll(() => page.evaluate(() => (window as any).discoveryTest.requests.length)).toBe(1)
    await send(page, 0, snapshot([]))
    await expect(page.getByTestId('media-rail')).toContainText('Finding media')
    await expect(page.getByTestId('media-rail')).not.toContainText('No media in this session')
    await send(page, 0, snapshot([image]))
    await expect(page.getByTestId('media-thumbnail')).toBeVisible()
    // The stream is still open here: the first result is usable before done.
    await expect(page.getByTestId('media-rail')).toContainText('Results are partial')
    await page.getByTestId('media-thumb').click()
    await expect(page.getByTestId('media-lightbox-original')).toBeVisible()
    await page.keyboard.press('Escape')
    await send(page, 0, { type: 'progress', summary: { ...found.mediaSummary, revision: 'newer', discovery: { ...discovery, bytesRead: 5 } } })
    await send(page, 0, snapshot([image, { ...image, label: 'Must not prepend' }], 'newer'))
    await expect(page.getByTestId('media-thumb')).toHaveCount(1)
    await expect(page.getByRole('button', { name: 'Refresh media', exact: true })).toBeVisible()
    await page.screenshot({ path: test.info().outputPath(`partial-discovery-${test.info().project.name}.png`) })
    await visibility(page, false)
    await expect.poll(() => page.evaluate(() => (window as any).discoveryTest.requests[0].aborted)).toBe(true)
    await visibility(page, true)
    await expect.poll(() => page.evaluate(() => (window as any).discoveryTest.requests.length)).toBe(2)
    await send(page, 1, snapshot([image, image], 'newer'))
    await send(page, 1, { type: 'progress', summary: { ...found.mediaSummary, revision: 'newer', discovery: { status: 'ready' } } })
    await page.evaluate(() => (window as any).discoveryTest.finish(1))
    await expect(page.getByTestId('media-thumb')).toHaveCount(1)
    await expect(page.getByTestId('media-rail')).not.toContainText('Finding ')
    await page.getByRole('button', { name: 'Collapse media rail' }).click()
    await page.waitForTimeout(250)
    expect(await page.evaluate(() => (window as any).discoveryTest.requests.length)).toBe(2)
  } finally { fixture.cleanup() }
})

test('real discovery handles a cold synthetic 33MiB transcript while retaining a usable terminal', async ({ page, request }) => {
  const fixture = await mediaFixture(request, 0, true, { waitForSummary: false, textBytes: 33 * 1024 * 1024 })
  const replies: number[] = []
  page.on('response', response => {
    if (response.url().includes(`/api/session-media/${fixture.sessionId}/items?`)) replies.push(response.status())
  })
  try {
    await page.goto('/'); await fixture.select(page)
    await page.getByTestId('media-rail-pill').click()
    await expect(page.getByTestId('media-thumbnail')).toBeVisible({ timeout: 60_000 })
    await expect(page.getByTestId('media-rail')).not.toContainText('Finding ', { timeout: 60_000 })
    expect(replies).toEqual([200])
    await page.getByRole('button', { name: 'Collapse media rail' }).click()
    await page.locator('.xterm-helper-textarea').fill('COLD_DISCOVERY_TERMINAL_OK')
    await page.keyboard.press('Enter')
    await expect.poll(() => fixture.capture()).toContain('COLD_DISCOVERY_TERMINAL_OK')
  } finally { fixture.cleanup() }
})
