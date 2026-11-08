/** Assistant web links open on demand in the existing output viewer. */
import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import { mediaFixture } from './helpers/mediaFixture'

test.use({ serviceWorkers: 'block' })
for (const mobile of [false, true]) {
  test(`web link previews: ${mobile ? 'mobile' : 'desktop'}`, async ({ page, request }, info) => {
    const fixture = await mediaFixture(request, 0)
    const url = 'https://sj-preview.example/proposals/'
    const blocked = 'https://sj-preview.example/blocked'
    fs.appendFileSync(fixture.logPath, JSON.stringify({ type: 'response_item', payload: {
      type: 'message', role: 'assistant', content: [{ type: 'output_text', text: `[Review hub: Today / Refine / Bold](${url})\n[Blocked site](${blocked})` }],
    } }) + '\n')
    let requests = 0
    await page.route('https://sj-preview.example/**', async route => {
      requests++
      if (route.request().url() === blocked) return route.fulfill({ headers: { 'Content-Security-Policy': "frame-ancestors 'none'" }, contentType: 'text/html', body: '<h1>Cannot embed</h1>' })
      await route.fulfill({ contentType: 'text/html', body: '<h1>SJ mockups</h1><button onclick="localStorage.setItem(\'theme\',\'dark\');this.textContent=\'Dark selected\'">Dark mode</button>' })
    })
    try {
      await expect.poll(async () => (await fixture.find())?.mediaSummary?.links, { timeout: 60000 }).toBe(2)
      await page.setViewportSize({ width: 1280, height: 900 })
      await page.goto('/'); await fixture.select(page)
      if (mobile) await page.setViewportSize({ width: 390, height: 844 })
      const terminal = page.locator('.xterm-screen')
      await terminal.evaluate(el => el.setAttribute('data-mount-marker', 'preserved'))
      await page.getByTestId('media-rail-pill').click()
      await expect(page.getByRole('button', { name: 'Preview Review hub: Today / Refine / Bold', exact: true })).toBeVisible()
      expect(requests).toBe(0)
      await page.getByRole('button', { name: 'Preview Review hub: Today / Refine / Bold', exact: true }).click()
      const preview = page.getByTestId('output-preview')
      const frame = page.frameLocator('iframe')
      await frame.getByRole('button', { name: 'Dark mode' }).click()
      await expect(frame.getByRole('button', { name: 'Dark selected' })).toBeVisible()
      await expect(preview.getByRole('link', { name: 'Open output in new tab' })).toHaveAttribute('href', url)
      await page.screenshot({ path: info.outputPath(`${mobile ? 'mobile' : 'desktop'}-link-preview.png`) })
      if (mobile) await expect(page.locator('.xterm-helper-textarea')).toBeDisabled()
      await preview.getByRole('button', { name: mobile ? '← Terminal' : 'Close preview', exact: true }).click()
      await expect(preview).toBeHidden()
      await expect(terminal).toHaveAttribute('data-mount-marker', 'preserved')
      if (mobile) await expect(page.locator('.xterm-helper-textarea')).toBeEnabled()
      await page.getByTestId('media-rail-pill').click()
      await page.getByRole('button', { name: 'Preview Blocked site', exact: true }).click()
      await expect(preview.getByRole('link', { name: 'Open output in new tab' })).toHaveAttribute('href', blocked)
      await expect(preview.getByText('If this page stays blank or refuses to connect, use Open original.')).toBeVisible()
      await preview.getByRole('button', { name: 'Links', exact: true }).click()
      await expect(page.getByTestId('media-rail').getByRole('button', { name: 'Links 2', exact: true })).toHaveAttribute('aria-pressed', 'true')
    } finally { fixture.cleanup() }
  })
}
