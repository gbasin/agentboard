/** Browser regression for HTTPS termination → HTTP board → separate HTTPS output. */
import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { mediaFixture, TINY_PNG } from './helpers/mediaFixture'

test.use({ serviceWorkers: 'block', viewport: { width: 1280, height: 900 } })
test.describe.configure({ timeout: 180_000 })
const reply = (text: string) => JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } }) + '\n'

for (const mobile of [false, true]) test(`HTTPS reports and live apps: ${mobile ? 'phone' : 'desktop'}`, async ({ page, playwright }, info) => {
  test.skip(!process.env.E2E_HTTPS_BACKEND_PORT, 'Dedicated HTTPS proxy configuration required')
  const request = await playwright.request.newContext({ baseURL: `http://127.0.0.1:${process.env.E2E_HTTPS_BACKEND_PORT}` })
  const fixture = await mediaFixture(request, 0)
  const root = path.join(process.env.E2E_TMUX_TMPDIR!, fixture.name)
  const report = path.join(root, 'verified.html')
  fs.writeFileSync(report, '<!doctype html><link rel="stylesheet" href="style.css"><h1>Verification gallery</h1><img src="shot.png"><button onclick="this.textContent=\'Played\'">Play</button>')
  fs.writeFileSync(path.join(root, 'style.css'), 'h1 { color: rgb(12, 100, 40) }')
  fs.writeFileSync(path.join(root, 'shot.png'), Buffer.from(TINY_PNG, 'base64'))
  const env = { ...process.env }; delete env.TMUX; delete env.TMUX_PANE
  const app = spawn('bun', ['tests/e2e/fixtures/preview-app.ts'], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  const errors: string[] = []
  page.on('console', message => { if (/mixed content/i.test(message.text())) errors.push(message.text()) })
  try {
    const port = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('App startup timed out')), 10_000)
      app.stdout.once('data', chunk => { clearTimeout(timer); resolve(Number(String(chunk).trim())) })
      app.once('error', reject)
    })
    fs.appendFileSync(fixture.logPath, reply(`[Verification gallery](${report})\n[Live app](http://127.0.0.1:${port}/)`))
    await expect.poll(async () => (await fixture.find())?.mediaSummary?.previews, { timeout: 60_000 }).toBe(2)
    await page.goto('/'); await fixture.select(page)
    await page.locator('.xterm-screen').evaluate(el => el.setAttribute('data-mount-marker', 'preserved'))
    if (mobile) await page.setViewportSize({ width: 390, height: 844 })
    await page.getByTestId('media-rail-pill').click()
    await page.getByRole('button', { name: 'Previews 2', exact: true }).click()
    await page.getByTestId('output-item').filter({ hasText: 'Verification gallery' }).click()
    const preview = page.getByTestId('output-preview'), iframe = preview.locator('iframe')
    const frame = page.frameLocator('iframe[title="Verification gallery"]')
    await expect(frame.getByRole('heading')).toHaveCSS('color', 'rgb(12, 100, 40)')
    expect(await frame.locator('img').evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(96)
    const src = new URL(await iframe.getAttribute('src') as string)
    expect(src.protocol).toBe('https:'); expect(src.origin).not.toBe(new URL(page.url()).origin)
    await frame.getByRole('button', { name: 'Play', exact: true }).click()
    await expect(frame.getByRole('button', { name: 'Played' })).toBeVisible()
    // Cross-origin DOM access and board API access remain blocked.
    const child = page.frames().find(f => f.url().includes('/verified.html'))!
    expect(await child.evaluate(() => { try { return Boolean(parent.document.body) } catch { return false } })).toBe(false)
    expect((await request.get('/api/sessions', { headers: { Origin: src.origin } })).status()).toBe(403)
    const withoutCookie = await playwright.request.newContext({ ignoreHTTPSErrors: true })
    // Resolve locally for Node's API client; Chromium's resolver mapping is browser-only.
    const naked = new URL('/', src); naked.hostname = '127.0.0.1'
    expect((await withoutCookie.get(naked.href)).status()).toBe(403)
    await withoutCookie.dispose()
    await preview.getByRole('button', { name: 'Reload', exact: true }).click()
    await expect(frame.getByRole('button', { name: 'Play', exact: true })).toBeVisible()
    const popupPromise = page.waitForEvent('popup')
    await preview.getByRole('link', { name: 'Open output in new tab' }).click()
    const popup = await popupPromise
    await expect(popup.getByRole('heading', { name: 'Verification gallery' })).toBeVisible(); await popup.close()
    await preview.getByRole('button', { name: 'Previews', exact: true }).click()
    await page.getByTestId('output-item').filter({ hasText: 'Live app' }).click()
    const live = page.frameLocator('iframe[title="Live app"]')
    await expect(live.getByRole('heading')).toHaveCSS('color', 'rgb(12, 100, 40)')
    await live.getByRole('button', { name: 'Save setting' }).click()
    await expect(live.locator('#api')).toHaveText('Saved remotely')
    await expect(live.locator('#socket')).toHaveText('WebSocket connected')
    await expect(preview.getByRole('status')).toBeHidden()
    expect(errors).toEqual([])
    const shot = info.outputPath('https-preview.png')
    await page.screenshot({ path: shot }); await info.attach('HTTPS preview with working POST and WSS', { path: shot, contentType: 'image/png' })
    await preview.getByRole('button', { name: mobile ? '← Terminal' : 'Close preview', exact: true }).click()
    await expect(page.locator('.xterm-screen')).toHaveAttribute('data-mount-marker', 'preserved')
    if (process.env.E2E_PREVIEW_AUTO_TLS === '1') expect(fs.readFileSync(path.join(process.env.E2E_TMUX_TMPDIR!, 'cert-exports'), 'utf8').trim().split('\n')).toHaveLength(1)
  } finally { app.kill(); fixture.cleanup(); await request.dispose() }
})

test('unsupported HTTPS hostname shows setup error without an insecure iframe', async ({ page, playwright }) => {
  test.skip(process.env.E2E_PREVIEW_AUTO_TLS !== '1', 'Automatic certificate mode only')
  const request = await playwright.request.newContext({ baseURL: `http://127.0.0.1:${process.env.E2E_HTTPS_BACKEND_PORT}` })
  const fixture = await mediaFixture(request, 0)
  const report = path.join(process.env.E2E_TMUX_TMPDIR!, fixture.name, 'report.html')
  fs.writeFileSync(report, '<h1>Report</h1>')
  fs.appendFileSync(fixture.logPath, reply(`[Report](${report})`))
  try {
    await expect.poll(async () => (await fixture.find())?.mediaSummary?.previews, { timeout: 60_000 }).toBe(1)
    await page.goto(`https://localhost:${process.env.E2E_HTTPS_PORT}`); await fixture.select(page)
    await page.getByTestId('media-rail-pill').click()
    await page.getByRole('button', { name: 'Previews 1', exact: true }).click()
    await page.getByTestId('output-item').click()
    await expect(page.getByTestId('output-preview').getByRole('alert')).toContainText('HTTPS previews need a certificate')
    await expect(page.getByTestId('output-preview').locator('iframe')).toHaveCount(0)
  } finally { fixture.cleanup(); await request.dispose() }
})
