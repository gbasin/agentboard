// Exercise the real settings switch, persisted preference and responsive geometry.
import { test, expect } from '@playwright/test'
import { Windows, installHarness, uniquePrefix, cardByName } from './helpers/sidebarHarness'

test.use({ isMobile: true, hasTouch: true, serviceWorkers: 'block' })
const windows = new Windows()
test.afterEach(() => windows.cleanup())

for (const width of [320, 390, 430]) {
  test(`compact controls apply live and persist at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 844 })
    const prefix = uniquePrefix('compact')
    const [name] = windows.createMany(prefix, 1)
    const harness = await installHarness(page, { prefix })
    await page.goto('/')
    await page.getByLabel('Open session menu', { exact: true }).tap()
    await cardByName(page.locator('.session-drawer'), name).tap()
    const menu = page.getByLabel('Open session menu', { exact: true })
    const enter = page.getByRole('button', { name: 'Enter', exact: true })
    const terminal = page.locator('.xterm')
    const height = () => terminal.evaluate(el => el.parentElement!.getBoundingClientRect().height)
    await expect(enter).toBeEnabled()
    const compactHeight = await height()
    const assertSize = async (size: number) => {
      for (const control of [menu, enter, page.getByRole('button', { name: 'Shift', exact: true })]) {
        await expect.poll(async () => {
          const box = (await control.boundingBox())!
          return [box.width, box.height]
        }).toEqual([size, size])
      }
    }
    await assertSize(36)
    await page.screenshot({ path: testInfo.outputPath(`compact-default-${width}.png`) })
    const openSettings = async () => {
      await page.getByLabel('More options', { exact: true }).tap()
      await page.getByRole('button', { name: 'Settings', exact: true }).filter({ visible: true }).tap()
      const appearance = page.locator('[role="dialog"][data-suspends-terminal]')
        .getByRole('button', { name: 'Appearance', exact: true })
      if (await appearance.isVisible()) await appearance.tap()
    }
    await openSettings()
    const toggle = page.getByRole('switch', { name: 'Compact mobile controls', exact: true })
    await expect(toggle).toBeChecked()
    await toggle.tap()
    await expect(toggle).not.toBeChecked()
    await assertSize(44)
    await page.screenshot({ path: testInfo.outputPath(`setting-${width}.png`) })
    await page.keyboard.press('Escape')
    await expect.poll(height).toBe(compactHeight - 20)
    await page.screenshot({ path: testInfo.outputPath(`comfortable-${width}.png`) })
    await page.reload()
    await expect(enter).toBeEnabled()
    await assertSize(44)
    expect(harness.puts.some(put => 'compactMobileControls' in put)).toBe(false)
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width)

    // The header and quick row still open their menus at either density.
    await menu.tap()
    await expect(page.locator('.session-drawer.open')).toBeVisible()
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: 'Arrow keys', exact: true }).tap()
    await expect(page.getByRole('button', { name: 'Arrow up', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Arrow keys', exact: true }).tap()

    // The preference has no effect at the desktop breakpoint.
    await page.setViewportSize({ width: 1000, height: 844 })
    await expect(menu).toBeHidden()
    await expect(page.locator('.terminal-controls')).toBeHidden()
    await page.setViewportSize({ width, height: 844 })
    await openSettings()
    await expect(toggle).not.toBeChecked()
    await toggle.tap()
    await page.keyboard.press('Escape')
    await assertSize(36)
    await expect.poll(height).toBe(compactHeight)
  })
}
