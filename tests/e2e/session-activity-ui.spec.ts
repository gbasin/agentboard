// UI edge cases use explicit synthetic activity; lifecycle coverage lives in
// session-activity.spec.ts and never injects activity frames.
import { test, expect, type Page } from '@playwright/test'
import { Windows, uniquePrefix, installHarness, shortcutChord } from './helpers/sidebarHarness'
import type { SessionActivity } from '../../src/shared/activity'

const data = (): SessionActivity => ({
  main: { phase: 'tool', label: 'Tool pending: exec', tools: ['exec'] },
  running: 2, blocked: 1, unknown: 1, total: 4, truncated: false,
  subagents: [
    { id: 'a', name: 'Review parser', activity: { phase: 'tool', label: 'Tool pending: Bash', tools: ['Bash'] } },
    { id: 'b', name: 'Research signals', activity: { phase: 'model', label: 'Model turn active', tools: [] } },
    { id: 'c', name: 'Permission audit', activity: { phase: 'blocked', label: 'Waiting for input', tools: ['AskUserQuestion'] } },
    { id: 'd', name: 'Interrupted worker', activity: { phase: 'unknown', label: 'No lifecycle signal for 15m', tools: [] } },
  ],
})
const windows = new Windows()
test.afterEach(() => windows.cleanup())
async function setup(page: Page, activity: SessionActivity | undefined = data()) {
  const prefix = uniquePrefix('act-ui-')
  const names = windows.createMany(prefix, 2)
  const current = { value: activity }
  const harness = await installHarness(page, {
    prefix, settings: { showProjectName: false, showLastUserMessage: false, sessionSortMode: 'created', theme: 'dark' },
    // Defer overrides until each WS frame is serialized, including pushSessions.
    sessionOverrides: { 0: () => ({ activity: { toJSON: () => current.value } }) },
  })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/')
  const isPhone = page.viewportSize()!.width < 640
  if (isPhone) {
    const desktopCard = page.locator('.session-drawer [data-testid="session-card"]').filter({ hasText: names[0] })
    await expect(desktopCard).toHaveCount(1)
    // The initial empty terminal exposes the menu; select a session only if
    // this layout requires a rail before the menu button appears.
    await page.getByLabel('Open session menu', { exact: true }).click()
    await expect.poll(async () => (await page.locator('.session-drawer.open').boundingBox())?.x ?? -999).toBeGreaterThanOrEqual(-1)
  }
  const cards = page.locator('[data-testid="session-card"]:visible')
  const card = cards.filter({ hasText: names[0] }).first()
  const other = cards.filter({ hasText: names[1] }).first()
  await expect(card).toBeVisible()
  return { card, other, current, harness }
}
const popup = (page: Page) => page.getByTestId('session-activity-popover')
async function activate(page: Page, locator: import('@playwright/test').Locator) {
  if (test.info().project.use.hasTouch) await locator.tap()
  else await locator.click()
}

test('counter adds no height; click/tap opens details without selection or row movement', async ({ page }, info) => {
  const { card, other } = await setup(page)
  const before = (await card.boundingBox())!, nextBefore = (await other.boundingBox())!
  expect(before.height).toBeCloseTo(nextBefore.height, 2)
  const trigger = card.getByTestId('session-activity-counter')
  await expect(trigger).toHaveText('2?')
  await expect(trigger.getByTestId('activity-attention')).toBeVisible()
  await expect(trigger).toHaveAttribute('aria-label', /2 running, 1 awaiting input, 1 unknown/)
  await expect(trigger).toHaveAttribute('aria-expanded', 'false')
  const wasSelected = (await card.getAttribute('class'))!.split(' ').includes('selected')
  await activate(page, trigger)
  await expect(popup(page)).toBeVisible()
  expect((await card.getAttribute('class'))!.split(' ').includes('selected')).toBe(wasSelected)
  expect((await card.boundingBox())!.height).toBeCloseTo(before.height, 2)
  expect((await other.boundingBox())!.y).toBeCloseTo(nextBefore.y, 2)
  const box = (await popup(page).boundingBox())!
  expect(box.x).toBeGreaterThanOrEqual(0)
  expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize()!.width)
  expect(box.y + box.height).toBeLessThanOrEqual(page.viewportSize()!.height)
  await expect(popup(page)).toContainText('Waiting for input')
  await expect(popup(page)).toContainText('No lifecycle signal for 15m')
  await info.attach('layout-and-selection', { body: JSON.stringify({ before, after: await card.boundingBox(), nextBefore, nextAfter: await other.boundingBox(), popup: box, wasSelected, stillSelected: (await card.getAttribute('class'))!.split(' ').includes('selected') }, null, 2), contentType: 'application/json' })
  await page.screenshot({ path: info.outputPath('counter-popover.png') })
  if (test.info().project.use.hasTouch) {
    const hitArea = await trigger.evaluate(el => getComputedStyle(el, '::after').height)
    expect(hitArea).toBe('44px')
    expect(await card.getByTestId('session-activity-status').evaluate(el => getComputedStyle(el, '::after').height)).toBe('44px')
  }
  await activate(page, popup(page).getByRole('button', { name: 'Close activity' }))
  await expect(popup(page)).toBeHidden()
  await expect(trigger).toBeFocused()
})

test('keyboard opens, Escape dismisses and restores focus; outside input keeps focus', async ({ page }) => {
  test.skip(Boolean(test.info().project.use.hasTouch), 'Keyboard path is covered by both desktop engines')
  const { card } = await setup(page)
  const trigger = card.getByTestId('session-activity-counter')
  await trigger.focus(); await page.keyboard.press('Enter')
  await expect(popup(page)).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(popup(page)).toBeHidden(); await expect(trigger).toBeFocused()
  await page.keyboard.press('Space')
  await expect(popup(page)).toBeVisible()
  // A real outside input establishes a definite focus destination.
  await page.evaluate(() => {
    const input = document.createElement('input'); input.id = 'outside-focus'; input.setAttribute('aria-label', 'Outside input')
    input.style.cssText = 'position:fixed;right:12px;bottom:12px;width:100px;height:35px;z-index:100'; document.body.append(input)
  })
  await page.getByLabel('Outside input').click()
  await expect(popup(page)).toBeHidden()
  await expect(page.getByLabel('Outside input')).toBeFocused()
})

test('live updates preserve the open panel; completed and main-only sessions use the existing status pill', async ({ page }) => {
  const { card, current, harness } = await setup(page)
  await activate(page, card.getByTestId('session-activity-counter'))
  current.value = { ...data(), running: 0, blocked: 0, unknown: 0 }
  harness.pushSessions()
  await expect(popup(page)).toContainText('0 running')
  await expect(card.getByTestId('session-activity-counter')).toHaveText('0')
  await activate(page, popup(page).getByRole('button', { name: 'Close activity' }))
  await expect(card.getByTestId('session-activity-counter')).toHaveCount(0)
  current.value = { ...data(), running: 0, blocked: 0, unknown: 0, total: 0, subagents: [] }
  harness.pushSessions()
  await activate(page, card.getByTestId('session-activity-status'))
  await expect(popup(page)).toContainText('Main session')
  await expect(popup(page)).toContainText('Tool pending: exec')
  await expect(card.getByTestId('session-activity-counter')).toHaveCount(0)
  current.value = undefined; harness.pushSessions()
  await expect(popup(page)).toBeHidden()
  await expect(card.getByTestId('session-activity-status')).toHaveCount(0)
  current.value = data(); harness.pushSessions()
  await expect(card.getByTestId('session-activity-counter')).toBeVisible()
  await expect(popup(page)).toBeHidden()
})

test('long content, limited details, light theme and short viewport stay bounded and scrollable', async ({ page }, info) => {
  const many = data()
  many.running = 50; many.total = 70; many.truncated = true
  many.subagents = Array.from({ length: 40 }, (_, i) => ({ id: String(i), name: i ? `Reviewer ${i}` : 'LongUnbrokenName'.repeat(20), activity: { phase: 'tool' as const, label: 'Tool pending: ' + 'very-long-name'.repeat(10), tools: ['Bash'] } }))
  const { card } = await setup(page, many)
  await page.evaluate(() => { document.documentElement.setAttribute('data-theme', 'light') })
  if (page.viewportSize()!.width > 640) await page.setViewportSize({ width: 1024, height: 360 })
  await activate(page, card.getByTestId('session-activity-counter'))
  await expect(popup(page)).toContainText('Showing 40 of 70')
  const bounded = await popup(page).evaluate(el => ({ width: el.clientWidth, scrollWidth: el.scrollWidth, height: el.clientHeight, scrollHeight: el.scrollHeight }))
  expect(bounded.scrollWidth).toBeLessThanOrEqual(bounded.width + 1)
  expect(bounded.scrollHeight).toBeGreaterThan(bounded.height)
  const rect = (await popup(page).boundingBox())!
  expect(rect.y).toBeGreaterThanOrEqual(0)
  expect(rect.y + rect.height).toBeLessThanOrEqual(page.viewportSize()!.height)
  await popup(page).evaluate(el => { el.scrollTop = el.scrollHeight })
  await page.screenshot({ path: info.outputPath('light-short-viewport.png') })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})


test('global navigation shortcuts work from the counter and the open popover', async ({ page }) => {
  test.skip(Boolean(test.info().project.use.hasTouch), 'Global keyboard shortcuts are a desktop interaction')
  const { card, other } = await setup(page)
  const trigger = card.getByTestId('session-activity-counter')
  const chord = await shortcutChord(page)
  await trigger.focus()
  await page.keyboard.press(`${chord}+]`)
  await expect(card).toHaveClass(/selected/)
  // Let the explicitly requested terminal attach finish its focus handoff.
  await expect(page.getByTestId('terminal-recovery-status')).toBeHidden({ timeout: 15000 })
  await expect(page.locator('.xterm-helper-textarea')).toBeFocused({ timeout: 15000 })
  await trigger.click()
  await expect(popup(page)).toBeVisible()
  await page.keyboard.press(`${chord}+]`)
  await expect(other).toHaveClass(/selected/)
})
