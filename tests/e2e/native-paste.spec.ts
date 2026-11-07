/** Browser regression coverage; the native iOS callout is verified separately on m5p. */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { test, expect, type Page } from '@playwright/test'

const enabled = process.env.IOS_NATIVE_PASTE_E2E === '1'
const ua = 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_4 like Mac OS X) AppleWebKit/605.1.15 Version/26.4 Mobile/15E148 Safari/604.1'
test.use({ viewport: { width: 402, height: 874 }, userAgent: ua, hasTouch: true, isMobile: true })
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'"
function tmux(args: string[]) {
  const result = spawnSync('tmux', ['-L', 'default', ...args], {
    env: { ...process.env, TMUX: undefined }, encoding: 'utf8',
  })
  if (result.status !== 0) throw new Error(result.stderr)
  return result.stdout
}
async function attach(page: Page, name: string) {
  await page.goto('/')
  await page.getByRole('button', { name: 'Open session menu', exact: true }).click()
  await page.getByRole('dialog', { name: 'Session list' }).getByTestId('session-card').filter({ hasText: name }).first().click()
  await expect(page.locator('.xterm-screen')).toBeVisible({ timeout: 20000 })
  await expect(page.locator('.xterm-helper-textarea')).toHaveCount(1)
}
async function touch(page: Page, selector: string, type: 'touchstart' | 'touchend') {
  await page.locator(selector).evaluate((element, eventType) => {
    const rect = element.getBoundingClientRect()
    const point = new Touch({ identifier: 1, target: element, clientX: rect.x + 100, clientY: rect.y + 5 })
    element.dispatchEvent(new TouchEvent(eventType, {
      bubbles: true, cancelable: true,
      touches: eventType === 'touchstart' ? [point] : [], changedTouches: [point],
    }))
  }, type)
}

test('native paste target is opt-in and leaves output hit-testing and selection intact', async ({ page }) => {
  const name = 'native-target'
  const target = `${process.env.E2E_TMUX_SESSION}:${name}`
  const dir = mkdtempSync('/tmp/abnp-browser-')
  const input = join(dir, 'input.jsonl')
  let appMouse = false
  page.on('websocket', socket => socket.on('framereceived', frame => {
    try {
      const message = JSON.parse(String(frame.payload))
      if (message.type === 'tmux-copy-mode-status') appMouse = message.appMouse === true
    } catch { /* Ignore non-JSON frames. */ }
  }))
  tmux(['new-window', '-t', process.env.E2E_TMUX_SESSION!, '-n', name,
    ['/usr/bin/python3', resolve('scripts/native-paste-prototype/terminal.py'), input].map(quote).join(' ')])
  try {
    await attach(page, name)
    await expect(page.locator('.xterm-accessibility-tree')).toContainText('Native paste test.', { timeout: 20000 })
    expect(await page.locator('.ios-native-paste-prototype').count()).toBe(enabled ? 1 : 0)
    if (!enabled) return
    await expect.poll(() => appMouse).toBe(true)
    // Long-pressing the native input must not start app mouse selection.
    await touch(page, '.xterm-helper-textarea', 'touchstart')
    await page.waitForTimeout(750)
    await touch(page, '.xterm-helper-textarea', 'touchend')
    expect(readFileSync(input, 'utf8')).toBe('')
    // Output retains the existing mouse-selection gesture in mouse-reporting TUIs.
    await touch(page, '.xterm-accessibility-tree > div:first-child', 'touchstart')
    await page.waitForTimeout(750)
    await touch(page, '.xterm-accessibility-tree > div:first-child', 'touchend')
    await expect.poll(() => readFileSync(input, 'utf8')).toContain('1b5b3c30')
    const result = await page.evaluate(() => {
      const input = document.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement
      const row = document.querySelector('.xterm-accessibility-tree > div') as HTMLElement
      const rect = input.getBoundingClientRect()
      const output = row.getBoundingClientRect()
      const inputHit = document.elementFromPoint(rect.left + 20, rect.top + 5)
      const outputHit = document.elementFromPoint(output.left + 20, output.top + 5)
      const range = document.createRange()
      range.selectNodeContents(row)
      const selection = window.getSelection()!
      selection.removeAllRanges()
      selection.addRange(range)
      return { inputHit: inputHit === input, outputHit: row.contains(outputHit),
        selected: selection.toString(), height: rect.height, left: rect.left, right: rect.right, viewport: innerWidth }
    })
    expect(result.inputHit).toBe(true)
    expect(result.outputHit).toBe(true)
    expect(result.selected).toContain('Native paste test.')
    expect(result.height).toBeGreaterThanOrEqual(44)
    expect(result.left).toBeGreaterThanOrEqual(0)
    expect(result.right).toBeLessThanOrEqual(result.viewport)
    await page.evaluate(() => window.getSelection()?.removeAllRanges())
    await page.screenshot({ path: 'test-results/native-paste-target.png' })
  } finally {
    tmux(['kill-window', '-t', target])
    rmSync(dir, { recursive: true })
  }
})

test('callout-style paste without a keyboard shortcut holds multiline text until Enter', async ({ page }) => {
  const name = 'native-paste-repl'
  const target = `${process.env.E2E_TMUX_SESSION}:${name}`
  tmux(['new-window', '-t', process.env.E2E_TMUX_SESSION!, '-n', name,
    `python3 ${quote(resolve('tests/e2e/fixtures/paste-repl.py'))}`])
  try {
    await attach(page, name)
    await expect(page.locator('.xterm-accessibility-tree')).toContainText('PASTE-REPL READY', { timeout: 20000 })
    await page.locator('.xterm-helper-textarea').evaluate(element => {
      const textarea = element as HTMLTextAreaElement
      textarea.disabled = false
      textarea.focus()
      const data = new DataTransfer()
      data.setData('text/plain', 'native_alpha\nnative_beta')
      textarea.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
    })
    const capture = () => tmux(['capture-pane', '-pt', target])
    await expect.poll(capture).toContain('HELD:native_alpha|native_beta')
    expect(capture()).not.toContain('SUBMITTED:')
    await page.getByRole('button', { name: 'Enter', exact: true }).click()
    await expect.poll(capture).toContain('SUBMITTED:native_alpha|native_beta')
    expect(capture().match(/SUBMITTED:/g)).toHaveLength(1)
  } finally {
    tmux(['kill-window', '-t', target])
  }
})
