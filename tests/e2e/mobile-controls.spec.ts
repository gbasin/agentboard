// E2E: the mobile key deck's ⇧tab key must deliver CSI Z (ESC [ Z) to the
// attached tmux pane. Claude Code reads that sequence as Shift+Tab to cycle
// plan / auto-accept mode, and a phone keyboard has no way to type it.
//
// Runs in a touch-enabled iPhone viewport so the key deck (hidden on desktop
// unless the UA is iOS) is rendered and driven through real tap events. The
// pane runs the paste-repl fixture, which echoes submitted input as hex.
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { test, expect } from '@playwright/test'

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

test('⇧tab key sends CSI Z to the pane from a touch device', async ({ page }, testInfo) => {
  const session = process.env.E2E_TMUX_SESSION
  test.skip(!session, 'E2E_TMUX_SESSION not set')
  const target = `${session}:${WINDOW_NAME}`

  const created = tmux(['new-window', '-t', session!, '-n', WINDOW_NAME, `python3 ${REPL_PATH}`])
  expect(created.status).toBe(0)

  try {
    await waitForPaneText(target, 'PASTE-REPL READY')

    await page.goto('/')
    // On mobile the session list lives in a drawer: the card is in the DOM
    // but not visible, so select it with a DOM click.
    const card = page.getByTestId('session-card').filter({ hasText: WINDOW_NAME }).first()
    await card.waitFor({ state: 'attached', timeout: 20000 })
    await card.evaluate((el) => (el as HTMLElement).click())
    await expect(page.locator('.xterm')).toBeVisible()
    await page.waitForTimeout(2000) // let the terminal attach settle

    const shiftTab = page.getByRole('button', { name: 'Shift+Tab' })
    await expect(shiftTab).toBeVisible()
    const box = await shiftTab.boundingBox()
    expect(box?.width).toBeGreaterThanOrEqual(44)
    expect(box?.height).toBeGreaterThanOrEqual(44)
    // Label must not overflow its 44px cell.
    const overflows = await shiftTab.evaluate((el) => el.scrollWidth > el.clientWidth)
    expect(overflows).toBe(false)

    await page.screenshot({ path: testInfo.outputPath('mobile-key-deck.png') })

    await shiftTab.tap()
    await page.getByRole('button', { name: 'Enter' }).tap()

    // ESC [ Z, and nothing else, was submitted.
    await waitForPaneText(target, 'INPUT_HEX:1b5b5a')

    // Exercise an actual browser pan, including intermediate touch moves.
    await page.getByRole('button', { name: 'Show keyboard' }).tap()
    const input = page.locator('.xterm-helper-textarea')
    await expect(input).toBeFocused()
    const row = page.locator('.terminal-controls > .grid')
    await row.evaluate(element => { element.scrollLeft = 0 })
    const tab = page.getByRole('button', { name: 'tab', exact: true })
    const bounds = (await tab.boundingBox())!
    const x = bounds.x + bounds.width / 2
    const y = bounds.y + bounds.height / 2
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] })
    for (let distance = 10; distance <= 120; distance += 10) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x - distance, y }] })
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await expect.poll(() => row.evaluate(element => element.scrollLeft)).toBeGreaterThan(50)
    await expect(input).toBeFocused()
    await page.getByRole('button', { name: 'Enter' }).tap()
    // A swipe beginning on Tab must not insert a tab into the terminal.
    expect(tmux(['capture-pane', '-t', target, '-p']).stdout).not.toContain('INPUT_HEX:09')
    await cdp.detach()

  } finally {
    tmux(['kill-window', '-t', target])
  }
})
