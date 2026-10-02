// E2E: the session list's filter button (funnel) and its menu.
//
// One funnel button replaces the old project/host dropdowns. Idle it is a
// plain 28px icon button; with filters applied it carries a count badge.
// Its menu must open toward the list (down under the top anchor, up under
// the bottom anchor) and stay inside the sidebar and the viewport at the
// default and minimum sidebar widths. The mobile drawer renders the same
// list, so the same control is driven there with real touch events.
//
// The menu is a plain checklist: nothing ticked means no filter, with no
// hint text. A pinned header row holds the title and, only while a filter
// is active, a "Clear" action. Past 8 options a pinned search field narrows
// the rows. With 30 projects only the checklist scrolls; the header and the
// search stay put.
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
/** Copy the menu used to carry; none of it may come back. */
const HINT_TEXT = /Showing all|Tick to narrow|selected|Show all/

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
const headerOf = (scope: Locator) => scope.getByTestId('filter-header')
const clearOf = (scope: Locator) => scope.getByRole('menuitem', { name: 'Clear' })
const searchOf = (scope: Locator) => scope.getByRole('searchbox', { name: 'Search filters' })
const checkedOf = (scope: Locator) => scope.locator('[role="menuitemcheckbox"][aria-checked="true"]')

/** No hint, summary or "Show all" text anywhere in the menu. */
async function expectNoHint(menu: Locator) {
  await expect(menu).not.toContainText(HINT_TEXT)
  await expect(menu.getByTestId('filter-summary')).toHaveCount(0)
}

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
      await expectNoHint(menu)
      // Idle: the header shows only the title; 3 options means no search.
      await expect(headerOf(menu)).toHaveText('Filter')
      await expect(clearOf(menu)).toHaveCount(0)
      await expect(searchOf(menu)).toHaveCount(0)

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

test('filtering by project hides other sessions; badge counts; Clear appears and restores', async ({
  page,
}) => {
  const { prefix, dirs, names, harness } = await openBoard(page)
  const sidebar = desktopSidebar(page)
  await expect(sidebar.getByTestId('session-card')).toHaveCount(3, DISCOVERY)
  const button = funnel(sidebar)

  await button.click()
  const menu = menuOf(sidebar)
  await expect(clearOf(menu)).toHaveCount(0)
  const idleHeader = await box(headerOf(menu))
  const firstRow = menu.getByRole('menuitemcheckbox').first()
  const idleRowTop = (await box(firstRow)).top
  await menu.getByRole('menuitemcheckbox', { name: `${prefix}alpha` }).click()
  await expect(sidebar.getByTestId('session-card')).toHaveCount(1)
  await expect(cardByName(sidebar, names[0])).toBeVisible()
  await expect(badgeOf(sidebar)).toHaveText('1')
  await expect(button).toHaveAttribute('aria-label', 'Filter, 1 active filter')
  await expect(button).toHaveAttribute('title', `Filtered by Projects: ${prefix}alpha`)
  await expectNoHint(menu)
  await expect(clearOf(menu)).toBeVisible()
  // Clear sits right of the title in the same header row, which keeps its
  // height, so the rows below do not move when Clear appears.
  const activeHeader = await box(headerOf(menu))
  expect(Math.abs(activeHeader.height - idleHeader.height)).toBeLessThanOrEqual(0.5)
  expect(Math.abs((await box(firstRow)).top - idleRowTop)).toBeLessThanOrEqual(0.5)
  const clearBox = await box(clearOf(menu))
  const titleBox = await box(headerOf(menu).getByText('Filter', { exact: true }))
  expect(clearBox.left).toBeGreaterThan(titleBox.right)
  expect(clearBox.right).toBeGreaterThan(activeHeader.right - 2)
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
  await expectNoHint(menu)
  // Filter state syncs exactly as before: the full selection, in list order.
  await expect
    .poll(() => harness.puts.filter((put) => 'projectFilters' in put).at(-1)?.projectFilters)
    .toEqual([dirs[0], dirs[2]])

  // Keyboard: Tab from the funnel reaches Clear first; Enter activates it.
  await button.focus()
  await page.keyboard.press('Tab')
  await expect(clearOf(menu)).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(sidebar.getByTestId('session-card')).toHaveCount(3)
  await expect(badgeOf(sidebar)).toHaveCount(0)
  await expect(button).toHaveAttribute('aria-label', 'Filter')
  await expect(checkedOf(menu)).toHaveCount(0)
  // Clear goes away once nothing is filtered; the menu stays open.
  await expect(clearOf(menu)).toHaveCount(0)
  await expect(menu).toBeVisible()
  await expectNoHint(menu)
  // An empty selection is synced as "no filter", exactly as before.
  await expect
    .poll(() => harness.puts.filter((put) => 'projectFilters' in put).at(-1)?.projectFilters)
    .toEqual([])
})

/**
 * The open menu fits: inside the viewport and `scope`, unclipped, no
 * horizontal overflow, and the pinned rows (header, search, Clear when
 * shown) visible and uncovered.
 */
async function expectMenuFits(page: Page, scope: Locator, menu: Locator) {
  const vh = await page.evaluate(() => window.innerHeight)
  const opened = await box(menu)
  expect(opened.top).toBeGreaterThanOrEqual(0)
  expect(opened.bottom).toBeLessThanOrEqual(vh)
  expect(inside(opened, await box(scope))).toBe(true)
  expect(await unoccluded(menu)).toBe(true)
  expect(await menu.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)
  // The menu itself never scrolls; only its checklist region does.
  expect(await menu.evaluate((el) => el.scrollHeight <= el.clientHeight + 1)).toBe(true)
  // The search shows only past 8 options; Clear only while filtering.
  const pinned = [headerOf(menu)]
  if ((await searchOf(menu).count()) > 0) pinned.push(searchOf(menu))
  if ((await clearOf(menu).count()) > 0) pinned.push(clearOf(menu))
  for (const item of pinned) {
    await expect(item).toBeVisible()
    expect(inside(await box(item), opened)).toBe(true)
    expect(await unoccluded(item)).toBe(true)
  }
  return opened
}

/**
 * With 30 projects the checklist scrolls inside the menu; the menu stays in
 * the viewport and the sidebar, and the header and search stay visible
 * (pinned outside the scroll region) at both ends of the list.
 */
async function expectLongMenuUsable(page: Page, scope: Locator, menu: Locator) {
  const options = menu.getByTestId('filter-options')
  await expectMenuFits(page, scope, menu)
  // The list overflows its own scroll region, not the menu.
  expect(await options.evaluate((el) => el.scrollHeight > el.clientHeight + 20)).toBe(true)
  await expect(searchOf(menu)).toBeVisible()
  for (const position of ['top', 'bottom'] as const) {
    await options.evaluate((el, pos) => {
      el.scrollTop = pos === 'top' ? 0 : el.scrollHeight
    }, position)
    await expectMenuFits(page, scope, menu)
  }
}

/** Visible checklist labels in the menu, top to bottom. */
async function rowLabels(menu: Locator): Promise<string[]> {
  return menu.getByRole('menuitemcheckbox').evaluateAll((els) => els.map((el) => el.textContent?.trim() ?? ''))
}

for (const anchor of ANCHORS) {
  for (const width of [240, 180]) {
    test(`${anchor} @${width}px: 30 projects scroll inside the menu; search narrows; header stays visible`, async ({
      page,
    }) => {
      const { prefix } = await openBoard(page, { anchor, width, projects: MANY_PROJECTS })
      const sidebar = desktopSidebar(page)
      await expect(sidebar.getByTestId('session-card')).toHaveCount(MANY_PROJECTS.length, DISCOVERY)
      await funnel(sidebar).click()
      const menu = menuOf(sidebar)
      await expect(menu).toBeVisible()
      await expect(menu.getByRole('menuitemcheckbox')).toHaveCount(MANY_PROJECTS.length)
      await expectNoHint(menu)
      await expect(clearOf(menu)).toHaveCount(0)
      // Desktop: the search is focused on open, so typing filters at once.
      await expect(searchOf(menu)).toBeFocused()
      await expectLongMenuUsable(page, sidebar, menu)

      // Tick the last project (scrolled into view); Clear appears.
      const last = menu.getByRole('menuitemcheckbox', { name: `${prefix}p29` })
      await last.click()
      await expect(sidebar.getByTestId('session-card')).toHaveCount(1)
      await expect(clearOf(menu)).toBeVisible()
      await expectLongMenuUsable(page, sidebar, menu)

      // Typing narrows (case-insensitive); the ticked p29 stays listed.
      await searchOf(menu).fill('P1')
      await expect(menu.getByRole('menuitemcheckbox')).toHaveCount(11)
      const narrowed = await rowLabels(menu)
      expect(narrowed).toContain(`${prefix}p29`)
      // Rows are ordered by recent activity, so compare as sets.
      expect(narrowed.filter((label) => label !== `${prefix}p29`).sort()).toEqual(
        MANY_PROJECTS.filter((name) => name.startsWith('p1')).map((name) => `${prefix}${name}`)
      )
      await expectMenuFits(page, sidebar, menu)

      // Nothing matches: only the ticked row is left.
      await searchOf(menu).fill('zz')
      await expect(menu.getByRole('menuitemcheckbox')).toHaveCount(1)
      await expect(checkedOf(menu)).toHaveCount(1)
      await expect(menu.getByText('No matches')).toHaveCount(0)

      // Clear with the mouse; with nothing ticked "zz" matches nothing.
      await clearOf(menu).click()
      await expect(sidebar.getByTestId('session-card')).toHaveCount(MANY_PROJECTS.length)
      await expect(clearOf(menu)).toHaveCount(0)
      await expect(menu.getByRole('menuitemcheckbox')).toHaveCount(0)
      await expect(menu.getByText('No matches', { exact: true })).toBeVisible()
      await expectMenuFits(page, sidebar, menu)

      // Escape clears the text first (all rows back), then closes the menu.
      await searchOf(menu).focus()
      await page.keyboard.press('Escape')
      await expect(menu).toBeVisible()
      await expect(searchOf(menu)).toHaveValue('')
      await expect(menu.getByRole('menuitemcheckbox')).toHaveCount(MANY_PROJECTS.length)
      await page.keyboard.press('Escape')
      await expect(menu).toHaveCount(0)

      // Reopening starts with an empty search.
      await funnel(sidebar).click()
      await expect(searchOf(menu)).toHaveValue('')
    })
  }
}

test('typed text is matched literally, not as a pattern', async ({ page }) => {
  const { prefix } = await openBoard(page, { projects: MANY_PROJECTS })
  const sidebar = desktopSidebar(page)
  await expect(sidebar.getByTestId('session-card')).toHaveCount(MANY_PROJECTS.length, DISCOVERY)
  await funnel(sidebar).click()
  const menu = menuOf(sidebar)
  // A regex would match every row ('.*') or throw ('('); plain text matches none.
  for (const text of ['.*', '(', '[p']) {
    await searchOf(menu).fill(text)
    await expect(menu.getByText('No matches', { exact: true })).toBeVisible()
  }
  await searchOf(menu).fill(`${prefix}p0`)
  await expect(menu.getByRole('menuitemcheckbox')).toHaveCount(10)
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

  /** Clear is a real 44x44 CSS px control on coarse pointers. */
  async function expectClearTouchTarget(clear: Locator) {
    const b = await box(clear)
    const w = await clear.evaluate((el) => el.getBoundingClientRect().width)
    expect(b.height).toBeGreaterThanOrEqual(43.5)
    expect(w).toBeGreaterThanOrEqual(43.5)
    expect(await unoccluded(clear)).toBe(true)
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
    await expectNoHint(menu)
    await expect(clearOf(menu)).toHaveCount(0)
    await expect(searchOf(menu)).toHaveCount(0)
    const opened = await box(menu)
    expect(opened.top).toBeGreaterThanOrEqual(visible.bottom)
    expect(inside(opened, await box(drawer))).toBe(true)
    expect(await unoccluded(menu)).toBe(true)

    await touchTap(page, menu.getByRole('menuitemcheckbox', { name: `${prefix}bravo` }))
    await expect(drawer.getByTestId('session-card')).toHaveCount(1)
    await expect(cardByName(drawer, names[1])).toBeVisible()
    await expect(badgeOf(drawer)).toHaveText('1')

    // The menu still offers every project while one is ticked, so a second
    // can be added (the drawer gets the unfiltered session list).
    await expect(menu.getByRole('menuitemcheckbox')).toHaveCount(3)
    await touchTap(page, menu.getByRole('menuitemcheckbox', { name: `${prefix}alpha` }))
    await expect(drawer.getByTestId('session-card')).toHaveCount(2)
    await expect(badgeOf(drawer)).toHaveText('2')

    await expectNoHint(menu)
    const clear = clearOf(menu)
    await expect(clear).toBeVisible()
    await expectClearTouchTarget(clear)
    await expectMenuFits(page, drawer, menu)
    await touchTap(page, clear)
    await expect(drawer.getByTestId('session-card')).toHaveCount(3)
    await expect(badgeOf(drawer)).toHaveCount(0)
    await expect(clearOf(menu)).toHaveCount(0)
    await expectNoHint(menu)
  })

  test('30 projects: the drawer menu scrolls, searches without popping the keyboard, and clears', async ({
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
    await expectNoHint(menu)
    await expectLongMenuUsable(page, drawer, menu)
    // Touch: the search is not focused on open (no uninvited keyboard), and
    // its text is 16px so focusing it later does not zoom iOS.
    await expect(searchOf(menu)).not.toBeFocused()
    expect(await searchOf(menu).evaluate((el) => getComputedStyle(el).fontSize)).toBe('16px')

    await searchOf(menu).fill('p2')
    await expect(menu.getByRole('menuitemcheckbox')).toHaveCount(10)
    await expectMenuFits(page, drawer, menu)
    await searchOf(menu).fill('zz')
    await expect(menu.getByText('No matches', { exact: true })).toBeVisible()
    await expectMenuFits(page, drawer, menu)
    await searchOf(menu).fill('')
    await expect(menu.getByRole('menuitemcheckbox')).toHaveCount(MANY_PROJECTS.length)

    // Projects are listed most-recently-active first, so live activity can
    // reorder rows; bring the target into view right before the touch and
    // assert on the outcome (one project ticked), not on which row it was.
    const last = menu.getByRole('menuitemcheckbox', { name: `${prefix}p29` })
    await last.evaluate((el) => el.scrollIntoView({ block: 'nearest' }))
    await touchTap(page, last)
    await expect(checkedOf(menu)).toHaveCount(1)
    await expect(drawer.getByTestId('session-card')).toHaveCount(1)
    const clear = clearOf(menu)
    await expect(clear).toBeVisible()
    await expectClearTouchTarget(clear)
    await expectMenuFits(page, drawer, menu)
    await touchTap(page, clear)
    await expect(drawer.getByTestId('session-card')).toHaveCount(MANY_PROJECTS.length)
    await expect(clearOf(menu)).toHaveCount(0)
  })
})
