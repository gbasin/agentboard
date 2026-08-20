import { test, expect } from '@playwright/test'
import { spawnSync } from 'node:child_process'

test('dashboard loads and terminal attaches', async ({ page }) => {
  await page.goto('/')

  await expect(page.getByRole('heading', { name: 'Agentboard' })).toBeVisible()

  const card = page.getByTestId('session-card').first()
  await expect(card).toBeVisible()
  await card.click()

  await expect(page.getByTestId('terminal-panel')).toBeVisible()
  await expect(page.locator('.xterm')).toBeVisible()
})

test('digit shortcut switches sessions while the terminal has focus', async ({ page }) => {
  const session = process.env.E2E_TMUX_SESSION
  if (!session) throw new Error('E2E_TMUX_SESSION is not set')
  const targetName = `shortcut-target-${process.pid}-${Date.now()}`

  const created = spawnSync(
    'tmux',
    ['new-window', '-t', `=${session}`, '-n', targetName],
    { encoding: 'utf-8' }
  )
  if (created.status !== 0) {
    throw new Error(`Failed to create shortcut target: ${created.stderr}`)
  }

  await page.goto('/')
  const cards = page.getByTestId('session-card')
  const target = cards.filter({ hasText: targetName })
  await expect(target).toBeVisible({ timeout: 10000 })

  const cardTexts = await cards.allTextContents()
  const targetIndex = cardTexts.findIndex((text) => text.includes(targetName))
  if (targetIndex < 0 || targetIndex >= 9) {
    throw new Error(`Shortcut target has unsupported visible index ${targetIndex}`)
  }
  const initial = cards.nth(targetIndex === 0 ? 1 : 0)
  await initial.click()
  await expect(initial).toHaveClass(/selected/)

  const terminalInput = page.locator('.xterm-helper-textarea')
  await terminalInput.focus()
  await expect(terminalInput).toBeFocused()

  const isMac = await page.evaluate(() => /Mac|iPhone|iPad|iPod/.test(navigator.platform))
  const digit = String(targetIndex + 1)
  await page.keyboard.press(isMac ? `Control+Alt+${digit}` : `Control+Shift+${digit}`)

  await expect(target).toHaveClass(/selected/)
  await expect(initial).not.toHaveClass(/selected/)
})
