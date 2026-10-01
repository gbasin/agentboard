// E2E: the session list's filter button (funnel) and its menu.
//
// One funnel button replaces the old project/host dropdowns. Idle it is a
// plain 28px icon button; with filters applied it carries a count badge.
// Its menu must open toward the list (down under the top anchor, up under
// the bottom anchor) and stay inside the sidebar and the viewport at the
// default and minimum sidebar widths. The mobile drawer renders the same
// list, so the same control is driven there with real touch events.
//
// Projects are real directories under the e2e temp dir (window cwds), so
// no real project names reach the page. Synced settings (anchor, filters)
// live in the harness's in-test store.
import { mkdirSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect, type Locator, type Page } from '@playwright/test'
import {
  Windows,
  box,
  cardByName,
  desktopSidebar,
  installHarness,
  uniquePrefix,
  type Box,
} from './helpers/sidebarHarness'

test.use({ serviceWorkers: 'block' })

const DISCOVERY = { timeout: 30_000 }
test.describe.configure({ timeout: 90_000 })

const windows = new Windows()
test.afterEach(() => windows.cleanup())

const ANCHORS = ['top', 'bottom'] as const
type Anchor = (typeof ANCHORS)[number]
const PROJECTS = ['alpha', 'bravo', 'charlie'] as const

function projectDir(name: string): string {
  const dir = join(process.env.E2E_TMUX_TMPDIR || tmpdir(), 'projects', name)
  mkdirSync(dir, { recursive: true })
  // The server reports window cwds resolved (/var -> /private/var on macOS).
  return realpathSync(dir)
}

/** Persist a local (non-synced) sidebar width before the app boots. */
async function useSidebarWidth(page: Page, width: number) {
  await page.addInitScript((w) => {
    const key = 'agentboard-settings'
    let stored: { state?: Record<string, unknown>; version?: number } = {}
    try {
      stored = JSON.parse(localStorage.getItem(key) ?? '{}')
    } catch {
      stored = {}
    }
    stored.state = { ...stored.state, sidebarWidth: w }
    stored.version ??= 8
    localStorage.setItem(key, JSON.stringify(stored))
  }, width)
}

/** One window per project (alpha, bravo, charlie), cwd in that project. */
async function openBoard(
  page: Page,
  options: { anchor?: Anchor; width?: number; settings?: Record<string, unknown> } = {}
) {
  const prefix = uniquePrefix('flt')
  const dirs = PROJECTS.map((name) => projectDir(`${prefix}${name}`))
  const names = windows.createMany(prefix, PROJECTS.length, (i) => dirs[i])
  if (options.width) await useSidebarWidth(page, options.width)
  const harness = await installHarness(page, {
    prefix,
    settings: { sidebarAnchor: options.anchor ?? 'top', ...options.settings },
  })
  await page.goto('/')
  return { prefix, dirs, names, harness }
}

const funnel = (scope: Locator) => scope.getByRole('button', { name: /^Filter\b/ })
const menuOf = (scope: Locator) => scope.getByRole('menu', { name: 'Filter sessions' })
const badgeOf = (scope: Locator) => scope.getByTestId('filter-count-badge')

function inside(inner: Box, outer: Box, slack = 0.5) {
  return (
    inner.left >= outer.left - slack &&
    inner.right <= outer.right + slack &&
    inner.top >= outer.top - slack &&
    inner.bottom <= outer.bottom + slack
  )
}

/** True when the element is topmost at its center and at all four corners. */
async function unoccluded(locator: Locator): Promise<boolean> {
  return locator.evaluate((el) => {
    const r = el.getBoundingClientRect()
    const points = [
      [r.left + r.width / 2, r.top + r.height / 2],
      [r.left + 2, r.top + 2],
      [r.right - 2, r.top + 2],
      [r.left + 2, r.bottom - 2],
      [r.right - 2, r.bottom - 2],
    ]
    return points.every(([x, y]) => {
      const hit = document.elementFromPoint(x, y)
      return !!hit && el.contains(hit)
    })
  })
}

for (const anchor of ANCHORS) {
  for (const width of [240, 180]) {
    test(`${anchor} @${width}px: the menu opens ${anchor === 'top' ? 'down' : 'up'}, inside sidebar and viewport`, async ({
      page,
    }) => {
      const { prefix } = await openBoard(page, { anchor, width })
      const sidebar = desktopSidebar(page)
      await expect(sidebar.getByTestId('session-card')).toHaveCount(3, DISCOVERY)
      await expect
        .poll(async () => {
          const b = await box(sidebar)
          return Math.round(b.right - b.left)
        })
        .toBe(width)

      const button = funnel(sidebar)
      await expect(button).toHaveAttribute('aria-label', 'Filter')
      await expect(button).toHaveAttribute('title', 'Filter')
      await expect(badgeOf(sidebar)).toHaveCount(0)
      await button.click()
      const menu = menuOf(sidebar)
      await expect(menu).toBeVisible()
      await expect(button).toHaveAttribute('aria-expanded', 'true')
      for (const name of PROJECTS) {
        await expect(menu.getByText(`${prefix}${name}`)).toBeVisible()
      }
      // No remote hosts: projects only.
      await expect(menu.getByText('Projects', { exact: true })).toBeVisible()
      await expect(menu.getByText('Hosts', { exact: true })).toHaveCount(0)

      const opened = await box(menu)
      const trigger = await box(button)
      const side = await box(sidebar)
      const vh = await page.evaluate(() => window.innerHeight)
      if (anchor === 'top') {
        expect(opened.top).toBeGreaterThanOrEqual(trigger.bottom)
      } else {
        expect(opened.bottom).toBeLessThanOrEqual(trigger.top)
      }
      expect(opened.top).toBeGreaterThanOrEqual(0)
      expect(opened.bottom).toBeLessThanOrEqual(vh)
      expect(inside(opened, side)).toBe(true)
      // Not clipped by the scroll container or covered by rows/bars.
      expect(await unoccluded(menu)).toBe(true)
      expect(await menu.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)

      await page.keyboard.press('Escape')
      await expect(menu).toHaveCount(0)
    })
  }
}

test('filtering by project hides other sessions; badge counts; Clear all restores', async ({
  page,
}) => {
  const { prefix, dirs, names, harness } = await openBoard(page)
  const sidebar = desktopSidebar(page)
  await expect(sidebar.getByTestId('session-card')).toHaveCount(3, DISCOVERY)
  const button = funnel(sidebar)

  await button.click()
  const menu = menuOf(sidebar)
  await menu.getByRole('menuitemcheckbox', { name: `${prefix}alpha` }).click()
  await expect(sidebar.getByTestId('session-card')).toHaveCount(1)
  await expect(cardByName(sidebar, names[0])).toBeVisible()
  await expect(badgeOf(sidebar)).toHaveText('1')
  await expect(button).toHaveAttribute('aria-label', 'Filter, 1 active filter')
  await expect(button).toHaveAttribute('title', `Filtered by Projects: ${prefix}alpha`)
  // The active funnel is accent-colored, unlike the idle neutral gear.
  const [funnelColor, gearColor] = await Promise.all([
    button.evaluate((el) => getComputedStyle(el).color),
    sidebar.getByRole('button', { name: 'Settings', exact: true }).evaluate((el) => getComputedStyle(el).color),
  ])
  expect(funnelColor).not.toBe(gearColor)

  await menu.getByRole('menuitemcheckbox', { name: `${prefix}charlie` }).click()
  await expect(sidebar.getByTestId('session-card')).toHaveCount(2)
  await expect(badgeOf(sidebar)).toHaveText('2')
  await expect(button).toHaveAttribute('aria-label', 'Filter, 2 active filters')
  // Filter state syncs exactly as before: the full selection, in list order.
  await expect
    .poll(() => harness.puts.filter((put) => 'projectFilters' in put).at(-1)?.projectFilters)
    .toEqual([dirs[0], dirs[2]])

  await menu.getByRole('menuitem', { name: 'Clear all' }).click()
  await expect(sidebar.getByTestId('session-card')).toHaveCount(3)
  await expect(badgeOf(sidebar)).toHaveCount(0)
  await expect(button).toHaveAttribute('aria-label', 'Filter')
  await expect(menu.getByRole('menuitem', { name: 'Clear all' })).toBeDisabled()
})

test.describe('mobile drawer', () => {
  test.use({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
  })

  /** Tap with real CDP touch events (Playwright's tap() pans the key deck). */
  async function touchTap(page: Page, locator: Locator) {
    const b = await box(locator)
    const x = (b.left + b.right) / 2
    const y = (b.top + b.bottom) / 2
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x, y }],
    })
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await cdp.detach()
  }

  test('the funnel works by touch in the drawer and has a 44px target', async ({ page }) => {
    const { prefix, names } = await openBoard(page, { anchor: 'bottom' })
    const drawer = page.locator('.session-drawer')
    await expect(drawer.getByTestId('session-card')).toHaveCount(3, DISCOVERY)
    await touchTap(page, page.getByLabel('Open session menu'))
    await expect(page.locator('.session-drawer.open')).toBeVisible()
    // Wait out the slide-in transition before measuring hit targets.
    await expect.poll(async () => (await box(drawer)).left).toBeGreaterThanOrEqual(-0.5)

    const button = funnel(drawer)
    // The visible control stays small (h-7: 22.75px at the app's 13px root);
    // its touch target is 44x44 CSS px.
    const visible = await box(button)
    expect(visible.height).toBeLessThan(30)
    const hit = await button.evaluate((el) => {
      const r = el.getBoundingClientRect()
      const cx = r.left + r.width / 2
      const cy = r.top + r.height / 2
      const hits = (x: number, y: number) => {
        const target = document.elementFromPoint(x, y)
        return !!target && el.contains(target)
      }
      // The bar sits at the viewport's top edge here (no safe-area inset),
      // so the upward reach is read from the hit-area box, not probed.
      const before = getComputedStyle(el, '::before')
      return {
        coarse: window.matchMedia('(pointer: coarse)').matches,
        reach: [hits(cx - 21.5, cy), hits(cx + 21.5, cy), hits(cx, cy + 21.5)],
        target: [before.position, before.width, before.height],
      }
    })
    expect(hit.coarse).toBe(true)
    expect(hit.reach).toEqual([true, true, true])
    expect(hit.target).toEqual(['absolute', '44px', '44px'])

    // The drawer ignores the bottom anchor: the menu opens downward.
    await touchTap(page, button)
    const menu = menuOf(drawer)
    await expect(menu).toBeVisible()
    const opened = await box(menu)
    expect(opened.top).toBeGreaterThanOrEqual(visible.bottom)
    expect(inside(opened, await box(drawer))).toBe(true)
    expect(await unoccluded(menu)).toBe(true)

    await touchTap(page, menu.getByRole('menuitemcheckbox', { name: `${prefix}bravo` }))
    await expect(drawer.getByTestId('session-card')).toHaveCount(1)
    await expect(cardByName(drawer, names[1])).toBeVisible()
    await expect(badgeOf(drawer)).toHaveText('1')

    await touchTap(page, menu.getByRole('menuitem', { name: 'Clear all' }))
    await expect(drawer.getByTestId('session-card')).toHaveCount(3)
    await expect(badgeOf(drawer)).toHaveCount(0)
  })
})
