import { observeTerminalReadiness } from './helpers/terminalReadiness'
// E2E: software-keyboard Shift modifies quick keys sent to the attached pane.
// Shift is tracked from keyboard events because iOS touch events omit it.
//
// Runs in a touch-enabled iPhone viewport so the key deck (hidden on desktop
// unless the UA is iOS) is rendered and driven through real tap events. The
// pane runs the paste-repl fixture, which echoes submitted input as hex.
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { test, expect, devices } from '@playwright/test'

test.use({
  userAgent:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
})

const WINDOW_NAME = 'shift-tab-repl'
const REPL_PATH = fileURLToPath(new URL('./fixtures/paste-repl.py', import.meta.url))

function tmux(args: string[]): { status: number | null; stdout: string } {
  const result = spawnSync('tmux', args, { encoding: 'utf-8' })
  return { status: result.status, stdout: result.stdout ?? '' }
}

async function waitForPaneText(target: string, needle: string, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs
  let content = ''
  while (Date.now() < deadline) {
    content = tmux(['capture-pane', '-t', target, '-p']).stdout
    if (content.includes(needle)) return content
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(
    `Timed out waiting for ${JSON.stringify(needle)} in pane ${target}. Last content:\n${content}`
  )
}

for (const compact of [false, true]) {
test(`touch quick keys send correct bytes (${compact ? 'compact' : 'comfortable'})`, async ({ page }, testInfo) => {
  const session = process.env.E2E_TMUX_SESSION
  test.skip(!session, 'E2E_TMUX_SESSION not set')
  const target = `${session}:${WINDOW_NAME}`
  const ready = observeTerminalReadiness(page)

  const created = tmux(['new-window', '-t', session!, '-n', WINDOW_NAME, `python3 ${REPL_PATH} --submit-cr-only`])
  expect(created.status).toBe(0)

  try {
    await waitForPaneText(target, 'PASTE-REPL READY')

    await page.addInitScript((compact) => {
      localStorage.setItem('agentboard-settings', JSON.stringify({ version: 8, state: { compactMobileControls: compact } }))
    }, compact)
    await page.goto('/')
    // On mobile the session list lives in a drawer: the card is in the DOM
    // but not visible, so select it with a DOM click.
    const card = page.getByTestId('session-card').filter({ hasText: WINDOW_NAME }).first()
    await card.waitFor({ state: 'attached', timeout: 20000 })
    await card.evaluate((el) => (el as HTMLElement).click())
    await expect(page.locator('.xterm')).toBeVisible()
    await ready((await card.getAttribute('data-session-id'))!, 'PASTE-REPL READY')

    const tab = page.getByRole('button', { name: 'tab', exact: true })
    await expect(tab).toBeVisible()
    await expect(page.getByRole('button', { name: 'Shift+Tab' })).toHaveCount(0)
    const box = await tab.boundingBox()
    expect(box?.width).toBe(compact ? 36 : 44)
    expect(box?.height).toBe(compact ? 36 : 44)
    await page.screenshot({ path: testInfo.outputPath('mobile-key-deck.png') })

    const input = page.locator('.xterm-helper-textarea')
    // Tap the terminal to open input. Dismissal belongs to the native keyboard.
    await input.evaluate((el) => (el as HTMLElement).blur())
    await page.locator('.xterm').tap({ position: { x: 120, y: 100 } })
    await expect(input).toBeFocused()
    for (const [label, hex] of [['tab', '1b5b5a'], ['Enter', '0a']]) {
      await page.keyboard.down('Shift')
      await page.getByRole('button', { name: label, exact: true }).tap()
      await page.keyboard.up('Shift')
      await page.getByRole('button', { name: 'Enter', exact: true }).tap()
      await waitForPaneText(target, `INPUT_HEX:${hex}`)
    }

    await page.keyboard.down('Shift')
    await page.getByRole('button', { name: 'Arrow keys', exact: true }).tap()
    await page.getByRole('button', { name: 'Arrow up', exact: true }).tap()
    await expect(input).toBeFocused()
    await page.keyboard.up('Shift')
    await page.getByRole('button', { name: 'Arrow keys', exact: true }).tap()
    await page.getByRole('button', { name: 'Enter', exact: true }).tap()
    await waitForPaneText(target, 'INPUT_HEX:1b5b313b3241')

    // Touch Shift is one-shot, appears immediately after Tab, and preserves focus.
    const shift = page.getByRole('button', { name: 'Shift', exact: true })
    await expect(tab.locator('xpath=following-sibling::button[1]')).toHaveAttribute('aria-label', 'Shift')
    await shift.tap()
    await expect(shift).toHaveAttribute('aria-pressed', 'true')
    await page.screenshot({ path: testInfo.outputPath('mobile-shift-active.png') })
    await shift.tap()
    await expect(shift).toHaveAttribute('aria-pressed', 'false')
    for (const [label, hex] of [['tab', '1b5b5a'], ['Enter', '0a']]) {
      // Prefix each submission so the check cannot match the keyboard-Shift results above.
      await page.keyboard.type('s')
      await shift.tap()
      await page.getByRole('button', { name: label, exact: true }).tap()
      await expect(shift).toHaveAttribute('aria-pressed', 'false')
      await expect(input).toBeFocused()
      await page.getByRole('button', { name: 'Enter', exact: true }).tap()
      await waitForPaneText(target, `INPUT_HEX:73${hex}`)
    }
    await page.keyboard.type('s')
    await shift.tap()
    await page.getByRole('button', { name: 'Arrow keys', exact: true }).tap()
    await expect(shift).toHaveAttribute('aria-pressed', 'true')
    await page.getByRole('button', { name: 'Arrow up', exact: true }).tap()
    await expect(shift).toHaveAttribute('aria-pressed', 'false')
    await page.getByRole('button', { name: 'Arrow up', exact: true }).tap()
    await page.getByRole('button', { name: 'Arrow keys', exact: true }).tap()
    await page.getByRole('button', { name: 'Enter', exact: true }).tap()
    await waitForPaneText(target, 'INPUT_HEX:731b5b313b32411b5b41')

    // Hold 123, drag onto the actual rendered zero cell, and release.
    const numbers = page.getByRole('button', { name: '123', exact: true })
    await numbers.scrollIntoViewIfNeeded()
    const numberBox = (await numbers.boundingBox())!
    const numCdp = await page.context().newCDPSession(page)
    await numCdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{
      x: numberBox.x + numberBox.width / 2, y: numberBox.y + numberBox.height / 2,
    }] })
    const zero = page.locator('.terminal-controls').getByText('0', { exact: true })
    await expect(zero).toBeVisible()
    const zeroBox = (await zero.boundingBox())!
    expect(zeroBox.y + zeroBox.height).toBeLessThan(numberBox.y)
    await numCdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{
      x: zeroBox.x + zeroBox.width / 2, y: zeroBox.y + zeroBox.height / 2,
    }] })
    await expect(page.getByText('Release to send "0"', { exact: true })).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('mobile-numpad-zero.png') })
    await numCdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await expect(zero).toHaveCount(0)
    await expect(input).toBeFocused()
    await page.getByRole('button', { name: 'Enter', exact: true }).tap()
    await waitForPaneText(target, 'INPUT_HEX:30')
    await numCdp.detach()

    // Exercise an actual browser pan, including intermediate touch moves.
    await expect(input).toBeFocused()
    const row = page.locator('.terminal-controls > .grid')
    const scrollStart = compact ? 0 : 80
    await row.evaluate((element, offset) => { element.scrollLeft = offset }, scrollStart)
    const bounds = (await tab.boundingBox())!
    const x = bounds.x + bounds.width / 2
    const y = bounds.y + bounds.height / 2
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] })
    for (let distance = 10; distance <= 120; distance += 10) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x - distance, y }] })
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await expect.poll(() => row.evaluate(element => element.scrollLeft)).toBeGreaterThan(scrollStart)
    await expect(input).toBeFocused()
    await page.getByRole('button', { name: 'Enter' }).tap()
    // A swipe beginning on Tab must not insert a tab into the terminal.
    expect(tmux(['capture-pane', '-t', target, '-p']).stdout).not.toContain('INPUT_HEX:09')
    await cdp.detach()

  } finally {
    tmux(['kill-window', '-t', target])
  }
})

}

// WebKit covers Safari's event path; desktop automation cannot display the
// actual iPhone software keyboard, so these assert focus and real PTY input.
for (const [browserName, device] of [['chromium', 'iPhone 13'], ['webkit', 'iPhone 13'], ['chromium', 'Pixel 7']] as const) {
  test.describe(`${browserName} ${device} native keyboard focus`, () => {
    test('terminal taps reopen input after native dismissal without app keyboard buttons', async ({ playwright }, testInfo) => {
      const browser = await playwright[browserName].launch()
      const context = await browser.newContext({ ...devices[device], baseURL: testInfo.project.use.baseURL })
      const page = await context.newPage()
      const session = process.env.E2E_TMUX_SESSION!
      const target = `${session}:keyboard-${browserName}`
      try {
        expect(tmux(['new-window', '-t', session, '-n', `keyboard-${browserName}`, `python3 ${REPL_PATH}`]).status).toBe(0)
        await waitForPaneText(target, 'PASTE-REPL READY')
        await page.addInitScript(() => localStorage.setItem('agentboard-settings', JSON.stringify({ version: 8, state: { compactMobileControls: false } })))
        await page.goto('/')
        const card = page.getByTestId('session-card').filter({ hasText: `keyboard-${browserName}` }).first()
        await card.waitFor({ state: 'attached', timeout: 20000 })
        await card.evaluate(el => (el as HTMLElement).click())
        const input = page.locator('.xterm-helper-textarea')
        await expect(page.locator('.xterm-screen')).toBeVisible()
        await page.waitForTimeout(1500)
        await expect(page.getByRole('button', { name: 'Dismiss keyboard', exact: true })).toHaveCount(0)
        await expect(page.getByRole('button', { name: 'Show keyboard' })).toHaveCount(0)
        await expect(input).not.toBeFocused()
        for (const text of ['first', 'reopened']) {
          await page.locator('.xterm').tap({ position: { x: 120, y: 100 } })
          await expect(input).toBeFocused()
          await page.keyboard.type(text)
          await page.getByRole('button', { name: 'Enter', exact: true }).tap()
          await waitForPaneText(target, `SUBMITTED:${text}`)
          await expect(input).toBeFocused()
          // Stand in for OS keyboard dismissal. Playwright does not display
          // the iPhone keyboard or drive its native check/dismiss control.
          await input.evaluate(el => (el as HTMLTextAreaElement).blur())
          await expect(input).not.toBeFocused()
        }
        // Quick keys work with the keyboard dismissed without reopening it.
        await page.getByRole('button', { name: 'esc', exact: true }).tap()
        await page.getByRole('button', { name: 'Enter', exact: true }).tap()
        await waitForPaneText(target, 'INPUT_HEX:1b')
        await expect(input).not.toBeFocused()
        const row = page.locator('.terminal-controls > .grid')
        // Software keyboards shrink visualViewport without changing innerHeight.
        // Drive that event shape, rather than resizing the entire browser window.
        await page.evaluate(() => {
          Object.defineProperty(window.visualViewport!, 'height', { configurable: true, value: 400 })
          window.visualViewport!.dispatchEvent(new Event('resize'))
        })
        await expect.poll(async () => {
          const box = (await row.boundingBox())!
          return box.y + box.height
        }).toBeLessThanOrEqual(400)
        await page.evaluate(() => {
          Reflect.deleteProperty(window.visualViewport!, 'height')
          window.visualViewport!.dispatchEvent(new Event('resize'))
        })
        for (const width of (device === 'Pixel 7' ? [320, 390] : [320, 390, 844])) {
          await page.setViewportSize({ width, height: width === 844 ? 390 : 844 })
          const rowBox = (await row.boundingBox())!
          expect(rowBox.height).toBe(44)
          expect(rowBox.x).toBeGreaterThanOrEqual(0)
          expect(rowBox.x + rowBox.width).toBeLessThanOrEqual(width)
          await expect(page.getByRole('button', { name: 'Enter', exact: true })).toBeVisible()
        }
        await page.setViewportSize({ width: 390, height: 844 })
        await row.evaluate(el => { el.scrollLeft = 0 })
        await page.screenshot({ path: testInfo.outputPath('pwa-keyboard-controls.png') })
      } finally {
        tmux(['kill-window', '-t', target])
        await browser.close()
      }
    })
  })
}
