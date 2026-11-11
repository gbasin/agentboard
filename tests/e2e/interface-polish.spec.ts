// The approved shell polish keeps terminal I/O and all session actions usable.
// Fixtures rewrite presentation only; selecting and killing use real private tmux windows.
import { test, expect } from '@playwright/test'
import { Windows, installHarness, desktopSidebar, uniquePrefix } from './helpers/sidebarHarness'

// Row animation has separate coverage in session-row-collapse.spec.ts.
// Keep this behavioral/focus suite independent of background animation throttling.
test.use({ serviceWorkers: 'block', reducedMotion: 'reduce' })
test.describe.configure({ timeout: 90_000 })
const windows = new Windows()
test.afterEach(() => windows.cleanup())

for (const theme of ['light', 'dark']) {
  test(`${theme}: dense rows, narrow toolbar, keyboard session menu and terminal`, async ({ page }, info) => {
    const prefix = uniquePrefix('polish')
    windows.createMany(prefix, 4)
    await installHarness(page, {
      prefix,
      tailscaleIp: '100.64.0.2',
      settings: { theme, sidebarAnchor: 'bottom', showSessionIdPrefix: true, sidebarWidth: 270 },
      sessionOverrides: {
        0: { agentSessionName: 'sure-wren', agentSessionId: '01a12345678903c7', agentType: 'codex', projectPath: '/tmp/agentboard', lastUserMessage: 'Review the pull request and verify desktop and mobile before landing.', status: 'working' },
        1: { agentSessionName: 'waiting-for-permission', agentType: 'claude', projectPath: '/tmp/eichler', lastUserMessage: 'Check the changes and ask me before proceeding.', status: 'permission' },
        2: { agentSessionName: 'a-very-long-session-name-that-must-truncate', agentType: 'codex', projectPath: '/tmp/another-very-long-project-name', lastUserMessage: 'A long preview should stay on one desktop line without pushing controls offscreen.', status: 'unknown' },
      },
    })
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto('/')
    const sidebar = desktopSidebar(page)
    await expect(sidebar.getByTestId('session-card')).toHaveCount(4, { timeout: 30_000 })
    const selected = sidebar.getByTestId('session-card').filter({ hasText: 'sure-wren' })
    await selected.click()
    await expect(selected).toHaveAttribute('aria-pressed', 'true')
    await expect(page.locator('.xterm-screen').first()).toBeVisible()
    await expect(selected.locator('.session-preview')).toHaveCSS('font-style', 'normal')
    await expect(selected.locator('.session-preview')).toHaveCSS('-webkit-line-clamp', '1')
    await expect(sidebar.getByRole('button', { name: 'Settings', exact: true })).toHaveCSS('height', '28px')
    await page.screenshot({ path: info.outputPath(`${theme}-desktop.png`) })

    // Use the explicit action menu with only the keyboard, including focus restoration.
    const actions = page.getByRole('button', { name: 'Session actions', exact: true })
    await expect(actions).toBeEnabled()
    await expect(page.getByRole('textbox', { name: 'Terminal input' })).toBeFocused()
    await actions.focus()
    await page.keyboard.press('Enter')
    await expect(page.getByRole('menuitem', { name: 'Rename', exact: true })).toBeFocused()
    await page.keyboard.press('End')
    await expect(page.getByRole('menuitem', { name: 'Kill Session', exact: true })).toBeFocused()
    await page.screenshot({ path: info.outputPath(`${theme}-actions.png`) })
    await page.keyboard.press('Escape')
    await expect(actions).toBeFocused()
    await expect(page.getByRole('menu')).toHaveCount(0)

    // A second click on the trigger closes the menu rather than reopening it
    // after the document's outside-mousedown handler.
    await actions.click()
    await expect(page.getByRole('menu')).toBeVisible()
    await actions.click()
    await expect(page.getByRole('menu')).toHaveCount(0)

    // Saved narrow sidebars still fit the six controls without horizontal clipping.
    await page.evaluate(() => {
      const sidebar = document.querySelector('.session-sidebar')!
      const parent = sidebar.parentElement!
      parent.style.width = '180px'
    })
    await expect.poll(() => sidebar.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true)
    const bounds = await sidebar.boundingBox()
    const gear = await sidebar.getByRole('button', { name: 'Settings', exact: true }).boundingBox()
    expect(gear!.x + gear!.width).toBeLessThanOrEqual(bounds!.x + bounds!.width)

    // Confirm the destructive action removes the real private tmux window.
    const killedId = await selected.getAttribute('data-session-id')
    await actions.click()
    await page.getByRole('menuitem', { name: 'Kill Session', exact: true }).click()
    await page.getByRole('button', { name: 'Kill Session', exact: true }).click()
    await expect.poll(async () => {
      const sessions = await (await page.request.get('/api/sessions')).json()
      return sessions.some((session: { id: string }) => session.id === killedId)
    }).toBe(false)
    // AnimatePresence can retain a fully collapsed exit node. Verify rendered
    // geometry instead of requiring its internal DOM cleanup to finish.
    await expect.poll(() => selected.evaluateAll(elements => elements.every(el =>
      el.parentElement!.getBoundingClientRect().height < 1
    ))).toBe(true)
    await expect(page.getByRole('menu')).toHaveCount(0)
  })

  test(`${theme}: phone list retains usable targets`, async ({ page }, info) => {
    const prefix = uniquePrefix('phone')
    windows.createMany(prefix, 3)
    await installHarness(page, { prefix, settings: { theme }, sessionOverrides: {
      0: { agentSessionName: 'sure-wren', agentType: 'codex', projectPath: '/tmp/agentboard', lastUserMessage: 'Review the pull request and verify desktop and mobile before landing. This preview wraps on a phone.', status: 'working' },
    } })
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto('/')
    const open = page.getByRole('button', { name: 'Open session menu', exact: true }).first()
    await open.click()
    const drawer = page.locator('.session-drawer')
    await expect(drawer.getByTestId('session-card')).toHaveCount(3, { timeout: 30_000 })
    await expect(drawer.locator('.session-preview').first()).toHaveCSS('-webkit-line-clamp', '2')
    await page.screenshot({ path: info.outputPath(`${theme}-phone.png`) })
    await drawer.getByTestId('session-card').filter({ hasText: 'sure-wren' }).click()
    await expect(page.locator('.xterm-screen').first()).toBeVisible()
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  })
}
