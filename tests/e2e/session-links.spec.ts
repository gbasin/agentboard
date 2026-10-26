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
      await rail.getByTestId('media-thumb').click()
      await expect(page.getByTestId('media-lightbox-original')).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(page.getByTestId('media-lightbox')).toHaveCount(0)
      await expect(rail.getByTestId('media-thumb')).toBeFocused()
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
      await rail.getByRole('button', { name: 'Media 1', exact: true }).click()
      await rail.getByTestId('media-thumb').click()
      await expect(page.getByTestId('media-lightbox-original')).toBeVisible()
      await page.getByRole('button', { name: 'Close image viewer' }).click()
      await expect(rail).toBeVisible()
      await expect(rail.getByRole('searchbox')).toHaveCount(0)
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

test('copy uses the complete long destination with confirmed feedback and HTTP fallback focus isolation', async ({ page, request, context, browserName }) => {
  const fixture = await mediaFixture(request, 0)
  const destination = `https://example.com/report?detail=${'ab'.repeat(1600)}#complete`
  fs.appendFileSync(fixture.logPath, JSON.stringify({ type: 'assistant', sessionId: fixture.sessionId,
    timestamp: new Date().toISOString(), message: { role: 'assistant', content: [{ type: 'text', text: `[Long report](${destination})` }] } }) + '\n')
  let externalRequests = 0
  page.on('request', req => { if (req.url().startsWith('https://example.com')) externalRequests++ })
  try {
    await expect.poll(async () => (await fixture.find())?.mediaSummary?.links, { timeout: 30_000 }).toBe(1)
    await page.goto('/'); await fixture.select(page)
    await page.setViewportSize({ width: 390, height: 844 })
    await page.getByTestId('media-rail-pill').click()
    const copy = page.getByRole('button', { name: 'Copy link for Long report', exact: true })
    await expect(copy).toBeVisible()
    const before = fixture.capture()
    const icon = await copy.locator('svg').innerHTML()
    await page.evaluate(() => {
      const native = document.execCommand.bind(document)
      ;(window as any).copyProbe = { succeed: true, native, value: '', selection: 0 }
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined })
      document.execCommand = command => {
        const input = document.activeElement as HTMLTextAreaElement
        Object.assign((window as any).copyProbe, { value: input.value, selection: input.selectionEnd - input.selectionStart, readonly: input.readOnly })
        return command === 'copy' && (window as any).copyProbe.succeed
      }
    })
    await copy.click()
    await expect(copy).toHaveAttribute('data-copy-state', 'copied')
    expect(await copy.locator('svg').innerHTML()).not.toBe(icon)
    expect(await page.evaluate(() => ({ value: (window as any).copyProbe.value, selection: (window as any).copyProbe.selection, readonly: (window as any).copyProbe.readonly })))
      .toEqual({ value: destination, selection: destination.length, readonly: true })
    await expect(copy).toBeFocused()
    await page.screenshot({ path: test.info().outputPath(`copy-link-success-${test.info().project.name}.png`) })
    expect(context.pages()).toHaveLength(1)
    expect(externalRequests).toBe(0)
    expect(fixture.capture()).toBe(before)
    await expect(copy).toHaveAttribute('data-copy-state', 'idle')
    expect(await copy.locator('svg').innerHTML()).toBe(icon)
    await page.evaluate(() => { (window as any).copyProbe.succeed = false })
    await copy.click()
    await expect(copy).toHaveAttribute('data-copy-state', 'failed')
    await expect(page.getByTestId('media-rail')).toContainText('Could not copy')
    await expect(copy).toBeFocused()
    expect(fixture.capture()).toBe(before)
    // Exercise native clipboard separately where Playwright supports permissions.
    // Deterministic fallback assertions above do not claim a physical OS paste.
    if (browserName === 'chromium') {
      await context.grantPermissions(['clipboard-read', 'clipboard-write'])
      await page.evaluate(() => {
        delete (navigator as any).clipboard
        document.execCommand = (window as any).copyProbe.native
      })
      await copy.click()
      await expect(copy).toHaveAttribute('data-copy-state', 'copied')
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(destination)
      await page.evaluate(() => { const input = document.createElement('textarea'); input.id = 'native-paste-probe'; document.body.append(input); input.focus() })
      const pasteKey = await page.evaluate(() => navigator.platform.toUpperCase().includes('MAC') ? 'Meta+V' : 'Control+V')
      await page.keyboard.press(pasteKey)
      await page.waitForTimeout(100)
      const pasted = await page.locator('#native-paste-probe').inputValue()
      if (pasted) expect(pasted).toBe(destination)
      else test.info().annotations.push({ type: 'clipboard', description: 'Native clipboard read verified; headless keyboard paste unavailable.' })
      await page.locator('#native-paste-probe').evaluate(el => el.remove())
      await copy.focus()
    }
    await page.screenshot({ path: test.info().outputPath(`copy-link-${test.info().project.name}.png`) })
  } finally { fixture.cleanup() }
})
