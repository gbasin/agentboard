import { test, expect } from '@playwright/test'
import { spawnSync } from 'node:child_process'
import type { Locator, Page } from '@playwright/test'
import { cardByName, desktopSidebar } from './helpers/sidebarHarness'

// Session names may contain spaces and most punctuation; they are display
// labels only — every tmux target is the @id. These specs drive the real UI
// against real tmux so the name must survive the whole path: modal input,
// window creation, list-windows parsing, rename, and the sessions broadcast.

const tmuxWindowName = (tmuxWindow: string): string =>
  spawnSync(
    'tmux',
    ['display-message', '-p', '-t', `=${tmuxWindow}`, '#{window_name}'],
    { encoding: 'utf-8' }
  ).stdout.trim()

async function renameViaContextMenu(
  page: Page,
  card: Locator,
  newName: string
) {
  await card.click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Rename' }).click()
  const input = card.locator('input')
  await input.fill(newName)
  await input.press('Enter')
}

test('create and rename sessions with spaces and punctuation', async ({
  page,
}) => {
  const tag = `${process.pid}-${Date.now().toString(36)}`
  const createName = `new sess ${tag}`
  const renameName = `renamed: with | pipes ${tag}`

  await page.goto('/')

  // Create via the modal — the name field used to slugify whitespace
  await desktopSidebar(page)
    .locator('button[aria-label="New session"]')
    .click()
  const dialog = page.locator('[aria-labelledby="new-session-title"]')
  await dialog.getByPlaceholder('Enter command...').fill('sh')
  await dialog.locator('input.flex-1').fill('/tmp')
  await dialog.getByPlaceholder('auto-generated').fill(createName)
  await dialog.getByRole('button', { name: 'Create', exact: true }).click()

  const sidebar = desktopSidebar(page)
  const card = cardByName(sidebar, createName).first()
  await expect(card).toBeVisible({ timeout: 20000 })
  const sessionId = await card.getAttribute('data-session-id')
  expect(sessionId).toBeTruthy()

  // The card keeps a stable session id while its name changes; hasText
  // filters cannot find it once the name becomes an edit input
  const byId = sidebar.locator(
    `[data-testid="session-card"][data-session-id="${sessionId}"]`
  )
  await expect
    .poll(() => tmuxWindowName(sessionId!), { timeout: 10000 })
    .toBe(createName)

  // Rename via the card context menu — ':' and '|' must round-trip
  await renameViaContextMenu(page, byId, renameName)
  await expect(cardByName(sidebar, renameName).first()).toBeVisible({
    timeout: 10000,
  })
  await expect
    .poll(() => tmuxWindowName(sessionId!), { timeout: 10000 })
    .toBe(renameName)

  // A leading-dash name needs the rename-window '--' guard
  const dashName = `-dash ${tag}`
  await renameViaContextMenu(page, byId, dashName)
  await expect
    .poll(() => tmuxWindowName(sessionId!), { timeout: 10000 })
    .toBe(dashName)

  // Backslashes are rejected: tmux format output escapes them, so the name
  // could never round-trip
  await renameViaContextMenu(page, byId, 'bad\\name')
  await expect(
    page.getByText('Name cannot contain backslashes')
  ).toBeVisible({ timeout: 10000 })
  await expect
    .poll(() => tmuxWindowName(sessionId!), { timeout: 10000 })
    .toBe(dashName)

  // '#{...}' must stay literal — tmux format-expands name arguments unless
  // the '#' is doubled
  const fmtName = `fmt #{version} ${tag}`
  await renameViaContextMenu(page, byId, fmtName)
  await expect
    .poll(() => tmuxWindowName(sessionId!), { timeout: 10000 })
    .toBe(fmtName)
})
