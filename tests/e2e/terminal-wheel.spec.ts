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

test('wheel and exit follow an in-terminal window switch', async ({ page }) => {
  const session = process.env.E2E_TMUX_SESSION!
  const first = tmux('new-window', '-dP', '-F', '#{window_id}', '-t', session, 'exec cat')
  const original = `${session}:${first}`
  const second = tmux('new-window', '-dP', '-F', '#{window_id}', '-t', session,
    'seq 1 150; echo SWITCHED-HISTORY; exec cat')
  const switched = `${session}:${second}`
  let bounds: { firstCol: number; lastCol: number } | undefined
  page.on('websocket', socket => socket.on('framereceived', ({ payload }) => {
    if (!String(payload).includes('tmux-copy-mode-status')) return
    const frame = JSON.parse(String(payload))
    if (frame.sessionId === original) bounds = frame.wheelBounds
  }))

  try {
    tmux('split-window', '-h', '-t', original, 'echo RIGHT-SPLIT; exec cat')
    await attach(page, original, 'RIGHT-SPLIT', false, false)
    await expect.poll(() => bounds?.firstCol ?? 0).toBeGreaterThan(40)
    const clients = tmux('list-clients', '-F', '#{client_session} #{window_id}').split('\n')
    const group = clients.map(line => line.split(' ')).find(([name, id]) =>
      name.startsWith(session + '-ws-') && id === first)?.[0]
    if (!group) throw new Error('Missing grouped PTY client for the selected window')

    // Change only this terminal client's view. The board still has the first
    // card selected, exactly as when a user runs select-window inside tmux.
    tmux('select-window', '-t', `${group}:${second}`)
    tmux('resize-window', '-t', switched, '-x', '40', '-y', '24')
    await expect.poll(() => bounds).toMatchObject({ firstCol: 1, lastCol: 40 })
    await page.locator('.xterm-screen').hover()
    await page.mouse.wheel(0, -240)
    await expect.poll(() => Number(tmux('display-message', '-p', '-t', switched, '#{scroll_position}'))).toBeGreaterThan(0)
    await page.locator('.xterm-helper-textarea').focus()
    await page.keyboard.type('BACK-LIVE')
    await expect.poll(() => tmux('capture-pane', '-pt', switched)).toContain('BACK-LIVE')
    await expect.poll(() => tmux('display-message', '-p', '-t', switched, '#{pane_in_mode}')).toBe('0')
    expect(tmux('display-message', '-p', '-t', original, '#{pane_in_mode}')).toBe('0')
  } finally {
    tmux('kill-window', '-t', switched)
    tmux('kill-window', '-t', original)
  }
})
