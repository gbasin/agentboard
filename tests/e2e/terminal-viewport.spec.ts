// A stale xterm helper textarea must never scroll the board to its old cursor.
// Exercise the real renderer and browser focus scrolling with deterministic output.
import { test, expect } from '@playwright/test'
import { CATALOG_VERSION } from '../../src/shared/catalogProtocol'

for (const browserName of ['chromium', 'webkit'] as const) {
  test(`terminal viewport (${browserName}): refocusing after shrink keeps the sidebar on screen`, async ({ playwright, baseURL }) => {
    const browser = await playwright[browserName].launch()
    try {
      const page = await browser.newPage({ baseURL, serviceWorkers: 'block', viewport: { width: 1600, height: 900 } })
      const inputFrames: string[] = []
      await page.route('**/api/**', route => route.fulfill({ json: {} }))
      await page.routeWebSocket('**/ws?*', socket => {
        socket.send(JSON.stringify({ type: 'server-config', catalogVersion: CATALOG_VERSION,
          remoteAllowControl: false, remoteAllowAttach: false, hostLabel: 'test', preferWindowName: false }))
        socket.send(JSON.stringify({ type: 'sessions', sessions: [{ id: 'viewport', name: 'Viewport regression',
          status: 'working', createdAt: '2026-01-01T00:00:00.000Z', projectPath: '/tmp/viewport', agentType: 'claude' }] }))
        socket.onMessage(raw => {
          const message = JSON.parse(String(raw))
          if (message.type === 'terminal-input') inputFrames.push(message.data)
          if (message.type === 'terminal-attach') {
            socket.send(JSON.stringify({ type: 'terminal-output', sessionId: 'viewport', data: '\x1b[1;150Hcursor' }))
            socket.send(JSON.stringify({ type: 'terminal-ready', sessionId: 'viewport' }))
          }
        })
      })
      await page.goto('/')
      await page.getByTestId('session-card').first().click()
      const input = page.locator('.xterm-helper-textarea')
      await expect(input).toBeFocused()
      // Prove the cursor started beyond the future right edge, without injecting DOM styles.
      await expect.poll(() => input.evaluate(el => el.getBoundingClientRect().x)).toBeGreaterThan(1200)
      await page.setViewportSize({ width: 800, height: 900 })
      await expect.poll(() => page.locator('.xterm-screen').evaluate(el => el.clientWidth)).toBeLessThan(600)
      // Browser focus (also used by paste/draft refocus) can scroll overflow:hidden ancestors.
      await input.evaluate(el => { el.blur(); el.focus() })
      const geometry = await page.getByTestId('terminal-panel').evaluate(panel => {
        const board = panel.parentElement!
        const sidebar = board.firstElementChild!
        return { scrollLeft: board.scrollLeft, sidebarX: sidebar.getBoundingClientRect().x,
          terminalX: panel.getBoundingClientRect().x, terminalRight: panel.getBoundingClientRect().right }
      })
      await page.screenshot({ path: test.info().outputPath(`terminal-viewport-${browserName}.png`) })
      expect(geometry.scrollLeft).toBe(0)
      expect(geometry.sidebarX).toBe(0)
      expect(geometry.terminalX).toBeGreaterThan(0)
      expect(geometry.terminalRight).toBeLessThanOrEqual(800)
      // The field must still deliver input after the resize/focus sequence.
      await expect(input).toBeFocused()
      await page.keyboard.type('still typing')
      await expect.poll(() => inputFrames.join('')).toBe('still typing')
    } finally {
      await browser.close()
    }
  })
}
