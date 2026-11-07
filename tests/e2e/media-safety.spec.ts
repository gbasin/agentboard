/** Real transcript payloads must never execute active content on the application origin. */
import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import { mediaFixture } from './helpers/mediaFixture'

test.use({ serviceWorkers: 'block' })
test.setTimeout(120_000)

test('HTML and SVG originals download without executing, while image previews still render', async ({ page, request }) => {
  const fixture = await mediaFixture(request, 0, true)
  const payloads = [
    ['text/html', '<html><script>document.title="UNSAFE-MEDIA-EXECUTED"</script></html>'],
    ['image/svg+xml', '<svg xmlns="http://www.w3.org/2000/svg" onload="document.title=\'UNSAFE-MEDIA-EXECUTED\'"></svg>'],
  ]
  try {
    fs.appendFileSync(fixture.logPath, payloads.map(([type, data]) => JSON.stringify({ type: 'user',
      message: { content: [{ type: 'image', source: { type: 'base64', media_type: type, data: Buffer.from(data).toString('base64') } }] },
    }) + '\n').join(''))
    await expect.poll(async () => (await fixture.find())?.mediaSummary?.images, { timeout: 60_000 }).toBe(3)
    await page.goto('/'); await fixture.select(page)
    await page.getByTestId('media-rail-pill').click()
    const rail = page.getByTestId('media-rail')
    await expect(rail.getByTestId('media-thumb')).toHaveCount(3)
    const items = (await fixture.items()).items
    for (const [type, payload] of payloads) {
      const index = items.findIndex(item => item.mediaType === type)
      expect(index).toBeGreaterThanOrEqual(0)
      const response = await request.get(items[index].url)
      expect(response.headers()['content-type']).toBe('application/octet-stream')
      expect(response.headers()['content-disposition']).toBe('attachment')
      expect(response.headers()['content-security-policy']).toContain('sandbox')
      expect(await response.text()).toBe(payload)
      await rail.getByTestId('media-thumb').nth(index).click()
      const viewer = page.getByTestId('media-lightbox')
      const opener = viewer.getByRole('link', { name: 'Open original' })
      await expect(opener).toHaveAttribute('href', items[index].url + '&delivery=2')
      const downloadPromise = page.waitForEvent('download')
      // Keep the navigation in this page to assert it remains on the application.
      await opener.evaluate(el => el.removeAttribute('target'))
      await opener.click()
      const download = await downloadPromise
      const file = await download.path()
      expect(fs.readFileSync(file!, 'utf8')).toBe(payload)
      expect(await page.title()).not.toBe('UNSAFE-MEDIA-EXECUTED')
      await viewer.getByRole('button', { name: 'Close image viewer' }).click()
    }
    const pngIndex = items.findIndex(item => item.mediaType === 'image/png')
    await rail.getByTestId('media-thumb').nth(pngIndex).click()
    await expect(page.getByTestId('media-lightbox-original')).toHaveJSProperty('naturalWidth', 96)
    await page.screenshot({ path: test.info().outputPath('safe-original.png') })
  } finally { fixture.cleanup() }
})
