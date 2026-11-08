/** Responsive labels exercised through real transcript discovery and the shared rail. */
import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { mediaFixture } from './helpers/mediaFixture'

test.use({ actionTimeout: 10_000, navigationTimeout: 15_000, serviceWorkers: 'block', hasTouch: true, viewport: { width: 1280, height: 900 } })
test.setTimeout(180_000)

test('media pill labels, grouped counts, and keyboard access across viewport sizes', async ({ page, request }, info) => {
  const fixture = await mediaFixture(request, 121, true)
  try {
    for (let i = 0; i < 5; i++) {
      const report = path.join(process.env.E2E_TMUX_TMPDIR!, fixture.name, `report-${i}.html`)
      fs.writeFileSync(report, `<!doctype html><h1>Report ${i}</h1>`)
      fs.appendFileSync(fixture.logPath, JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(),
        message: { role: 'assistant', content: [{ type: 'text', text: `[Report ${i}](${report})` }] } }) + '\n')
    }
    await expect.poll(async () => (await fixture.find())?.mediaSummary?.previews, { timeout: 60_000 }).toBe(5)
    let itemRequests = 0
    page.on('request', r => { if (r.url().includes(`/session-media/${fixture.sessionId}/items`)) itemRequests++ })
    await page.addInitScript(() => localStorage.setItem('agentboard-theme', JSON.stringify({ state: { theme: 'light' }, version: 0 })))
    const pill = page.getByTestId('media-rail-pill')
    for (const width of [1280, 768, 767, 390, 320]) {
      await page.setViewportSize({ width, height: 900 })
      await page.goto('/', { waitUntil: 'domcontentloaded' })
      if (width === 1280) await fixture.select(page)
      // Later loads restore the selected session. A closed drawer remains in
      // the DOM offscreen, so use its open state rather than isVisible().
      if (await page.locator('.session-drawer.open').count()) await page.keyboard.press('Escape')
      await expect(pill).toBeVisible()
      await expect(pill).toHaveAccessibleName('Open media, links and previews: 127 items')
      for (const label of ['Media', 'Links', 'Previews']) {
        if (width >= 768) await expect(pill.getByText(label, { exact: true })).toBeVisible()
        else await expect(pill.getByText(label, { exact: true })).toBeHidden()
      }
      const groups = pill.locator(':scope > span').filter({ has: page.locator('svg') })
      await expect(groups).toHaveCount(3)
      for (const [index, count] of ['1', '121', '5'].entries()) {
        await expect(groups.nth(index).getByText(count, { exact: true })).toBeVisible()
      }
      const box = (await pill.boundingBox())!
      expect(box.x).toBeGreaterThanOrEqual(0)
      expect(box.x + box.width).toBeLessThanOrEqual(width)
      const gap = await pill.evaluate(el => Number.parseFloat(getComputedStyle(el).columnGap))
      const innerGap = await groups.first().evaluate(el => Number.parseFloat(getComputedStyle(el).columnGap))
      expect(gap).toBeGreaterThan(innerGap)
      const touchHeight = await pill.evaluate(el => Number.parseFloat(getComputedStyle(el, '::before').height))
      expect(touchHeight).toBeGreaterThanOrEqual(44)
      await expect(page.getByTestId('terminal-recovery-status')).toBeHidden({ timeout: 15_000 })
      const screenshot = info.outputPath(`media-pill-${width}.png`)
      await page.screenshot({ path: screenshot })
      await info.attach(`Media pill at ${width}px`, { path: screenshot, contentType: 'image/png' })
    }
    expect(itemRequests).toBe(0)
    await pill.focus(); await page.keyboard.press('Enter')
    const rail = page.getByTestId('media-rail')
    await expect(rail.getByRole('button', { name: 'Media 1', exact: true })).toBeVisible()
    await rail.getByRole('button', { name: 'Links 121', exact: true }).click()
    await expect(rail.getByRole('link')).toHaveCount(40)
    await rail.getByRole('button', { name: 'Previews 5', exact: true }).click()
    await expect(rail.getByTestId('output-item')).toHaveCount(5)
    await page.keyboard.press('Escape')
    await expect(pill).toBeFocused()
  } finally { fixture.cleanup() }
})
