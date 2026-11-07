import { test, expect, type Page } from '@playwright/test'

const url = 'https://example.com/pull/513#issuecomment-6707937062'
const text = `Opened PR (${url}).\nCopy before https://example.com/after then finish.\nUnsafe javascript:alert(1) and file:///tmp/test\nTruncated https://example.com/abc…\n\n${'More selectable text. '.repeat(12)}`

async function openSnapshot(page: Page, capture = text, altScreen = false) {
  await page.routeWebSocket(/\/ws(?:\?.*)?$/, ws => {
    const server = ws.connectToServer()
    ws.onMessage(message => {
      const request = JSON.parse(String(message))
      if (request.type === 'terminal-snapshot-request') {
        ws.send(JSON.stringify({ type: 'terminal-snapshot', sessionId: request.sessionId,
          requestId: request.requestId, ok: true, text: capture, altScreen, scrollPosition: 0 }))
      } else server.send(message)
    })
    server.onMessage(message => ws.send(message))
  })
  await page.goto('/')
  await page.getByTestId('session-card').first().evaluate(el => (el as HTMLElement).click())
  await expect(page.locator('.xterm')).toBeVisible()
  await page.getByRole('button', { name: 'Select text', exact: true }).click()
  await expect(page.getByTestId('terminal-snapshot-text')).toBeVisible()
}

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })

test('wrapped URLs open on tap, and selection gestures never navigate', async ({ page, context }, testInfo) => {
  await openSnapshot(page)
  const root = page.getByTestId('terminal-snapshot-text')
  const link = root.locator('a').first()
  await expect(root.locator('a')).toHaveCount(2)
  await expect(link).toHaveAttribute('href', url)
  await expect(link).toHaveAttribute('rel', 'noopener noreferrer')
  expect(await link.evaluate(el => el.getClientRects().length)).toBeGreaterThan(1)
  await context.route('https://example.com/**', route => route.fulfill({ body: 'Link destination' }))
  const popup = page.waitForEvent('popup')
  await link.tap()
  const opened = await popup
  await opened.waitForLoadState()
  expect(opened.url()).toBe(url)
  await opened.close()
  await expect(root).toBeVisible()

  // A real DOM selection exists before pointerdown; a tap may collapse it.
  await link.evaluate(el => {
    const range = document.createRange()
    range.selectNodeContents(el)
    window.getSelection()!.removeAllRanges()
    window.getSelection()!.addRange(range)
  })
  await link.tap()
  await page.waitForTimeout(200)
  expect(context.pages()).toHaveLength(1)
  await page.evaluate(() => window.getSelection()!.removeAllRanges())
  await link.click({ delay: 650 })
  expect(context.pages()).toHaveLength(1)
  await page.evaluate(() => window.getSelection()!.removeAllRanges())

  const box = (await link.boundingBox())!
  await page.mouse.move(box.x + 3, box.y + 5)
  await page.mouse.down()
  await page.mouse.move(box.x + 80, box.y + 5, { steps: 8 })
  await page.mouse.up()
  expect(context.pages()).toHaveLength(1)
  await page.evaluate(() => window.getSelection()!.removeAllRanges())
  await page.screenshot({ path: testInfo.outputPath(`select-links-${testInfo.project.name}.png`) })
  await page.getByRole('button', { name: 'Done selecting text', exact: true }).click()
  await expect(root).toHaveCount(0)
})

test('copies partial links and surrounding text with correct offsets', async ({ page }) => {
  await openSnapshot(page)
  const copied = await page.getByTestId('terminal-snapshot-text').evaluate(root => {
    const row = root.children[1]
    const anchor = row.querySelector('a')!
    const range = document.createRange()
    range.setStart(anchor.firstChild!, 8)
    range.setEnd(row.lastChild!, 5)
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    const clipboard = new DataTransfer()
    document.dispatchEvent(new ClipboardEvent('copy', { clipboardData: clipboard, bubbles: true, cancelable: true }))
    return clipboard.getData('text/plain')
  })
  expect(copied).toBe('example.com/after then')
  await expect(page.getByTestId('terminal-snapshot-layer')).toHaveCount(0)
})

test('TUI-wrapped URL fragments share a destination and copy as one URL', async ({ page, context }) => {
  const first = 'https://example.com/abcdefghijklmno/'
  const second = 'pqrstuvwxyz0123456789#comment'
  await openSnapshot(page, `${first}\n  ${second}`, true)
  const root = page.getByTestId('terminal-snapshot-text')
  const links = root.locator('a')
  await expect(links).toHaveCount(2)
  for (const link of await links.all()) await expect(link).toHaveAttribute('href', first + second)
  await context.route('https://example.com/**', route => route.fulfill({ body: 'Wrapped destination' }))
  const popup = page.waitForEvent('popup')
  await links.last().tap()
  const opened = await popup
  await opened.waitForLoadState()
  expect(opened.url()).toBe(first + second)
  await opened.close()
  const copied = await root.evaluate(el => {
    const range = document.createRange()
    range.selectNodeContents(el)
    window.getSelection()!.removeAllRanges()
    window.getSelection()!.addRange(range)
    const clipboard = new DataTransfer()
    document.dispatchEvent(new ClipboardEvent('copy', { clipboardData: clipboard, bubbles: true, cancelable: true }))
    return clipboard.getData('text/plain')
  })
  expect(copied).toBe(first + second)
})
