import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { devices, expect, test, type Page } from '@playwright/test'
import { observeTerminalReadiness } from './helpers/terminalReadiness'
import { socketPath } from './tmuxReap'

test.use({ browserName: 'webkit' })

function tmux(...args: string[]) {
  const dir = process.env.E2E_TMUX_TMPDIR
  if (!dir) throw new Error('Private e2e tmux directory required')
  return execFileSync('tmux', ['-S', socketPath(dir), ...args], { encoding: 'utf8' }).trim()
}

async function attach(page: Page, id: string, marker: string, mobile: boolean, mouse: boolean) {
  const ready = observeTerminalReadiness(page)
  await page.goto('/')
  if (mobile) await page.getByRole('button', { name: 'Open session menu', exact: true }).click()
  const list = mobile ? page.getByRole('dialog', { name: 'Session list' }) : page
  await list.locator(`[data-testid="session-card"][data-session-id="${id}"]`).click()
  await ready(id, marker, mouse)
}

// Playwright WebKit exposes tap, but has no native swipe API. Dispatch the
// touch sequence at the terminal and observe its effect in the real tmux pane.
async function swipeIntoHistory(page: Page) {
  await page.locator('.xterm-screen').evaluate(screen => {
    const rect = screen.getBoundingClientRect()
    const x = rect.left + rect.width / 2
    const y = rect.top + rect.height / 3
    const target = document.elementFromPoint(x, y)!
    for (const [type, dy] of [['touchstart', 0], ['touchmove', 75], ['touchend', 75]] as const) {
      const point = { clientX: x, clientY: y + dy, identifier: 0, target }
      const event = Object.assign(new Event(type, { bubbles: true, cancelable: true }), {
        touches: type === 'touchend' ? [] : [point], changedTouches: [point],
      })
      target.dispatchEvent(event)
    }
  })
}

for (const mobile of [false, true]) {
  test.describe(mobile ? 'iPhone WebKit touch' : 'desktop wheel', () => {
    test.use(mobile
      ? { viewport: devices['iPhone 13'].viewport, userAgent: devices['iPhone 13'].userAgent, isMobile: true, hasTouch: true }
      : { viewport: { width: 1440, height: 900 } })

    for (const mouse of [false, true]) {
      test(`reaches a smaller shared ${mouse ? 'mouse-reporting app' : 'pane with history'}`, async ({ page }, info) => {
        const session = process.env.E2E_TMUX_SESSION!
        const command = mouse
          ? `python3 "${resolve('tests/e2e/fixtures/mouse-repl.py')}" scroll`
          : 'seq 1 150; echo HISTORY-READY; exec cat'
        const win = tmux('new-window', '-P', '-F', '#{window_id}', '-t', session, '-n', 'scroll-probe', command)
        const target = `${session}:${win}`
        let observedSmallPane = false
        page.on('websocket', socket => socket.on('framereceived', ({ payload }) => {
          if (!String(payload).includes('tmux-copy-mode-status')) return
          const frame = JSON.parse(String(payload))
          if (frame.sessionId === target && frame.wheelBounds?.lastCol === 20 && frame.wheelBounds.lastRow === 8) {
            observedSmallPane = true
          }
        }))
        try {
          await attach(page, target, mouse ? 'MOUSE-REPL READY' : 'HISTORY-READY', mobile, mouse)
          // Reproduce the size left by another client without resizing this browser.
          tmux('resize-window', '-t', target, '-x', '20', '-y', '8')
          expect(tmux('display-message', '-p', '-t', target, '#{pane_width}x#{pane_height}')).toBe('20x8')
          await expect.poll(() => observedSmallPane).toBe(true)
          if (mobile) await swipeIntoHistory(page)
          else {
            await page.locator('.xterm-screen').hover()
            await page.mouse.wheel(0, -240)
          }
          if (mouse) {
            await expect.poll(() => tmux('capture-pane', '-pJ', '-t', target, '-S', '-100')).toContain('MOUSESEQ ESC[<64;')
            expect(tmux('display-message', '-p', '-t', target, '#{pane_in_mode}')).toBe('0')
          } else {
            await expect.poll(() => Number(tmux('display-message', '-p', '-t', target, '#{scroll_position}'))).toBeGreaterThan(0)
          }
          await info.attach('terminal-after-scroll', { body: await page.screenshot(), contentType: 'image/png' })
        } finally {
          tmux('kill-window', '-t', target)
        }
      })
    }
  })
}
