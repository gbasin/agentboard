// E2E: the settings dialog's real-DOM behaviour that unit tests (react-test-
// renderer, no DOM) cannot exercise: mousedown-before-click blur ordering on
// Discard, commit-on-unmount when the dialog closes by shortcut, search, and
// the phone drill-down layout. The harness isolates each test to its own
// tmux windows and an in-test synced-settings store, so nothing here reaches
// the shared e2e server's real settings.
import { test, expect, type Page } from '@playwright/test'
import {
  Windows,
  desktopSidebar,
  installHarness,
  shortcutChord,
  uniquePrefix,
  type Harness,
} from './helpers/sidebarHarness'

test.use({ serviceWorkers: 'block' })

const DISCOVERY = { timeout: 30_000 }
test.describe.configure({ timeout: 90_000 })

const windows = new Windows()
test.afterEach(() => windows.cleanup())

const dialog = (page: Page) => page.getByRole('dialog', { name: 'Settings' })
const addPreset = (page: Page) => dialog(page).getByRole('button', { name: 'Add preset' })

/** Boot the board with two windows and open settings from the gear. */
async function openSettings(page: Page): Promise<Harness> {
  const prefix = uniquePrefix('set')
  windows.createMany(prefix, 2)
  const harness = await installHarness(page, { prefix })
  await page.goto('/')
  const sidebar = desktopSidebar(page)
  await expect(sidebar.getByTestId('session-card')).toHaveCount(2, DISCOVERY)
  await sidebar.getByRole('button', { name: 'Settings', exact: true }).click()
  await expect(dialog(page)).toBeVisible()
  return harness
}

function pushedPresets(harness: Harness): string[] {
  return harness.puts.flatMap((put) => {
    const presets = put.commandPresets
    return Array.isArray(presets) ? presets.map((p) => String((p as { label: string }).label)) : []
  })
}

test('Discard with the cursor still in the command field throws the preset away', async ({ page }) => {
  const harness = await openSettings(page)
  await dialog(page).getByRole('tab', { name: 'New sessions', exact: true }).click()
  await addPreset(page).click()

  const name = dialog(page).getByRole('textbox', { name: /^Name of preset/ })
  await name.last().fill('Oops')
  await name.last().press('Tab')
  const command = dialog(page).getByRole('textbox', { name: 'Command for Oops' })
  await command.fill('oops --go')
  await expect(command).toBeFocused()

  // The real mousedown→blur→click ordering is what matters here.
  await dialog(page).getByRole('button', { name: 'Discard new preset' }).click()
  await expect(dialog(page).getByRole('textbox', { name: 'Command for Oops' })).toHaveCount(0)
  await expect(addPreset(page)).toBeEnabled()
  await expect(addPreset(page)).toBeFocused()

  // Give the 200ms sync debounce a chance to push, then assert it did not.
  await page.waitForTimeout(400)
  expect(pushedPresets(harness)).not.toContain('Oops')
})

test('a text field still being typed in commits when the dialog closes by shortcut', async ({ page }) => {
  const harness = await openSettings(page)
  await dialog(page).getByRole('tab', { name: 'New sessions', exact: true }).click()
  const dir = dialog(page).getByRole('textbox', { name: 'Default project directory' })
  await dir.fill('/tmp/e2e-settings-dir')
  await expect(dir).toBeFocused()

  await page.keyboard.press(`${await shortcutChord(page)}+Comma`)
  await expect(dialog(page)).toHaveCount(0)
  await expect
    .poll(() => harness.puts.some((put) => put.defaultProjectDir === '/tmp/e2e-settings-dir'))
    .toBe(true)

  await page.reload()
  await expect(desktopSidebar(page).getByTestId('session-card')).toHaveCount(2, DISCOVERY)
  await page.keyboard.press(`${await shortcutChord(page)}+Comma`)
  await expect(dialog(page).getByRole('textbox', { name: 'Default project directory' })).toHaveValue(
    '/tmp/e2e-settings-dir'
  )
})

test('search filters rows across pages and shows an empty state', async ({ page }) => {
  await openSettings(page)
  const search = dialog(page).getByRole('searchbox', { name: 'Search settings' })
  await search.fill('font')
  const results = dialog(page).getByRole('region', { name: 'Search results' })
  await expect(results.getByRole('heading', { name: 'Appearance' })).toBeVisible()
  await expect(results.getByText('Font family', { exact: true })).toBeVisible()
  await expect(results.getByText('Sort order', { exact: true })).toHaveCount(0)

  await search.fill('zzzz')
  await expect(dialog(page).getByText(/No settings match/)).toBeVisible()

  // Escape clears the query before it closes the dialog.
  await page.keyboard.press('Escape')
  await expect(search).toHaveValue('')
  await expect(dialog(page)).toBeVisible()
})

test.describe('phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })

  test('settings is a page list that drills into pages with no horizontal overflow', async ({ page }) => {
    const prefix = uniquePrefix('setm')
    const [name] = windows.createMany(prefix, 1)
    await installHarness(page, { prefix })
    await page.goto('/')
    // The session list lives in a drawer on phones: the card is attached
    // but hidden, so select it with a DOM click.
    const card = page.getByTestId('session-card').filter({ hasText: name }).first()
    await card.waitFor({ state: 'attached', ...DISCOVERY })
    await card.evaluate((el) => (el as HTMLElement).click())
    await page.getByRole('button', { name: 'More options' }).click()
    // The gear (hidden desktop sidebar, closed drawer) shares the name; only
    // the menu item is visible now.
    await page.getByRole('button', { name: 'Settings', exact: true }).locator('visible=true').click()

    // The phone dialog is labelled by its header, which becomes the page
    // name once drilled in, so match it by its terminal-lock marker.
    const settings = page.locator('[role="dialog"][data-suspends-terminal]')
    await expect(settings.getByRole('heading', { name: 'Settings' })).toBeVisible()
    await expect(settings.getByRole('button', { name: 'Back to settings' })).toHaveCount(0)

    const noOverflow = async () =>
      page.evaluate(() => {
        const doc = document.documentElement
        const panel = document.getElementById('settings-panel')
        return (
          doc.scrollWidth <= doc.clientWidth &&
          (!panel || panel.scrollWidth <= panel.clientWidth)
        )
      })

    for (const pageName of ['New sessions', 'Session list', 'Appearance', 'Terminal', 'Notifications']) {
      await settings.getByRole('button', { name: pageName, exact: true }).click()
      await expect(settings.getByRole('heading', { name: pageName })).toBeVisible()
      const back = settings.getByRole('button', { name: 'Back to settings' })
      await expect(back).toBeVisible()
      expect(await noOverflow(), `${pageName} overflows horizontally`).toBe(true)
      await back.click()
      await expect(settings.getByRole('heading', { name: 'Settings' })).toBeVisible()
    }
  })
})
