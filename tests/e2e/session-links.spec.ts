/** Real transcript → worker index → filtered HTTP pages → compact session UI. */
import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import { mediaFixture } from './helpers/mediaFixture'

test.use({ serviceWorkers: 'block', viewport: { width: 1280, height: 900 } })
test.describe.configure({ timeout: 180_000 })

for (const mobile of [false, true]) {
  test(`reply links in context: ${mobile ? 'mobile' : 'desktop'}`, async ({ page, request }) => {
    const fixture = await mediaFixture(request, 0, true)
    const destination = `https://example.com/${fixture.sessionId}/report?rev=2#result`
    const reply = (text: string) => JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } }) + '\n'
    let externalRequests = 0, pageRequests = 0
    page.on('request', r => {
      if (r.url().startsWith('https://example.com')) externalRequests++
      if (r.url().includes(`/session-media/${fixture.sessionId}/items`)) pageRequests++
    })
    try {
      const text = `Finished [Review report](${destination}). <img src=x onerror=alert(1)>`
      fs.appendFileSync(fixture.logPath,
        reply(text) + reply(text) +
        JSON.stringify({ type: 'user', message: { role: 'user', content: 'https://example.com/user-only' } }) + '\n' +
        JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'https://example.com/tool-only' }] } }) + '\n' +
        reply('[Local](file:///tmp/report.html) sandbox:/mnt/data/report.html') +
        Array.from({ length: 84 }, (_, i) => reply(`[Report ${i}](https://example.com/${fixture.sessionId}/item-${i})`)).join(''))
      await expect.poll(async () => (await fixture.find())?.mediaSummary?.links, { timeout: 60_000 }).toBe(85)
      await page.goto('/'); await fixture.select(page)
      if (mobile) await page.setViewportSize({ width: 390, height: 844 })
      expect(pageRequests).toBe(0)
      await page.getByTestId('media-rail-pill').click()
      const rail = page.getByTestId('media-rail')
      await expect(rail.getByTestId('media-thumb')).toBeVisible()
      await rail.getByRole('button', { name: 'Links 85', exact: true }).click()
      await expect(rail.getByRole('link')).toHaveCount(40)
      await expect(rail.getByRole('button', { name: 'Links 85', exact: true }).locator('svg')).toHaveCount(1)
      await expect(rail.getByRole('button', { name: 'Media 1', exact: true }).locator('svg')).toHaveCount(1)
      await expect(rail.getByRole('link').first()).toHaveAccessibleName('Report 83')
      const capture = fixture.capture()
      await rail.getByRole('button', { name: 'Search links', exact: true }).click()
      await page.getByRole('searchbox', { name: 'Find link' }).fill('Review report')
      await expect(rail.getByRole('link')).toHaveCount(1)
      await rail.getByRole('button', { name: 'Source for Review report', exact: true }).click()
      await expect(page.getByTestId('link-source')).toContainText('<img src=x onerror=alert(1)>')
      await expect(rail.locator('img')).toHaveCount(0)
      const sourceUrl = await rail.getByRole('link', { name: 'Review report', exact: true }).getAttribute('href')
      const redirect = await request.get(sourceUrl!, { maxRedirects: 0 })
      expect(redirect.status()).toBe(302)
      expect(redirect.headers().location).toBe(destination)
      expect(externalRequests).toBe(0)
      await page.getByRole('searchbox', { name: 'Find link' }).fill('Report 0')
      await expect(rail.getByRole('link')).toHaveCount(1)
      await expect(rail.getByRole('link')).toHaveAccessibleName('Report 0')
      expect(fixture.capture()).toBe(capture) // search never types into the terminal
      await page.getByRole('searchbox').fill('no-such-link')
      await expect(rail).toContainText('No matching links.')
      await page.getByRole('searchbox').fill('')
      await expect(rail.getByRole('link')).toHaveCount(40)
      await rail.getByRole('button', { name: 'Search links', exact: true }).click()
      const bounds = (await rail.boundingBox())!
      expect(bounds.width).toBeLessThanOrEqual(mobile ? 374 : 400)
      expect(bounds.height).toBeLessThanOrEqual(mobile ? 280 : 320)
      expect(bounds.y + bounds.height).toBeLessThan(mobile ? 700 : 800)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      await page.screenshot({ path: test.info().outputPath(`session-links-${mobile ? 'mobile' : 'desktop'}-${test.info().project.name}.png`) })
      await page.keyboard.press('Escape')
      await expect(rail).toHaveCount(0)
      await expect(page.getByTestId('media-rail-pill')).toBeFocused()
    } finally { fixture.cleanup() }
  })
}

test('search responses cannot overwrite a newer query, and switching tabs aborts link work', async ({ page, request }) => {
  const fixture = await mediaFixture(request, 80, true)
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let intercepted = false
  await page.route(`**/api/session-media/${fixture.sessionId}/items*`, async route => {
    const url = new URL(route.request().url())
    if (url.searchParams.get('search') !== '00001') return route.continue()
    intercepted = true
    const response = await route.fetch()
    await gate
    await route.fulfill({ response }).catch(() => {})
  })
  try {
    await page.goto('/'); await fixture.select(page)
    await page.getByTestId('media-rail-pill').click()
    const rail = page.getByTestId('media-rail')
    await rail.getByRole('button', { name: 'Links 80', exact: true }).click()
    await rail.getByRole('button', { name: 'Search links', exact: true }).click()
    const search = page.getByRole('searchbox')
    await search.fill('00001')
    await expect.poll(() => intercepted).toBe(true)
    await search.fill('00079')
    await expect(rail.getByRole('link')).toHaveCount(1)
    await expect(rail.getByRole('link')).toHaveAccessibleName(/^Item 00079 /)
    release()
    await expect(rail.getByRole('link')).toHaveAccessibleName(/^Item 00079 /)
    await rail.getByRole('button', { name: 'Media 1', exact: true }).click()
    await expect(rail.getByTestId('media-thumb')).toBeVisible()
    await expect(rail.getByRole('link')).toHaveCount(0)
  } finally { release(); fixture.cleanup() }
})

test('bounded link page navigation reaches the end and can return through evicted pages', async ({ page, request }) => {
  const fixture = await mediaFixture(request, 170)
  try {
    await page.goto('/'); await fixture.select(page)
    await page.getByTestId('media-rail-pill').click()
    const rail = page.getByTestId('media-rail')
    for (const first of [129, 89, 49, 9]) {
      await rail.getByRole('button', { name: 'Older links', exact: true }).click()
      await expect(rail.getByRole('link').first()).toHaveAccessibleName(new RegExp(`^Item ${String(first).padStart(5, '0')} `))
      expect(await rail.getByRole('link').count()).toBeLessThanOrEqual(40)
    }
    await expect(rail.getByRole('link')).toHaveCount(10)
    for (const first of [49, 89, 129, 169]) {
      await rail.getByRole('button', { name: 'Newer links', exact: true }).click()
      await expect(rail.getByRole('link').first()).toHaveAccessibleName(new RegExp(`^Item ${String(first).padStart(5, '0')} `))
    }
    await expect(rail.getByRole('button', { name: 'Newer links', exact: true })).toHaveCount(0)
  } finally { fixture.cleanup() }
})
