// E2E: the session list's filter button (funnel) and its menu.
//
// One funnel button replaces the old project/host dropdowns. Idle it is a
// plain 28px icon button; with filters applied it carries a count badge.
// Its menu must open toward the list (down under the top anchor, up under
// the bottom anchor) and stay inside the sidebar and the viewport at the
// default and minimum sidebar widths. The mobile drawer renders the same
// list, so the same control is driven there with real touch events.
//
// There is no "All projects" row: nothing ticked means no filter, which the
// menu's pinned summary line says, and "Show all" resets in one click. With
// 30 projects only the checklist scrolls; the summary and Show all stay put.
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
/** A long project list: the menu must scroll its checklist, not grow. */
const MANY_PROJECTS = Array.from({ length: 30 }, (_, i) => `p${String(i).padStart(2, '0')}`)
const IDLE_HINT = 'Showing all. Tick to narrow.'

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

/** One window per project (alpha, bravo, charlie by default), cwd in it. */
async function openBoard(
  page: Page,
  options: {
    anchor?: Anchor
    width?: number
    settings?: Record<string, unknown>
    projects?: readonly string[]
  } = {}
) {
  const prefix = uniquePrefix('flt')
  const projects = options.projects ?? PROJECTS
  const dirs = projects.map((name) => projectDir(`${prefix}${name}`))
  const names = windows.createMany(prefix, projects.length, (i) => dirs[i])
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
const summaryOf = (scope: Locator) => scope.getByTestId('filter-summary')
const showAllOf = (scope: Locator) => scope.getByRole('menuitem', { name: 'Show all' })

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
      // No remote hosts: projects only, and no "All projects" row.
      await expect(menu.getByText('Projects', { exact: true })).toBeVisible()
      await expect(menu.getByText('Hosts', { exact: true })).toHaveCount(0)
      await expect(menu.getByRole('menuitemcheckbox')).toHaveCount(PROJECTS.length)
      await expect(summaryOf(menu)).toHaveText(IDLE_HINT)
      await expect(showAllOf(menu)).toBeDisabled()

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

test('filtering by project hides other sessions; badge and summary count; Show all restores', async ({
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
  await expect(summaryOf(menu)).toHaveText('1 selected')
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
  await expect(summaryOf(menu)).toHaveText('2 selected')
  // Filter state syncs exactly as before: the full selection, in list order.
  await expect
    .poll(() => harness.puts.filter((put) => 'projectFilters' in put).at(-1)?.projectFilters)
    .toEqual([dirs[0], dirs[2]])

  await showAllOf(menu).click()
  await expect(sidebar.getByTestId('session-card')).toHaveCount(3)
  await expect(badgeOf(sidebar)).toHaveCount(0)
  await expect(button).toHaveAttribute('aria-label', 'Filter')
  await expect(showAllOf(menu)).toBeDisabled()
  await expect(summaryOf(menu)).toHaveText(IDLE_HINT)
  // An empty selection is synced as "no filter", exactly as before.
  await expect
    .poll(() => harness.puts.filter((put) => 'projectFilters' in put).at(-1)?.projectFilters)
    .toEqual([])
})

/**
 * With 30 projects the checklist scrolls inside the menu; the menu stays in
 * the viewport and the sidebar, and the summary line and Show all stay
 * visible (pinned outside the scroll region) at both ends of the list.
 */
async function expectLongMenuUsable(
  page: Page,
  scope: Locator,
  menu: Locator,
  /** The hint is one line; at the 180px minimum width it may wrap once. */
  maxSummaryLines = 1
) {
  const options = menu.getByTestId('filter-options')
  const summary = summaryOf(menu)
  const showAll = showAllOf(menu)
  const vh = await page.evaluate(() => window.innerHeight)
  const opened = await box(menu)
  expect(opened.top).toBeGreaterThanOrEqual(0)
  expect(opened.bottom).toBeLessThanOrEqual(vh)
  expect(inside(opened, await box(scope))).toBe(true)
  expect(await unoccluded(menu)).toBe(true)
  expect(await menu.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)
  // The list overflows its own scroll region, not the menu.
  expect(await options.evaluate((el) => el.scrollHeight > el.clientHeight + 20)).toBe(true)
  expect(await menu.evaluate((el) => el.scrollHeight <= el.clientHeight + 1)).toBe(true)
  // The summary stays short: one line (two at the minimum sidebar width).
  const summaryLines = await summary.evaluate((el) => {
    const lineHeight = Number.parseFloat(getComputedStyle(el).lineHeight)
    const style = getComputedStyle(el)
    const content =
      el.clientHeight - Number.parseFloat(style.paddingTop) - Number.parseFloat(style.paddingBottom)
    return Math.round(content / lineHeight)
  })
  expect(summaryLines).toBeGreaterThanOrEqual(1)
  expect(summaryLines).toBeLessThanOrEqual(maxSummaryLines)
  for (const position of ['top', 'bottom'] as const) {
    await options.evaluate((el, pos) => {
      el.scrollTop = pos === 'top' ? 0 : el.scrollHeight
    }, position)
    for (const pinned of [summary, showAll]) {
      await expect(pinned).toBeVisible()
      expect(inside(await box(pinned), opened)).toBe(true)
      expect(await unoccluded(pinned)).toBe(true)
    }
  }
}

for (const anchor of ANCHORS) {
  for (const width of [240, 180]) {
    test(`${anchor} @${width}px: 30 projects scroll inside the menu; summary and Show all stay visible`, async ({
      page,
    }) => {
      const { prefix } = await openBoard(page, { anchor, width, projects: MANY_PROJECTS })
      const sidebar = desktopSidebar(page)
      await expect(sidebar.getByTestId('session-card')).toHaveCount(MANY_PROJECTS.length, DISCOVERY)
      await funnel(sidebar).click()
      const menu = menuOf(sidebar)
      await expect(menu).toBeVisible()
      await expect(menu.getByRole('menuitemcheckbox')).toHaveCount(MANY_PROJECTS.length)
      await expect(summaryOf(menu)).toHaveText(IDLE_HINT)
      await expectLongMenuUsable(page, sidebar, menu, width === 180 ? 2 : 1)

      // Tick the last project (scrolled into view), then reset in one click.
      const last = menu.getByRole('menuitemcheckbox', { name: `${prefix}p29` })
      await last.click()
      await expect(sidebar.getByTestId('session-card')).toHaveCount(1)
      await expect(summaryOf(menu)).toHaveText('1 selected')
      await expectLongMenuUsable(page, sidebar, menu, 1)
      await showAllOf(menu).click()
      await expect(sidebar.getByTestId('session-card')).toHaveCount(MANY_PROJECTS.length)
      await expect(summaryOf(menu)).toHaveText(IDLE_HINT)
    })
  }
}

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

    await expect(summaryOf(menu)).toHaveText('1 selected')
    await touchTap(page, showAllOf(menu))
    await expect(drawer.getByTestId('session-card')).toHaveCount(3)
    await expect(badgeOf(drawer)).toHaveCount(0)
    await expect(summaryOf(menu)).toHaveText(IDLE_HINT)
  })

  test('30 projects: the drawer menu scrolls its list and keeps Show all reachable', async ({
    page,
  }) => {
    const { prefix } = await openBoard(page, { projects: MANY_PROJECTS })
    const drawer = page.locator('.session-drawer')
    await expect(drawer.getByTestId('session-card')).toHaveCount(MANY_PROJECTS.length, DISCOVERY)
    await touchTap(page, page.getByLabel('Open session menu'))
    await expect(page.locator('.session-drawer.open')).toBeVisible()
    await expect.poll(async () => (await box(drawer)).left).toBeGreaterThanOrEqual(-0.5)

    await touchTap(page, funnel(drawer))
    const menu = menuOf(drawer)
    await expect(menu).toBeVisible()
    await expectLongMenuUsable(page, drawer, menu)

    // Projects are listed most-recently-active first, so live activity can
    // reorder rows; bring the target into view right before the touch and
    // assert on the outcome (one project ticked), not on which row it was.
    const last = menu.getByRole('menuitemcheckbox', { name: `${prefix}p29` })
    await last.evaluate((el) => el.scrollIntoView({ block: 'nearest' }))
    await touchTap(page, last)
    await expect(menu.locator('[role="menuitemcheckbox"][aria-checked="true"]')).toHaveCount(1)
    await expect(drawer.getByTestId('session-card')).toHaveCount(1)
    await expect(summaryOf(menu)).toHaveText('1 selected')
    await touchTap(page, showAllOf(menu))
    await expect(drawer.getByTestId('session-card')).toHaveCount(MANY_PROJECTS.length)
  })
})
