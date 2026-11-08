/** Real transcript → paged shared panel → isolated desktop/mobile previews. */
import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { mediaFixture } from './helpers/mediaFixture'

test.use({ serviceWorkers: 'block', viewport: { width: 1280, height: 900 } })
test.describe.configure({ timeout: 180_000 })
const reply = (text: string) => JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(), message: { role: 'assistant', content: [{ type: 'text', text }] } }) + '\n'

for (const mobile of [false, true]) {
  test(`shared media links previews panel: ${mobile ? 'mobile' : 'desktop'}`, async ({ page, request }, info) => {
    const fixture = await mediaFixture(request, 1, true)
    const root = path.join(process.env.E2E_TMUX_TMPDIR!, fixture.name)
    const report = path.join(root, 'report.html')
    fs.writeFileSync(report, '<!doctype html><link rel="stylesheet" href="style.css"><h1>Remote report</h1><button id="count">Count 0</button><script src="report.js"></script>')
    fs.writeFileSync(path.join(root, 'style.css'), 'h1{color:rgb(12,100,40)}')
    fs.writeFileSync(path.join(root, 'report.js'), "let n=0;document.querySelector('#count').onclick=()=>document.querySelector('#count').textContent='Count '+(++n)")
    fs.appendFileSync(fixture.logPath, reply(`[Remote report](${report})`))
    try {
      await expect.poll(async () => (await fixture.find())?.mediaSummary?.previews, { timeout: 60000 }).toBe(1)
      await page.goto('/'); await fixture.select(page)
      if (mobile) await page.setViewportSize({ width: 390, height: 844 })
      const terminal = page.locator('.xterm-screen')
      await terminal.evaluate(el => el.setAttribute('data-mount-marker', 'preserved'))
      const original = await terminal.boundingBox()
      await expect(page.getByTestId('outputs-strip')).toHaveCount(0)
      await page.getByTestId('media-rail-pill').click()
      const panel = page.getByTestId('media-rail')
      await expect(panel.getByRole('button', { name: 'Media 1', exact: true })).toBeVisible()
      await expect(panel.getByRole('button', { name: 'Links 1', exact: true })).toBeVisible()
      await panel.getByRole('button', { name: 'Previews 1', exact: true }).click()
      await expect(panel.getByTestId('output-item')).toHaveCount(1)
      await expect(panel.getByTestId('media-thumb')).toHaveCount(0)
      await page.screenshot({ path: info.outputPath(`${mobile ? 'mobile' : 'desktop'}-panel.png`) })
      await panel.getByRole('button', { name: /Remote report/ }).click()
      const preview = page.getByTestId('output-preview')
      const frame = page.frameLocator('iframe[title="Remote report"]')
      await expect(frame.getByRole('heading')).toHaveCSS('color', 'rgb(12, 100, 40)')
      await frame.getByRole('button', { name: 'Count 0' }).click()
      await expect(frame.getByRole('button', { name: 'Count 1' })).toBeVisible()
      if (mobile) {
        expect((await preview.boundingBox())!.width).toBe(390)
        await expect(page.locator('.xterm-helper-textarea')).toBeDisabled()
      } else {
        // xterm fits after the ResizeObserver debounce, independently of iframe load.
        await expect.poll(async () => (await terminal.boundingBox())!.width).toBeLessThan(original!.width)
        const separator = page.getByRole('separator', { name: 'Resize output preview' })
        await separator.focus(); await page.keyboard.press('ArrowLeft')
        await expect(separator).toHaveAttribute('aria-valuenow', '50')
      }
      await page.screenshot({ path: info.outputPath(`${mobile ? 'mobile' : 'desktop'}-preview.png`) })
      // Local capture coverage is optional because packaged hosts need not have Chrome.
      if (mobile && fs.existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')) {
        const output = (await fixture.items()).items.find(item => item.kind === 'html')!
        await expect.poll(async () => (await request.get(output.url + '&format=thumbnail')).status(), { timeout: 20000 }).toBe(200)
      }
      await preview.getByRole('button', { name: 'Previews', exact: true }).click()
      await expect(panel.getByRole('button', { name: 'Previews 1', exact: true })).toHaveAttribute('aria-pressed', 'true')
      await expect(panel.getByRole('button', { name: /Remote report/ })).toBeInViewport()
      if (mobile && fs.existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')) {
        await expect(panel.getByRole('img', { name: 'Saved preview' })).toBeVisible()
        await page.screenshot({ path: info.outputPath('mobile-saved-preview.png') })
      }
      await panel.getByRole('button', { name: /Remote report/ }).click()
      await expect(frame.getByRole('button', { name: 'Count 1' })).toBeVisible()
      const popupPromise = page.waitForEvent('popup')
      await preview.getByRole('link', { name: 'Open output in new tab' }).click()
      const popup = await popupPromise
      await expect(popup.getByRole('heading', { name: 'Remote report' })).toBeVisible(); await popup.close()
      await preview.getByRole('button', { name: mobile ? '← Terminal' : 'Close preview', exact: true }).click()
      await expect(preview).toBeHidden()
      if (mobile) await expect(page.locator('.xterm-helper-textarea')).toBeEnabled()
      await expect(terminal).toHaveAttribute('data-mount-marker', 'preserved')
      await page.getByTestId('media-rail-pill').click()
      await panel.getByRole('button', { name: 'Links 1', exact: true }).click()
      await expect(panel.getByRole('link')).toHaveCount(1)
      await panel.getByRole('button', { name: 'Media 1', exact: true }).click()
      await panel.getByTestId('media-thumb').click()
      await expect(page.getByTestId('media-lightbox-original')).toBeVisible()
      await page.getByRole('button', { name: 'Close image viewer' }).click()
      await expect(panel).toBeVisible()
      if (mobile) {
        await page.setViewportSize({ width: 320, height: 700 })
        await panel.getByRole('button', { name: 'Links 1', exact: true }).click()
        await expect(panel.getByRole('button', { name: 'Search links' })).toBeInViewport()
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      }
      const items = (await fixture.items()).items
      const output = items.find(i => i.kind === 'html')!
      const target = await request.get(output.url + '&format=json')
      expect(target.status()).toBe(200)
      const origin = new URL((await target.json()).url).origin
      expect((await request.get('/api/sessions', { headers: { Origin: origin } })).status()).toBe(403)
      const forged = new URL(output.url, 'http://board'); forged.searchParams.set('path', '/etc/passwd')
      expect((await request.get(forged.pathname + forged.search)).status()).toBe(400)
      fs.unlinkSync(report)
      expect((await request.get(output.url + '&format=json')).status()).toBe(404)
      fs.writeFileSync(fixture.logPath, reply('removed'))
      expect([404,409]).toContain((await request.get(output.url + '&format=json')).status())
    } finally { fixture.cleanup() }
  })
}

test('live app preview proxies assets, API calls and WebSockets', async ({ page, request }, info) => {
  const fixture = await mediaFixture(request, 0)
  const app = spawn('bun', ['tests/e2e/fixtures/preview-app.ts'], { env: { ...process.env, TMUX: undefined }, stdio: ['ignore', 'pipe', 'pipe'] })
  try {
    const port = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('App startup timed out')), 10000)
      app.stdout.once('data', chunk => { clearTimeout(timer); resolve(Number(String(chunk).trim())) })
      app.once('error', reject)
    })
    fs.appendFileSync(fixture.logPath, reply(`[Live app](http://127.0.0.1:${port}/)`))
    await expect.poll(async () => (await fixture.find())?.mediaSummary?.previews, { timeout: 60000 }).toBe(1)
    await page.goto('/'); await fixture.select(page)
    await page.getByTestId('media-rail-pill').click()
    await page.getByRole('button', { name: 'Previews 1', exact: true }).click()
    await page.getByTestId('output-item').click()
    const frame = page.frameLocator('iframe[title="Live app"]')
    await expect(frame.getByRole('heading')).toHaveCSS('color', 'rgb(12, 100, 40)')
    if (process.env.E2E_PREVIEW_BIND_CONFLICT) {
      const logs = fs.readFileSync(process.env.LOG_FILE!, 'utf8')
      expect(logs).toContain('tailscale_bind_failed')
      const src = new URL(await page.locator('iframe[title="Live app"]').getAttribute('src') as string)
      expect(src.hostname).toBe('[::1]')
      expect(src.port).not.toBe(new URL(page.url()).port)
      // No capability: the preview remains protected on its separate origin.
      expect((await request.get(new URL('/', src).href)).status()).toBe(403)
    }
    await frame.getByRole('button', { name: 'Save setting' }).click()
    await expect(frame.locator('#api')).toHaveText('Saved remotely')
    await expect(frame.locator('#socket')).toHaveText('WebSocket connected')
    await expect(page.getByTestId('output-preview').getByRole('status')).toBeHidden()
    const screenshot = info.outputPath('live-preview-connected.png')
    await page.screenshot({ path: screenshot })
    await info.attach('Live preview: assets, POST and WebSocket connected', { path: screenshot, contentType: 'image/png' })
  } finally { app.kill(); fixture.cleanup() }
})

test('Codex visualization markers appear in Previews and use the standalone runtime', async ({ page, request }) => {
  const fixture = await mediaFixture(request, 0)
  const root = path.join(process.env.E2E_TMUX_TMPDIR!, fixture.name)
  const source = path.join(root, 'visualization.html')
  const fragment = '<button>Inspect sidebar</button>'
  fs.writeFileSync(source, fragment)
  fs.writeFileSync(path.join(root, 'standalone.html'), '<!doctype html><html data-visualize-standalone><template>&lt;button&gt;Inspect sidebar&lt;/button&gt;</template><button onclick="this.textContent=\'Sidebar opened\'">Inspect sidebar</button></html>')
  fs.appendFileSync(fixture.logPath, JSON.stringify({ type: 'response_item', timestamp: new Date().toISOString(), payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: `visualize${JSON.stringify({ path: source, title: 'Sidebar mockup' })}` }] } }) + '\n')
  try {
    await expect.poll(async () => (await fixture.find())?.mediaSummary?.previews, { timeout: 60000 }).toBe(1)
    await page.goto('/'); await fixture.select(page)
    await page.getByTestId('media-rail-pill').click()
    await page.getByRole('button', { name: 'Previews 1', exact: true }).click()
    await page.getByRole('button', { name: /Sidebar mockup/ }).click()
    const frame = page.frameLocator('iframe[title="Sidebar mockup"]')
    await frame.getByRole('button', { name: 'Inspect sidebar' }).click()
    await expect(frame.getByRole('button', { name: 'Sidebar opened' })).toBeVisible()
  } finally { fixture.cleanup() }
})
