/** Real thumbnail pipeline, viewport admission and lifecycle cancellation. */
import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import { PNG } from 'pngjs'
import { mediaFixture, TINY_PNG } from './helpers/mediaFixture'
import { exifTiff, withPngExif } from '../fixtures/pngExif'

test.use({ serviceWorkers: 'block', viewport: { width: 1280, height: 900 } })
test.describe.configure({ timeout: 180_000 })

function appendImages(logPath: string, sessionId: string, count: number, data = TINY_PNG) {
  for (let i = 0; i < count; i++) {
    let image = data
    if (count > 1) {
      const decoded = PNG.sync.read(Buffer.from(data, 'base64'))
      decoded.data[0] = i
      image = PNG.sync.write(decoded).toString('base64')
    }
    fs.appendFileSync(logPath, JSON.stringify({
      type: 'user', sessionId, timestamp: new Date().toISOString(),
      message: { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: image } }] },
    }) + '\n')
  }
}

test('nearby thumbnails stay lazy; selected originals fill the mobile viewer', async ({ page, request }) => {
  const fixture = await mediaFixture(request, 0)
  const thumbnails = new Set<string>(), originals: string[] = []
  page.context().on('request', req => {
    const url = new URL(req.url())
    if (url.pathname !== `/api/session-media/${fixture.sessionId}`) return
    if (url.searchParams.get('thumbnail') === '1') thumbnails.add(req.url())
    else originals.push(req.url())
  })
  try {
    const large = new PNG({ width: 256, height: 512 })
    // Deterministic noise resists PNG compression and exceeds the old 64KiB budget.
    let random = 7
    for (let i = 0; i < large.data.length; i++) {
      random = (Math.imul(random, 1664525) + 1013904223) >>> 0
      large.data[i] = random >>> 24
    }
    const source = PNG.sync.write(large)
    expect(source.length).toBeGreaterThan(64 * 1024)
    appendImages(fixture.logPath, fixture.sessionId, 1, source.toString('base64'))
    large.data[0] ^= 255
    appendImages(fixture.logPath, fixture.sessionId, 1, PNG.sync.write(large).toString('base64'))
    appendImages(fixture.logPath, fixture.sessionId, 38)
    await expect.poll(async () => (await fixture.find())?.mediaSummary?.total, { timeout: 30_000 }).toBe(40)
    await page.goto('/'); await fixture.select(page)
    await page.setViewportSize({ width: 390, height: 844 })
    await page.waitForTimeout(300)
    expect(thumbnails.size).toBe(0)
    await page.getByTestId('media-rail-pill').click()
    const images = page.getByTestId('media-rail').locator('img')
    await expect(images.first()).toBeVisible()
    await expect.poll(() => images.first().evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(64)
    await page.waitForTimeout(500)
    const first = thumbnails.size
    expect(first).toBeGreaterThan(0)
    expect(first).toBeLessThan(20)
    expect(originals).toHaveLength(0)
    await page.getByTestId('media-scroll').evaluate(el => { el.scrollLeft = 1000; el.dispatchEvent(new Event('scroll')) })
    await expect.poll(() => thumbnails.size).toBeGreaterThan(first)
    expect(thumbnails.size).toBeLessThan(40)
    expect(originals).toHaveLength(0)
    await page.getByTestId('media-scroll').evaluate(el => { el.scrollLeft = 0; el.dispatchEvent(new Event('scroll')) })
    await images.first().click()
    const lightbox = page.getByTestId('media-lightbox')
    await expect(lightbox).toBeVisible()
    await expect.poll(() => originals.length).toBe(1)
    await expect(lightbox.getByTestId('media-lightbox-original')).toBeVisible()
    const portrait = await lightbox.boundingBox()
    expect(portrait!.x).toBeCloseTo(0, 0)
    expect(portrait!.y).toBeCloseTo(0, 0)
    expect(portrait!.width).toBeCloseTo(390, 0)
    expect(portrait!.height).toBeCloseTo(844, 0)
    const stage = await lightbox.getByTestId('media-lightbox-stage').boundingBox()
    expect(stage!.width).toBe(390)
    const painted = await lightbox.getByTestId('media-lightbox-original').evaluate((img: HTMLImageElement) => {
      const box = img.getBoundingClientRect()
      const scale = Math.min(box.width / img.naturalWidth, box.height / img.naturalHeight)
      return { width: img.naturalWidth * scale, height: img.naturalHeight * scale,
        naturalWidth: img.naturalWidth, fit: getComputedStyle(img).objectFit }
    })
    expect(painted.naturalWidth).toBe(256)
    expect(painted.fit).toBe('contain')
    expect(painted.height).toBeGreaterThan(600)
    expect(painted.width).toBeGreaterThan(300)
    expect(painted.height).toBeGreaterThanOrEqual(stage!.height - 5)
    for (const name of ['Close image viewer', 'Previous image', 'Next image']) {
      const box = (await lightbox.getByRole('button', { name, exact: true }).boundingBox())!
      expect(box.x).toBeGreaterThanOrEqual(0)
      expect(box.x + box.width).toBeLessThanOrEqual(390)
      expect(box.y).toBeGreaterThanOrEqual(0)
      expect(box.y + box.height).toBeLessThanOrEqual(844)
    }
    await page.screenshot({ path: test.info().outputPath(`lightbox-portrait-${test.info().project.name}.png`) })
    await page.setViewportSize({ width: 844, height: 320 })
    const bounds = await lightbox.boundingBox()
    expect(bounds).not.toBeNull()
    for (const name of ['Close image viewer', 'Previous image', 'Next image']) {
      const box = await lightbox.getByRole('button', { name, exact: true }).boundingBox()
      expect(box).not.toBeNull()
      expect(box!.y).toBeGreaterThanOrEqual(bounds!.y)
      expect(box!.y + box!.height).toBeLessThanOrEqual(bounds!.y + bounds!.height)
      expect(box!.y + box!.height).toBeLessThanOrEqual(320)
    }
    await page.screenshot({ path: test.info().outputPath(`lightbox-landscape-${test.info().project.name}.png`) })
    await page.setViewportSize({ width: 390, height: 844 })
    await expect.poll(() => originals.length).toBe(1)
    await lightbox.getByRole('button', { name: 'Next image', exact: true }).click()
    await expect.poll(() => originals.length).toBe(2)
    await lightbox.getByRole('button', { name: 'Next image', exact: true }).click()
    await expect.poll(() => originals.length).toBe(3)
    await lightbox.getByRole('button', { name: 'Previous image', exact: true }).click()
    await expect(lightbox.getByTestId('media-lightbox-original')).toBeVisible()
    // The selected original may be served from browser cache on a return visit.
    expect(new Set(originals).size).toBe(3)
    await page.keyboard.press('Escape')
    await page.screenshot({ path: test.info().outputPath(`thumbnails-mobile-${test.info().project.name}.png`) })
  } finally { fixture.cleanup() }
})

test('corrupt images show an explicit fallback without fetching originals or retrying', async ({ page, request }) => {
  const fixture = await mediaFixture(request, 0)
  let thumbnails = 0, originals = 0
  page.on('request', req => {
    const url = new URL(req.url())
    if (url.pathname === `/api/session-media/${fixture.sessionId}`) {
      if (url.searchParams.get('thumbnail') === '1') thumbnails++
      else originals++
    }
  })
  try {
    appendImages(fixture.logPath, fixture.sessionId, 1, Buffer.from('corrupt image').toString('base64'))
    await expect.poll(async () => (await fixture.find())?.mediaSummary?.total, { timeout: 30_000 }).toBe(1)
    await page.goto('/'); await fixture.select(page)
    await page.setViewportSize({ width: 390, height: 844 })
    await page.getByTestId('media-rail-pill').click()
    await expect.poll(() => thumbnails).toBe(1)
    await expect(page.getByTestId('media-rail').getByRole('button', { name: /preview unavailable.*open (original|image)/i })).toBeVisible()
    await expect(page.getByTestId('media-thumb')).toHaveAttribute('data-preview-state', 'error')
    await page.waitForTimeout(500)
    expect(thumbnails).toBe(1)
    expect(originals).toBe(0)
    await page.screenshot({ path: test.info().outputPath(`thumbnail-fallback-${test.info().project.name}.png`) })
  } finally { fixture.cleanup() }
})

test('backgrounding aborts pending thumbnail and resumes only when visible', async ({ page, request }) => {
  const fixture = await mediaFixture(request, 0, true)
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let requests = 0, aborted = false
  page.on('requestfailed', req => { if (req.url().includes('thumbnail=1')) aborted = true })
  await page.route('**/api/session-media/*?**thumbnail=1', async route => {
    requests++
    const response = await route.fetch()
    if (requests === 1) await gate
    await route.fulfill({ response }).catch(() => {})
  })
  try {
    await page.goto('/'); await fixture.select(page)
    await page.setViewportSize({ width: 390, height: 844 })
    await page.getByTestId('media-rail-pill').click()
    await expect.poll(() => requests).toBe(1)
    await expect(page.getByTestId('media-thumb')).toHaveAttribute('data-preview-state', 'loading')
    // Browser lifecycle simulation, not a claim of native OS suspension.
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
      document.dispatchEvent(new Event('visibilitychange')); window.dispatchEvent(new Event('pagehide'))
    })
    await expect.poll(() => aborted).toBe(true)
    release()
    await page.waitForTimeout(300)
    expect(requests).toBe(1)
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' })
      document.dispatchEvent(new Event('visibilitychange')); window.dispatchEvent(new Event('pageshow'))
    })
    await expect(page.getByTestId('media-rail').locator('img')).toBeVisible()
    await expect.poll(() => requests).toBe(2)
  } finally { release(); fixture.cleanup() }
})


test('PNG screenshots with EXIF metadata render correctly oriented previews without originals', async ({ page, request }) => {
  const fixture = await mediaFixture(request, 0)
  const thumbnailResponses: number[] = []
  let originals = 0
  page.on('request', req => {
    const url = new URL(req.url())
    if (url.pathname === `/api/session-media/${fixture.sessionId}` && !url.searchParams.has('thumbnail')) originals++
  })
  page.on('response', response => {
    const url = new URL(response.url())
    if (url.pathname === `/api/session-media/${fixture.sessionId}` && url.searchParams.get('thumbnail') === '1') {
      thumbnailResponses.push(response.status())
    }
  })
  try {
    const source = new PNG({ width: 320, height: 160 })
    // Two distinct halves make orientation observable as well as width/height.
    for (let y = 0; y < source.height; y++) for (let x = 0; x < source.width; x++) {
      const at = (y * source.width + x) * 4
      source.data[at] = x < source.width / 2 ? 240 : 20
      source.data[at + 1] = 30
      source.data[at + 2] = x < source.width / 2 ? 20 : 240
      source.data[at + 3] = 255
    }
    const image = PNG.sync.write(source)
    appendImages(fixture.logPath, fixture.sessionId, 1, withPngExif(image, exifTiff(1)).toString('base64'))
    appendImages(fixture.logPath, fixture.sessionId, 1, withPngExif(image, exifTiff(6, false)).toString('base64'))
    await expect.poll(async () => (await fixture.find())?.mediaSummary?.total, { timeout: 30_000 }).toBe(2)
    await page.goto('/'); await fixture.select(page)
    await page.setViewportSize({ width: 390, height: 844 })
    await page.getByTestId('media-rail-pill').click()
    const previews = page.getByTestId('media-rail').getByTestId('media-thumbnail')
    await expect(previews).toHaveCount(2)
    await expect.poll(() => previews.evaluateAll(images => images.map(image => {
      const img = image as HTMLImageElement
      return [img.naturalWidth, img.naturalHeight]
    }))).toEqual([[128, 64], [64, 128]])
    expect(thumbnailResponses).toEqual([200, 200])
    expect(originals).toBe(0)
    const pixels = await previews.nth(1).evaluate(image => {
      const canvas = document.createElement('canvas'), img = image as HTMLImageElement
      canvas.width = img.naturalWidth; canvas.height = img.naturalHeight
      const context = canvas.getContext('2d')!
      context.drawImage(img, 0, 0)
      return [Array.from(context.getImageData(32, 10, 1, 1).data), Array.from(context.getImageData(32, 118, 1, 1).data)]
    })
    expect(pixels).toEqual([[240, 30, 20, 255], [20, 30, 240, 255]])
    await page.screenshot({ path: test.info().outputPath(`png-exif-${test.info().project.name}.png`) })
  } finally { fixture.cleanup() }
})
