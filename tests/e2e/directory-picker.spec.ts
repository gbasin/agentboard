/** Real server folder selection: typed paths, recents, keyboard and phone layout. */
import { test, expect } from '@playwright/test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

let root: string
let originalSettings: { theme: string; recentPaths: string[]; lastProjectPath: string | null }
let createdName: string | null = null

test.beforeAll(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ab-picker-fixture-')))
  await Promise.all(['alpha', 'beta', '.hidden', 'recents'].map(name => fs.mkdir(path.join(root, name))))
  await Promise.all([1, 2, 3, 4].map(i => fs.mkdir(path.join(root, 'recents', `project-${i}`))))
})
test.beforeEach(async ({ request }) => {
  const { theme = 'dark', recentPaths = [], lastProjectPath = null } = (await (await request.get('/api/settings/synced')).json()).settings
  originalSettings = { theme, recentPaths, lastProjectPath }
  createdName = null
})
test.afterEach(async ({ page, request }) => {
  // Close first so a pending client settings write cannot overwrite the restoration.
  await page.close()
  await request.put('/api/settings/synced', { data: { settings: originalSettings } })
  const sessions: Array<{ id: string; name: string }> = await (await request.get('/api/sessions')).json()
  const socketRoot = process.env.E2E_TMUX_TMPDIR
  if (!socketRoot) throw new Error('Private E2E tmux socket required')
  const env = { ...process.env }; delete env.TMUX; delete env.TMUX_PANE
  for (const session of sessions.filter(session => session.name === createdName)) {
    const result = spawnSync('tmux', ['-S', path.join(socketRoot, `tmux-${process.getuid!()}`, 'default'), 'kill-window', '-t', session.id], { env, encoding: 'utf8' })
    expect(result.status, result.stderr).toBe(0)
  }
})
test.afterAll(async () => { await fs.rm(root, { recursive: true, force: true }) })

for (const phone of [false, true]) {
  test(`choose server folders on ${phone ? 'phone' : 'desktop'}`, async ({ page, request }) => {
    await page.setViewportSize(phone ? { width: 390, height: 844 } : { width: 1280, height: 900 })
    // The server is canonical; localStorage alone loses to settings from earlier specs.
    await request.put('/api/settings/synced', { data: { settings: {
      theme: 'light',
      recentPaths: [...[1, 2, 3, 4].map(i => `${root}/recents/project-${i}`), root + '/beta'],
    } } })
    await page.goto('/')
    await page.getByRole('button', { name: 'New session', exact: true }).first().click()
    const project = page.getByRole('combobox', { name: 'Project path' })
    await project.fill(root)
    await page.getByRole('button', { name: 'Browse', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Choose folder' })
    const entries = dialog.getByTestId('directory-entry')
    await expect(entries).toHaveCount(3)
    await expect(dialog.getByRole('heading')).toHaveCSS('color', 'rgb(23, 23, 23)')
    await expect(dialog.getByTestId('directory-choose')).toBeEnabled()
    await dialog.getByTestId('directory-choose').focus()
    await page.keyboard.press('Tab')
    await expect(dialog.getByLabel('Directory path', { exact: true })).toBeFocused()
    await page.keyboard.press('Shift+Tab')
    await expect(dialog.getByTestId('directory-choose')).toBeFocused()
    if (phone) {
      expect(await dialog.getByLabel('Directory path', { exact: true }).evaluate(el => getComputedStyle(el).fontSize)).toBe('16px')
      expect((await dialog.getByTestId('directory-choose').boundingBox())!.height).toBeGreaterThanOrEqual(44)
    }
    await dialog.getByLabel('Show hidden').check()
    await expect(entries).toHaveCount(4)
    await dialog.getByLabel('Filter folders').fill('BET')
    await expect(entries).toHaveCount(1)
    await expect(entries.first()).toHaveAttribute('data-entry-name', 'beta')
    await entries.first().click()
    await expect(dialog.getByTestId('directory-current-path')).toHaveText(root + '/beta')
    await dialog.getByRole('button', { name: 'Up', exact: true }).click()
    await expect(entries).toHaveCount(4)
    await entries.filter({ hasText: /^alpha$/ }).focus()
    await page.keyboard.press('ArrowDown')
    await expect(entries.filter({ hasText: /^beta$/ })).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(dialog.getByTestId('directory-current-path')).toHaveText(root + '/beta')
    await dialog.getByRole('navigation').getByRole('button', { name: path.basename(root), exact: true }).click()
    await expect(entries).toHaveCount(4)
    await dialog.getByLabel('Directory path', { exact: true }).fill(root + '/missing')
    await expect(dialog.getByTestId('directory-choose')).toBeDisabled()
    await dialog.getByLabel('Directory path', { exact: true }).press('Enter')
    await expect(dialog.getByRole('alert')).toContainText('Path does not exist')
    await expect(dialog.getByTestId('directory-choose')).toBeDisabled()
    await dialog.getByLabel('Directory path', { exact: true }).fill(root + '/alpha')
    await dialog.getByRole('button', { name: 'Go', exact: true }).click()
    await expect(dialog.getByTestId('directory-choose')).toBeEnabled()
    const bounds = await dialog.getByTestId('directory-choose').boundingBox()
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(phone ? 844 : 900)
    await dialog.getByTestId('directory-choose').click()
    await expect(project).toHaveValue(root + '/alpha')
    // The recent project is one choice, without entering the folder browser.
    await project.focus()
    const recents = page.getByRole('listbox', { name: 'Recent projects' })
    await expect(recents.getByRole('option')).toHaveCount(5)
    expect(await recents.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true)
    await recents.evaluate(el => { el.scrollTop = el.scrollHeight })
    expect(await recents.evaluate(el => el.scrollTop)).toBeGreaterThan(0)
    await page.getByRole('option').filter({ hasText: 'beta' }).click()
    await expect(project).toHaveValue(root + '/beta')
    await expect(dialog).toHaveCount(0)
    // A matching path uses Enter to choose, never accidentally creating a session.
    await project.fill(root + '/al')
    await expect(page.getByRole('option')).toHaveCount(1)
    await project.press('ArrowDown')
    await project.press('Tab')
    await expect(project).toHaveValue(root + '/alpha/')
    await project.fill(root + '/be')
    await expect(page.getByRole('option')).toHaveCount(1)
    await project.press('ArrowDown')
    await project.press('Enter')
    await expect(project).toHaveValue(root + '/beta')
    await expect(page.getByRole('dialog', { name: 'New Session', exact: true })).toBeVisible()
    // Escape closes the suggestions first, and the nested browser independently.
    await project.fill('a')
    await project.press('Escape')
    await expect(project).toHaveAttribute('aria-expanded', 'false')
    await page.getByRole('button', { name: 'Browse', exact: true }).click()
    await expect(dialog).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(page.getByRole('dialog', { name: 'New Session', exact: true })).toBeVisible()
    // Complete the real flow: the selected project becomes the tmux working directory.
    await project.fill(root + '/be')
    await expect(page.getByRole('option')).toHaveCount(1)
    await project.press('ArrowDown')
    await project.press('Enter')
    await expect(project).toHaveValue(root + '/beta')
    await page.getByRole('radio', { name: 'Custom', exact: true }).click()
    await page.getByPlaceholder('Enter command...').fill('cat')
    createdName = `picker-${phone ? 'phone' : 'desktop'}-${Date.now()}`
    await page.getByPlaceholder('auto-generated').fill(createdName)
    await page.getByRole('button', { name: 'Create', exact: true }).click()
    await expect.poll(async () => {
      const sessions: Array<{ name: string; projectPath: string }> = await (await request.get('/api/sessions')).json()
      return sessions.find(session => session.name === createdName)?.projectPath
    }).toBe(root + '/beta')
  })
}
