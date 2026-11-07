import { test, expect } from '@playwright/test'
import { Windows, installHarness, uniquePrefix, cardByName, desktopSidebar } from './helpers/sidebarHarness'

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: 'block' })

const windows = new Windows()
test.afterEach(() => windows.cleanup())

test('setting hides the peek, persists after reload, and can restore it', async ({ page }, testInfo) => {
  const prefix = uniquePrefix('peek-setting')
  const names = windows.createMany(prefix, 2)
  const harness = await installHarness(page, { prefix })
  await page.goto('/')
  await page.getByLabel('Open session menu', { exact: true }).tap()
  await cardByName(page.locator('.session-drawer'), names[0]).tap()
  const peek = page.getByTestId('session-peek')
  await expect(peek).toBeVisible()
  const openSettings = async () => {
    await page.getByLabel('More options', { exact: true }).tap()
    await page.getByRole('button', { name: 'Settings', exact: true }).filter({ visible: true }).tap()
    const section = page.locator('[role="dialog"][data-suspends-terminal]')
      .getByRole('button', { name: 'Session list', exact: true })
    if (await section.isVisible()) await section.tap()
  }
  await openSettings()
  const toggle = page.getByRole('switch', { name: 'Mobile session peek', exact: true })
  await expect(toggle).toBeChecked()
  await toggle.tap()
  await expect(toggle).not.toBeChecked()
  await expect(peek).toHaveCount(0)
  await page.screenshot({ path: testInfo.outputPath('peek-setting.png') })
  await page.keyboard.press('Escape')
  await page.reload()
  await expect(page.getByLabel('More options', { exact: true })).toBeVisible()
  await expect(peek).toHaveCount(0)
  expect(await page.locator('.xterm').evaluate(el => el.parentElement!.getBoundingClientRect().left)).toBe(0)
  await page.getByLabel('Open session menu', { exact: true }).tap()
  await expect(page.locator('.session-drawer.open')).toBeVisible()
  await page.keyboard.press('Escape')
  await openSettings()
  await expect(toggle).not.toBeChecked()
  await toggle.tap()
  await page.keyboard.press('Escape')
  await expect(peek).toBeVisible()
  expect(harness.puts.some(put => 'showMobileSessionPeek' in put)).toBe(false)
})

test('peek reserves 8px, opens without switching, and follows drawer selection', async ({ page }, testInfo) => {
  const prefix = uniquePrefix('peek')
  const names = windows.createMany(prefix, 4)
  const harness = await installHarness(page, {
    prefix,
    settings: { theme: 'dark' },
    sessionOverrides: {
      0: { status: 'working' }, 1: { status: 'waiting' },
      2: { status: 'permission' }, 3: { status: 'unknown' },
    },
  })
  await page.goto('/')
  const menu = page.getByRole('button', { name: 'Open session menu', exact: true })
  await menu.tap()
  const drawer = page.locator('.session-drawer')
  await cardByName(drawer, names[0]).tap()
  const peek = page.getByTestId('session-peek')
  await expect(peek).toBeVisible()
  await expect(peek.locator('[data-session-id]')).toHaveCount(4)
  await expect(peek).toHaveAccessibleDescription(/Working, current session.*Waiting.*Needs Input.*Unknown/)
  await expect(peek.locator('[data-selected="true"]')).toHaveAttribute('data-status', 'working')
  for (const status of ['working', 'waiting', 'permission', 'unknown']) {
    await expect(peek.locator(`[data-status="${status}"]`)).toHaveCount(1)
  }
  const geometry = async () => page.evaluate(() => {
    const rail = document.querySelector('[data-testid="session-peek"]')!.getBoundingClientRect()
    const terminal = document.querySelector('.xterm')!.parentElement!.getBoundingClientRect()
    return { width: rail.width, overlap: rail.right - terminal.left, top: rail.top - terminal.top }
  })
  await expect.poll(geometry).toEqual({ width: 8, overlap: 0, top: 0 })
  const originalId = await peek.locator('[data-selected="true"]').getAttribute('data-session-id')
  await peek.tap({ position: { x: 4, y: 75 } })
  await expect(drawer).toHaveClass(/open/)
  await expect(peek).toHaveAttribute('aria-expanded', 'true')
  await expect(peek.locator('[data-selected="true"]')).toHaveAttribute('data-session-id', originalId!)
  await cardByName(drawer, names[2]).tap()
  await expect(drawer).not.toHaveClass(/open/)
  await expect(peek.locator('[data-selected="true"]')).toHaveAttribute('data-status', 'permission')
  await menu.focus()
  await page.keyboard.press('Enter')
  await page.keyboard.press('Escape')
  await expect(drawer).not.toHaveClass(/open/)
  await expect(menu).toBeFocused()
  await peek.focus()
  await page.keyboard.press('Enter')
  await expect(drawer).toHaveClass(/open/)
  await page.keyboard.press('Escape')
  await expect(peek).toBeFocused()
  await expect(page.getByRole('status').filter({ hasText: 'Loading' })).toHaveCount(0)
  await page.screenshot({ path: testInfo.outputPath('mobile-peek-dark.png') })
  harness.settings.theme = 'light'
  await page.reload()
  await expect(peek).toBeVisible()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await expect(page.getByRole('status').filter({ hasText: 'Loading' })).toHaveCount(0)
  await page.screenshot({ path: testInfo.outputPath('mobile-peek-light.png') })
  await testInfo.attach('Mobile sidebar peek', { path: testInfo.outputPath('mobile-peek-light.png'), contentType: 'image/png' })
  await page.setViewportSize({ width: 320, height: 568 })
  await expect.poll(geometry).toEqual({ width: 8, overlap: 0, top: 0 })
  await page.setViewportSize({ width: 1280, height: 800 })
  await expect(peek).toBeHidden()
  await expect(desktopSidebar(page)).toBeVisible()
})

test('many sessions fit a short viewport and the selected marker stays visible', async ({ page }, testInfo) => {
  const prefix = uniquePrefix('dense-peek')
  const names = windows.createMany(prefix, 20)
  await installHarness(page, { prefix })
  await page.setViewportSize({ width: 390, height: 400 })
  await page.goto('/')
  await page.getByLabel('Open session menu', { exact: true }).tap()
  await cardByName(page.locator('.session-drawer'), names[19]).tap()
  const peek = page.getByTestId('session-peek')
  await expect(peek.locator('[data-session-id]')).toHaveCount(20)
  const fits = await peek.evaluate(el => {
    const r = el.getBoundingClientRect()
    return [...el.querySelectorAll('[data-session-id]')].every(segment => {
      const s = segment.getBoundingClientRect()
      return s.height > 2 && s.top >= r.top && s.bottom <= r.bottom
    })
  })
  expect(fits).toBe(true)
  await expect(peek.locator('[data-selected="true"]')).toBeVisible()
  await peek.tap({ position: { x: 4, y: 5 } })
  await expect(page.locator('.session-drawer.open .session-row.selected')).toBeInViewport()
  await page.keyboard.press('Escape')
  await page.screenshot({ path: testInfo.outputPath('mobile-peek-dense.png') })
})

test('one session uses the full terminal width and menu still opens', async ({ page }) => {
  const prefix = uniquePrefix('single-peek')
  const name = windows.create(prefix, 0)
  await installHarness(page, { prefix })
  await page.goto('/')
  await page.getByLabel('Open session menu', { exact: true }).tap()
  await cardByName(page.locator('.session-drawer'), name).tap()
  await expect(page.getByTestId('session-peek')).toHaveCount(0)
  await page.getByLabel('Open session menu', { exact: true }).tap()
  await expect(page.locator('.session-drawer.open')).toBeVisible()
})
