// E2E: the "Sidebar Anchor: Bottom" setting mirrors the desktop sidebar.
//
// Every assertion is about on-screen geometry (bounding boxes, scroll
// offsets), not class names: the feature is "the first session sits at the
// bottom, next to the prompt", so that is what is measured. The harness
// (helpers/sidebarHarness.ts) isolates each test to its own tmux windows and
// an in-test synced-settings store, so the shared e2e server never sees the
// anchor flip and parallel specs are unaffected.
import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect, type Locator, type Page } from '@playwright/test'
import {
  Windows,
  box,
  cardByName,
  desktopSidebar,
  installHarness,
  namesTopToBottom,
  scrollState,
  shortcutChord,
  syntheticAgentSession,
  uniquePrefix,
} from './helpers/sidebarHarness'

test.use({ serviceWorkers: 'block' })

// New tmux windows reach the page on the server's next refresh tick (2s,
// much slower while parallel workers load the machine). Waits are condition
// polls, so the generous budgets only cost time when the machine is slow.
const DISCOVERY = { timeout: 30_000 }
test.describe.configure({ timeout: 90_000 })

const windows = new Windows()
test.afterEach(() => windows.cleanup())

function filterBar(scope: Locator): Locator {
  // The sticky bar that holds the filter button (and, on desktop, the
  // sidebar controls).
  return scope
    .getByRole('button', { name: /^Filter\b/ })
    .locator('xpath=ancestor::div[contains(concat(" ", @class, " "), " sticky ")][1]')
}

function hintBar(scope: Locator): Locator {
  return scope.getByText(/\[ \] nav/).locator('xpath=../..')
}

function scroller(sidebar: Locator): Locator {
  return sidebar.locator('.overflow-y-auto')
}

function projectDir(name: string): string {
  const dir = join(process.env.E2E_TMUX_TMPDIR || tmpdir(), 'projects', name)
  mkdirSync(dir, { recursive: true })
  return dir
}

async function viewportHeight(page: Page): Promise<number> {
  return page.evaluate(() => window.innerHeight)
}

test('Settings switches the anchor to Bottom and it persists across reload and devices', async ({
  page,
  browser,
}) => {
  const prefix = uniquePrefix('set')
  const names = windows.createMany(prefix, 3)
  const harness = await installHarness(page, { prefix })
  const sidebar = desktopSidebar(page)

  await page.goto('/')
  await expect(sidebar.getByTestId('session-card')).toHaveCount(3, DISCOVERY)
  // Default Top: first session is the topmost row.
  await expect.poll(() => namesTopToBottom(sidebar, prefix)).toEqual(names)

  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  const anchorGroup = page.getByText('Sidebar Anchor', { exact: true }).locator('..')
  await anchorGroup.getByRole('button', { name: 'Bottom', exact: true }).click()
  await page.getByRole('button', { name: 'Save', exact: true }).click()

  // Mirrored: first session is now the lowest row.
  await expect.poll(() => namesTopToBottom(sidebar, prefix)).toEqual([...names].reverse())
  // The choice was pushed to the (stubbed) server as a synced setting.
  await expect
    .poll(() => harness.puts.some((put) => put.sidebarAnchor === 'bottom'))
    .toBe(true)

  await page.reload()
  await expect(sidebar.getByTestId('session-card')).toHaveCount(3, DISCOVERY)
  await expect.poll(() => namesTopToBottom(sidebar, prefix)).toEqual([...names].reverse())

  // A second device with no local state adopts the server's value.
  const other = await browser.newContext({ serviceWorkers: 'block' })
  try {
    const otherPage = await other.newPage()
    await installHarness(otherPage, { prefix, settings: { ...harness.settings } })
    await otherPage.goto('/')
    const otherSidebar = desktopSidebar(otherPage)
    await expect(otherSidebar.getByTestId('session-card')).toHaveCount(3, DISCOVERY)
    await expect
      .poll(() => namesTopToBottom(otherSidebar, prefix))
      .toEqual([...names].reverse())
  } finally {
    await other.close()
  }
})

test('Bottom: first row lowest, rows above the filter bar, bars stacked at the bottom, gap on top', async ({
  page,
}) => {
  const prefix = uniquePrefix('geo')
  const names = windows.createMany(prefix, 3)
  await installHarness(page, {
    prefix,
    settings: { sidebarAnchor: 'bottom' },
    hibernating: [syntheticAgentSession(`${prefix}hib`, { hibernating: true })],
    history: [syntheticAgentSession(`${prefix}hist`)],
  })
  const sidebar = desktopSidebar(page)

  await page.goto('/')
  await expect(sidebar.getByTestId('session-card')).toHaveCount(3, DISCOVERY)
  await expect.poll(() => namesTopToBottom(sidebar, prefix)).toEqual([...names].reverse())

  const vh = await viewportHeight(page)
  const bar = await box(filterBar(sidebar))
  const hint = await box(hintBar(sidebar))

  // Bottom stack: filter bar directly on the hint bar, which is flush with
  // the window's bottom edge (no header row between them).
  expect(Math.abs(hint.bottom - vh)).toBeLessThanOrEqual(1)
  expect(Math.abs(bar.bottom - hint.top)).toBeLessThanOrEqual(1)

  // Every row sits above the filter bar; the first session is lowest and
  // touches the bar.
  const rows = await Promise.all(names.map((name) => box(cardByName(sidebar, name))))
  for (const row of rows) {
    expect(row.bottom).toBeLessThanOrEqual(bar.top + 1)
  }
  expect(rows[0].top).toBeGreaterThan(rows[1].top)
  expect(rows[1].top).toBeGreaterThan(rows[2].top)
  expect(bar.top - rows[0].bottom).toBeLessThanOrEqual(1)

  // Sections mirrored: History above Hibernating above Active.
  const historyToggle = await box(sidebar.getByRole('button', { name: /^History/ }))
  const hibernatingToggle = await box(sidebar.getByRole('button', { name: /^Hibernating/ }))
  const activeLabel = await box(sidebar.getByText('Active', { exact: true }))
  expect(historyToggle.top).toBeLessThan(hibernatingToggle.top)
  expect(hibernatingToggle.top).toBeLessThan(activeLabel.top)
  expect(activeLabel.bottom).toBeLessThanOrEqual(rows[2].top + 1)

  // Short list: the empty space is at the top of the column, not between
  // the rows and the filter bar.
  const list = await box(scroller(sidebar))
  expect(historyToggle.top - list.top).toBeGreaterThan(100)
})

test('Bottom: an overflowing list opens at the bottom and stays pinned when a session is added', async ({
  page,
}) => {
  const prefix = uniquePrefix('pin')
  // Ordinals 10..19: a later window with ordinal 05 sorts first (lowest row).
  // A short viewport makes ten rows overflow without flooding the shared
  // tmux session other specs count windows in.
  const names: string[] = []
  for (let i = 10; i < 20; i++) names.push(windows.create(prefix, i))
  await installHarness(page, { prefix, settings: { sidebarAnchor: 'bottom' } })
  await page.setViewportSize({ width: 1280, height: 420 })
  const sidebar = desktopSidebar(page)
  const list = scroller(sidebar)

  await page.goto('/')
  await expect(sidebar.getByTestId('session-card')).toHaveCount(names.length, DISCOVERY)

  // Opens scrolled to the bottom of a list that really overflows.
  await expect
    .poll(async () => {
      const s = await scrollState(list)
      return s.scrollHeight - s.clientHeight > 100 && s.fromBottom <= 2
    })
    .toBe(true)
  expect((await scrollState(list)).scrollTop).toBeGreaterThan(0)
  const bar = await box(filterBar(sidebar))
  const first = await box(cardByName(sidebar, names[0]))
  expect(bar.top - first.bottom).toBeLessThanOrEqual(1)
  expect(first.top).toBeGreaterThan((await box(list)).top)

  // A new session that sorts first lands at the bottom edge; the list
  // follows it instead of leaving it hidden below the fold.
  const added = windows.create(prefix, 5)
  await expect(cardByName(sidebar, added)).toHaveCount(1, DISCOVERY)
  await expect.poll(async () => (await scrollState(list)).fromBottom).toBeLessThanOrEqual(2)
  await expect
    .poll(async () => {
      const row = await box(cardByName(sidebar, added))
      return Math.round(bar.top - row.bottom)
    })
    .toBeLessThanOrEqual(1)
  await expect
    .poll(async () => (await namesTopToBottom(sidebar, prefix)).at(-1))
    .toBe(added)
})

test('Bottom: the filter menu opens upward inside the viewport', async ({
  page,
}) => {
  const prefix = uniquePrefix('drop')
  const dirs = ['alpha', 'bravo', 'charlie'].map((name) => projectDir(`${prefix}${name}`))
  windows.createMany(prefix, 3, (i) => dirs[i])
  await installHarness(page, { prefix, settings: { sidebarAnchor: 'bottom' } })
  const sidebar = desktopSidebar(page)

  await page.goto('/')
  await expect(sidebar.getByTestId('session-card')).toHaveCount(3, DISCOVERY)

  const trigger = sidebar.getByRole('button', { name: 'Filter', exact: true })
  await trigger.click()
  const menu = sidebar.getByRole('menu')
  await expect(menu).toBeVisible()
  for (const name of ['alpha', 'bravo', 'charlie']) {
    await expect(menu.getByText(`${prefix}${name}`)).toBeVisible()
  }

  const vh = await viewportHeight(page)
  const button = await box(trigger)
  const opened = await box(menu)
  expect(opened.bottom).toBeLessThanOrEqual(button.top)
  expect(opened.top).toBeGreaterThanOrEqual(0)
  expect(opened.bottom).toBeLessThanOrEqual(vh)

  // Not clipped or covered: the menu is the topmost element at its center.
  const onTop = await menu.evaluate((el) => {
    const r = el.getBoundingClientRect()
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
    return !!hit && el.contains(hit)
  })
  expect(onTop).toBe(true)
})

test('mod+1 selects the lowest row; [ ] track screen direction in both anchors', async ({
  page,
}) => {
  const prefix = uniquePrefix('key')
  const names = windows.createMany(prefix, 4)
  const harness = await installHarness(page, { prefix, settings: { sidebarAnchor: 'top' } })
  const sidebar = desktopSidebar(page)
  const selected = sidebar.locator('[data-testid="session-card"].selected')

  // Digits address sessions (same target in both anchors); [ always moves
  // selection up the screen and ] down, so their targets differ under
  // Bottom — the same index step goes the other way on the mirrored list.
  const runSequence = async (expected: string[]) => {
    const chord = await shortcutChord(page)
    const picked: { name: string; top: number }[] = []
    const keys = ['Digit2', 'BracketRight', 'BracketLeft', 'BracketLeft']
    for (let i = 0; i < keys.length; i++) {
      await page.keyboard.press(`${chord}+${keys[i]}`)
      await expect(selected).toHaveCount(1)
      await expect(selected).toContainText(expected[i])
      picked.push({ name: expected[i], top: (await box(selected)).top })
    }
    return picked
  }

  await page.goto('/')
  await expect(sidebar.getByTestId('session-card')).toHaveCount(4, DISCOVERY)
  const underTop = await runSequence([names[1], names[2], names[1], names[0]])

  harness.settings.sidebarAnchor = 'bottom'
  await page.reload()
  await expect(sidebar.getByTestId('session-card')).toHaveCount(4, DISCOVERY)
  await expect.poll(() => namesTopToBottom(sidebar, prefix)).toEqual([...names].reverse())
  const underBottom = await runSequence([names[1], names[0], names[1], names[2]])

  for (const run of [underTop, underBottom]) {
    expect(run[0].name).toBe(names[1]) // mod+2: same session in both anchors
    expect(run[1].top).toBeGreaterThan(run[0].top) // ] moves down
    expect(run[2].top).toBeLessThan(run[1].top) // [ moves up
    expect(run[3].top).toBeLessThan(run[2].top) // [ moves up again
  }

  // Under Bottom, mod+1 is the lowest row and ] walks toward it.
  const lowest = Math.max(
    ...(await sidebar.getByTestId('session-card').evaluateAll((els) =>
      els.map((el) => el.getBoundingClientRect().top)
    ))
  )
  const chord = await shortcutChord(page)
  await page.keyboard.press(`${chord}+Digit1`)
  await expect(selected).toContainText(names[0])
  expect(Math.abs((await box(selected)).top - lowest)).toBeLessThanOrEqual(1)
})

test('Bottom: drag-reorder lands rows where they are dropped and survives reload', async ({
  page,
}) => {
  const prefix = uniquePrefix('drag')
  const names = windows.createMany(prefix, 4)
  const harness = await installHarness(page, { prefix, settings: { sidebarAnchor: 'bottom' } })
  const sidebar = desktopSidebar(page)

  await page.goto('/')
  await expect(sidebar.getByTestId('session-card')).toHaveCount(4, DISCOVERY)
  const [n0, n1, n2, n3] = names
  await expect.poll(() => namesTopToBottom(sidebar, prefix)).toEqual([n3, n2, n1, n0])

  // Drag the lowest row (n0) up onto n2's slot.
  const source = await box(cardByName(sidebar, n0))
  const target = await box(cardByName(sidebar, n2))
  const x = (await sidebar.boundingBox())!.x + 60
  const fromY = source.top + source.height / 2
  const toY = target.top + target.height / 2
  await page.mouse.move(x, fromY)
  await page.mouse.down()
  await page.mouse.move(x, fromY - 12, { steps: 3 }) // past the 8px activation
  await page.mouse.move(x, toY, { steps: 12 })
  // Wait until the dragged row is actually under the pointer before dropping.
  await expect
    .poll(async () => {
      const dragged = await box(cardByName(sidebar, n0))
      return Math.abs(dragged.top + dragged.height / 2 - toY)
    })
    .toBeLessThanOrEqual(4)
  // On screen during the drag: n0 has taken n2's slot, n2 and n1 shifted down.
  await expect.poll(() => namesTopToBottom(sidebar, prefix)).toEqual([n3, n0, n2, n1])
  await page.mouse.up()

  const expected = [n3, n0, n2, n1]
  await expect.poll(() => namesTopToBottom(sidebar, prefix)).toEqual(expected)
  await expect
    .poll(() => harness.puts.some((put) => Array.isArray(put.manualSessionOrder)))
    .toBe(true)
  expect(harness.settings.sessionSortMode).toBe('manual')

  await page.reload()
  await expect(sidebar.getByTestId('session-card')).toHaveCount(4, DISCOVERY)
  await expect.poll(() => namesTopToBottom(sidebar, prefix)).toEqual(expected)
})

test('Bottom: a row context menu near the bottom edge flips up to stay in the viewport', async ({
  page,
}) => {
  const prefix = uniquePrefix('ctx')
  const names = windows.createMany(prefix, 3)
  // logFilePath adds "Copy Log Path", making the menu taller than the space
  // between the lowest row and the window's bottom edge.
  await installHarness(page, {
    prefix,
    settings: { sidebarAnchor: 'bottom' },
    logFilePath: true,
  })
  await page.setViewportSize({ width: 1280, height: 600 })
  const sidebar = desktopSidebar(page)

  await page.goto('/')
  await expect(sidebar.getByTestId('session-card')).toHaveCount(3, DISCOVERY)
  await expect.poll(() => namesTopToBottom(sidebar, prefix)).toEqual([...names].reverse())

  const lowest = cardByName(sidebar, names[0])
  const row = await box(lowest)
  const clickX = row.left + 40
  const clickY = row.bottom - 3
  await page.mouse.click(clickX, clickY, { button: 'right' })

  const menu = page.getByRole('menu')
  await expect(menu).toBeVisible()
  await expect(menu.getByRole('menuitem', { name: 'Kill Session' })).toBeVisible()

  const vh = await viewportHeight(page)
  await expect
    .poll(async () => {
      const m = await box(menu)
      return m.bottom <= vh && m.top >= 0
    })
    .toBe(true)
  const m = await box(menu)
  // The flip was necessary: opening down from the pointer would overflow.
  expect(clickY + m.height).toBeGreaterThan(vh)
  // Flipped: the menu's bottom edge sits at the pointer, left edge unchanged
  // (2px: the browser reports the click at integer client coordinates).
  expect(Math.abs(m.bottom - clickY)).toBeLessThanOrEqual(2)
  expect(Math.abs(m.left - clickX)).toBeLessThanOrEqual(2)
  // Every item is reachable on screen.
  const kill = await box(menu.getByRole('menuitem', { name: 'Kill Session' }))
  expect(kill.bottom).toBeLessThanOrEqual(vh)
})

test('Top (default) keeps the original order and stacking', async ({ page }) => {
  const prefix = uniquePrefix('top')
  const names = windows.createMany(prefix, 3)
  await installHarness(page, {
    prefix,
    hibernating: [syntheticAgentSession(`${prefix}hib`, { hibernating: true })],
    history: [syntheticAgentSession(`${prefix}hist`)],
  })
  const sidebar = desktopSidebar(page)

  await page.goto('/')
  await expect(sidebar.getByTestId('session-card')).toHaveCount(3, DISCOVERY)
  await expect.poll(() => namesTopToBottom(sidebar, prefix)).toEqual(names)

  const vh = await viewportHeight(page)
  const bar = await box(filterBar(sidebar))
  const hint = await box(hintBar(sidebar))
  const first = await box(cardByName(sidebar, names[0]))
  const activeLabel = await box(sidebar.getByText('Active', { exact: true }))
  const hibernatingToggle = await box(sidebar.getByRole('button', { name: /^Hibernating/ }))
  const historyToggle = await box(sidebar.getByRole('button', { name: /^History/ }))

  // No header row: the filter bar is the first thing in the column.
  expect(bar.top).toBeLessThanOrEqual(1)
  expect(activeLabel.top).toBeGreaterThanOrEqual(bar.bottom - 1)
  expect(first.top).toBeGreaterThan(activeLabel.top)
  expect(hibernatingToggle.top).toBeGreaterThan(first.top)
  expect(historyToggle.top).toBeGreaterThan(hibernatingToggle.top)
  expect(Math.abs(hint.bottom - vh)).toBeLessThanOrEqual(1)
})

test.describe('mobile', () => {
  test.use({
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
  })

  test('the drawer ignores the Bottom anchor', async ({ page }) => {
    const prefix = uniquePrefix('mob')
    const names = windows.createMany(prefix, 3)
    await installHarness(page, { prefix, settings: { sidebarAnchor: 'bottom' } })

    await page.goto('/')
    const drawer = page.locator('.session-drawer')
    await expect(drawer.getByTestId('session-card')).toHaveCount(3, DISCOVERY)
    // Open with a synthetic click, not tap(): see e2e pane readback notes.
    await page.getByLabel('Open session menu').click()
    await expect(page.locator('.session-drawer.open')).toBeVisible()

    // Same as Top: first session topmost, filter bar above the rows.
    await expect.poll(() => namesTopToBottom(drawer, prefix)).toEqual(names)
    const bar = await box(filterBar(drawer))
    const first = await box(cardByName(drawer, names[0]))
    expect(bar.bottom).toBeLessThanOrEqual(first.top + 1)
  })
})
