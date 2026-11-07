import { test, expect } from '@playwright/test'
import { spawnSync } from 'node:child_process'
import { desktopSidebar } from './helpers/sidebarHarness'

test('dashboard loads and terminal attaches', async ({ page }) => {
  await page.goto('/')

  // The sidebar's global controls live in the filter bar; no header wordmark.
  await expect(page.getByRole('button', { name: 'Settings', exact: true })).toBeVisible()
  // Scoped to the sidebar: the mobile terminal header has its own (hidden on
  // desktop) "New session" button once a session is selected.
  await expect(
    desktopSidebar(page).locator('button[aria-label="New session"]')
  ).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Agentboard' })).toHaveCount(0)

  const card = page.getByTestId('session-card').first()
  await expect(card).toBeVisible()
  await card.click()

  await expect(page.getByTestId('terminal-panel')).toBeVisible()
  await expect(page.locator('.xterm')).toBeVisible()
})

test('digit shortcut switches sessions while the terminal has focus', async ({ page }) => {
  const session = process.env.E2E_TMUX_SESSION
  const privateDir = process.env.E2E_TMUX_TMPDIR
  if (!session || !privateDir) throw new Error('Private E2E tmux server is required')
  const env = { ...process.env, TMUX_TMPDIR: privateDir }
  delete env.TMUX
  const tmux = (...args: string[]) => spawnSync('tmux', args, { env, encoding: 'utf-8' })
  const created: string[] = []
  const suffix = `${process.pid}-${Date.now()}`
  function window(name: string) {
    const result = tmux('new-window', '-P', '-F', '#{window_id}', '-t', `=${session}`, '-n', name)
    if (result.status !== 0) throw new Error(`Failed to create shortcut fixture: ${result.stderr}`)
    const id = `${session}:${result.stdout.trim()}`
    created.push(id)
    return id
  }
  try {
    // Own both targets: a previous test's removed window can remain in the
    // discovery snapshot briefly and must not become this test's initial pane.
    const initialId = window(`shortcut-initial-${suffix}`)
    const targetId = window(`shortcut-target-${suffix}`)
    await page.goto('/')
    const cards = page.getByTestId('session-card')
    const initialCard = page.locator(`[data-testid="session-card"][data-session-id="${initialId}"]`)
    const target = page.locator(`[data-testid="session-card"][data-session-id="${targetId}"]`)
    await expect(initialCard).toBeVisible({ timeout: 10000 })
    await expect(target).toBeVisible({ timeout: 10000 })
    await initialCard.click()
    await expect(initialCard).toHaveClass(/selected/)
    await expect(page.getByTestId('terminal-recovery-status')).toHaveCount(0)

    const terminalInput = page.locator('.xterm-helper-textarea')
    await terminalInput.focus()
    await expect(terminalInput).toBeFocused()
    const ids = await cards.evaluateAll(nodes => nodes.map(node => node.getAttribute('data-session-id')))
    // AnimatePresence can retain a removed row while the live list has
    // already advanced. Shortcuts follow live sessions, not exiting DOM rows.
    const liveSessions: Array<{ id: string }> = await (await page.request.get('/api/sessions')).json()
    const liveIds = new Set(liveSessions.map(item => item.id))
    const targetIndex = ids.filter(id => id !== null && liveIds.has(id)).indexOf(targetId)
    if (targetIndex < 0 || targetIndex >= 9) throw new Error(`Shortcut target has unsupported visible index ${targetIndex}`)
    const isMac = await page.evaluate(() => /Mac|iPhone|iPad|iPod/.test(navigator.platform))
    await page.keyboard.press(isMac ? `Control+Alt+${targetIndex + 1}` : `Control+Shift+${targetIndex + 1}`)
    await expect(target).toHaveClass(/selected/)
    await expect(initialCard).not.toHaveClass(/selected/)
  } finally {
    for (const id of created) tmux('kill-window', '-t', id)
  }
})
