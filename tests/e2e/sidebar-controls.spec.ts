// E2E: the sidebar's global controls (connection dot, new session, settings)
// live at the right end of the filter bar under both anchors — there is no
// header row. With a Tailscale IP the dot is a button opening a popover with
// the status and a click-to-copy remote-access URL.
//
// The Tailscale IP comes from GET /api/server-info, which the harness stubs
// (100.64.0.1, CGNAT example range) — the machine's real IP never reaches
// the page. Synced settings (the anchor) go to the harness's in-test store,
// so the shared e2e server is never reconfigured.
import { test, expect, type Locator, type Page } from '@playwright/test'
import {
  Windows,
  box,
  desktopSidebar,
  installHarness,
  uniquePrefix,
  type Box,
} from './helpers/sidebarHarness'

test.use({ serviceWorkers: 'block' })

const DISCOVERY = { timeout: 30_000 }
test.describe.configure({ timeout: 90_000 })

const IP = '100.64.0.1'
const ANCHORS = ['top', 'bottom'] as const
type Anchor = (typeof ANCHORS)[number]

const windows = new Windows()
test.afterEach(() => windows.cleanup())

function filterBar(scope: Locator): Locator {
  return scope
    .getByRole('button', { name: /^Filter\b/ })
    .locator('xpath=ancestor::div[contains(concat(" ", @class, " "), " sticky ")][1]')
}

function hintBar(scope: Locator): Locator {
  return scope.getByText(/\[ \] nav/).locator('xpath=../..')
}

const dotButton = (scope: Locator) =>
  scope.getByRole('button', { name: /^Connection: .*Tailscale remote access$/ })
const plainDot = (scope: Locator) => scope.getByRole('img', { name: /^Connection: / })
const popover = (page: Page) => page.getByRole('dialog', { name: 'Remote access' })
const copyButton = (page: Page) =>
  popover(page).getByRole('button', { name: /100\.64\.0\.1|Copied!/ })

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

async function openBoard(
  page: Page,
  options: { anchor: Anchor; tailscaleIp: string | null; width?: number }
) {
  const prefix = uniquePrefix('ctl')
  windows.createMany(prefix, 2)
  if (options.width) await useSidebarWidth(page, options.width)
  const harness = await installHarness(page, {
    prefix,
    settings: { sidebarAnchor: options.anchor },
    tailscaleIp: options.tailscaleIp,
  })
  await page.goto('/')
  const sidebar = desktopSidebar(page)
  await expect(sidebar.getByTestId('session-card')).toHaveCount(2, DISCOVERY)
  if (options.width) {
    await expect.poll(async () => Math.round((await box(sidebar)).right - (await box(sidebar)).left)).toBe(options.width)
  }
  return { sidebar, harness }
}

function inside(inner: Box, outer: Box, slack = 0.5) {
  return (
    inner.left >= outer.left - slack &&
    inner.right <= outer.right + slack &&
    inner.top >= outer.top - slack &&
    inner.bottom <= outer.bottom + slack
  )
}

for (const anchor of ANCHORS) {
  test(`${anchor}: no wordmark or header row; the filter bar holds the controls`, async ({
    page,
  }) => {
    const { sidebar } = await openBoard(page, { anchor, tailscaleIp: IP })
    await expect(page.getByRole('heading', { name: 'Agentboard' })).toHaveCount(0)
    await expect(page.getByText('AGENTBOARD', { exact: true })).toHaveCount(0)
    await expect(page.locator('header')).toHaveCount(0)

    const bar = await box(filterBar(sidebar))
    const hint = await box(hintBar(sidebar))
    const vh = await page.evaluate(() => window.innerHeight)
    if (anchor === 'top') {
      // The filter bar is the first row of the window.
      expect(bar.top).toBeLessThanOrEqual(1)
    } else {
      // Filter bar sits directly on the hint bar at the window's bottom.
      expect(Math.abs(bar.bottom - hint.top)).toBeLessThanOrEqual(1)
      expect(Math.abs(hint.bottom - vh)).toBeLessThanOrEqual(1)
    }
    for (const control of [
      sidebar.getByRole('button', { name: 'Filter', exact: true }),
      dotButton(sidebar),
      sidebar.getByRole('button', { name: 'New session', exact: true }),
      sidebar.getByRole('button', { name: 'Settings', exact: true }),
    ]) {
      expect(inside(await box(control), bar)).toBe(true)
    }
  })
}

test('"+" opens the new-session modal and the gear opens Settings', async ({ page }) => {
  const { sidebar } = await openBoard(page, { anchor: 'top', tailscaleIp: null })

  await sidebar.getByRole('button', { name: 'New session', exact: true }).click()
  const newSession = page.getByRole('dialog', { name: 'New Session' })
  await expect(newSession).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(newSession).toHaveCount(0)

  const gear = sidebar.getByRole('button', { name: 'Settings', exact: true })
  await gear.click()
  const settings = page.getByRole('dialog', { name: 'Settings' })
  await expect(settings.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible()
  await settings.getByRole('tab', { name: 'Session list', exact: true }).click()
  await expect(settings.getByText('Sidebar anchor', { exact: true })).toBeVisible()
  // Escape closes and focus returns to the gear that opened it.
  await page.keyboard.press('Escape')
  await expect(settings).toHaveCount(0)
  await expect(gear).toBeFocused()
})

test('Tailscale popover: open, status and IP, copy URL, Escape, outside click', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  const { sidebar } = await openBoard(page, { anchor: 'top', tailscaleIp: IP })

  // At rest the IP is not shown; the dot is a visibly bordered button.
  await expect(page.getByText(IP)).toHaveCount(0)
  const dot = dotButton(sidebar)
  await expect(dot).toHaveAttribute('aria-label', 'Connection: Connected. Tailscale remote access')
  // Same bordered square as the settings gear beside it.
  const chromeOf = (locator: Locator) =>
    locator.evaluate((el) => {
      const style = getComputedStyle(el)
      const r = el.getBoundingClientRect()
      return {
        border: `${style.borderTopWidth} ${style.borderTopStyle} ${style.borderTopColor}`,
        radius: style.borderTopLeftRadius,
        width: r.width,
        height: r.height,
      }
    })
  const dotChrome = await chromeOf(dot)
  expect(dotChrome.border).toMatch(/^1px solid /)
  expect(dotChrome.width).toBe(dotChrome.height)
  expect(dotChrome).toEqual(
    await chromeOf(sidebar.getByRole('button', { name: 'Settings', exact: true }))
  )
  // Hover gives it the same background as a hovered gear. Transitions off,
  // so the computed colors are final states rather than mid-fade samples.
  await page.addStyleTag({ content: '*, *::before, *::after { transition: none !important; }' })
  const hoverBg = async (locator: Locator) => {
    await locator.hover()
    return locator.evaluate((el) => getComputedStyle(el).backgroundColor)
  }
  const restBg = await dot.evaluate((el) => getComputedStyle(el).backgroundColor)
  const dotHover = await hoverBg(dot)
  expect(dotHover).not.toBe(restBg)
  expect(dotHover).toBe(await hoverBg(sidebar.getByRole('button', { name: 'Settings', exact: true })))

  await dot.click()
  await expect(popover(page)).toBeVisible()
  await expect(dot).toHaveAttribute('aria-expanded', 'true')
  await expect(popover(page)).toContainText('Connected')
  await expect(popover(page)).toContainText('Tailscale')
  await expect(copyButton(page)).toHaveText(IP)

  await copyButton(page).click()
  await expect(copyButton(page)).toHaveText('Copied!')
  const port = new URL(page.url()).port
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`http://${IP}:${port}`)
  // The confirmation reverts to the IP.
  await expect(copyButton(page)).toHaveText(IP, { timeout: 5000 })

  await page.keyboard.press('Escape')
  await expect(popover(page)).toHaveCount(0)
  await expect(dot).toHaveAttribute('aria-expanded', 'false')

  await dot.click()
  await expect(popover(page)).toBeVisible()
  // Outside click: on the main panel, away from the sidebar.
  const sidebarBox = await box(sidebar)
  await page.mouse.click(sidebarBox.right + 200, 300)
  await expect(popover(page)).toHaveCount(0)
})

test('Tailscale popover is operable by keyboard alone', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  const { sidebar } = await openBoard(page, { anchor: 'top', tailscaleIp: IP })
  const dot = dotButton(sidebar)

  // Tab from the filter button reaches the dot, with a visible focus ring.
  await sidebar.getByRole('button', { name: 'Filter', exact: true }).focus()
  await page.keyboard.press('Tab')
  await expect(dot).toBeFocused()
  expect(await dot.evaluate((el) => getComputedStyle(el).boxShadow)).not.toBe('none')

  await page.keyboard.press('Enter')
  await expect(popover(page)).toBeVisible()
  await page.keyboard.press('Tab')
  await expect(copyButton(page)).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(copyButton(page)).toHaveText('Copied!')
  const port = new URL(page.url()).port
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`http://${IP}:${port}`)

  await page.keyboard.press('Escape')
  await expect(popover(page)).toHaveCount(0)
})

for (const anchor of ANCHORS) {
  for (const width of [240, 180]) {
    test(`${anchor} @${width}px: popover opens ${anchor === 'top' ? 'below' : 'above'} the bar, inside sidebar and viewport`, async ({
      page,
    }) => {
      const { sidebar } = await openBoard(page, { anchor, tailscaleIp: IP, width })
      await dotButton(sidebar).click()
      await expect(popover(page)).toBeVisible()

      const bar = await box(filterBar(sidebar))
      const pop = await box(popover(page))
      const side = await box(sidebar)
      const viewport = await page.evaluate(() => ({
        top: 0,
        left: 0,
        right: window.innerWidth,
        bottom: window.innerHeight,
        height: window.innerHeight,
      }))
      if (anchor === 'top') {
        expect(pop.top).toBeGreaterThanOrEqual(bar.bottom - 0.5)
      } else {
        expect(pop.bottom).toBeLessThanOrEqual(bar.top + 0.5)
      }
      expect(pop.left).toBeGreaterThanOrEqual(side.left)
      expect(pop.right).toBeLessThanOrEqual(side.right)
      expect(inside(pop, viewport)).toBe(true)
      // Nothing paints over it, and the IP is readable in full.
      const onTop = await popover(page).evaluate((el) => {
        const r = el.getBoundingClientRect()
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
        return !!hit && el.contains(hit)
      })
      expect(onTop).toBe(true)
      const ipText = copyButton(page).locator('span')
      expect(await ipText.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)
    })
  }
}

test('without a Tailscale IP the dot is a plain indicator with no popover', async ({ page }) => {
  const { sidebar } = await openBoard(page, { anchor: 'top', tailscaleIp: null })
  const indicator = plainDot(sidebar)
  await expect(indicator).toHaveAttribute('aria-label', 'Connection: Connected')
  await expect(sidebar.locator('button[aria-haspopup="dialog"]')).toHaveCount(0)
  expect(await indicator.evaluate((el) => el.closest('button'))).toBeNull()
  expect(await indicator.evaluate((el) => getComputedStyle(el).borderTopWidth)).toBe('0px')

  await indicator.click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.getByText(IP)).toHaveCount(0)
})

test('losing the WebSocket shows on the dot, and reconnecting restores it', async ({ page }) => {
  // Kill switch: while blocked, every new socket targets a closed port so the
  // client's reconnect attempts genuinely fail (never a fake "open").
  await page.addInitScript(() => {
    const NativeWebSocket = window.WebSocket
    const sockets: WebSocket[] = []
    const w = window as unknown as { __abBlockSockets: (blocked: boolean) => void }
    let blocked = false
    w.__abBlockSockets = (value) => {
      blocked = value
      if (value) for (const socket of sockets.splice(0)) socket.close()
    }
    window.WebSocket = new Proxy(NativeWebSocket, {
      construct(target, args: [string | URL, (string | string[])?]) {
        const socket = blocked
          ? new target('ws://127.0.0.1:9/blocked')
          : new target(...args)
        sockets.push(socket)
        return socket
      },
    })
  })
  const { sidebar } = await openBoard(page, { anchor: 'top', tailscaleIp: null })
  const indicator = plainDot(sidebar)
  const dot = indicator.locator('span')
  await expect(indicator).toHaveAttribute('aria-label', 'Connection: Connected')
  const connectedColor = await dot.evaluate((el) => getComputedStyle(el).backgroundColor)

  await page.evaluate(() =>
    (window as unknown as { __abBlockSockets: (b: boolean) => void }).__abBlockSockets(true)
  )
  await expect(indicator).toHaveAttribute(
    'aria-label',
    /^Connection: (Reconnecting|Connecting|Disconnected)$/,
    { timeout: 15_000 }
  )
  expect(await dot.evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe(connectedColor)

  await page.evaluate(() =>
    (window as unknown as { __abBlockSockets: (b: boolean) => void }).__abBlockSockets(false)
  )
  await expect(indicator).toHaveAttribute('aria-label', 'Connection: Connected', { timeout: 30_000 })
  expect(await dot.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(connectedColor)
})

for (const anchor of ANCHORS) {
  test(`${anchor} @180px: the right-hand controls neither wrap nor clip`, async ({ page }) => {
    const { sidebar } = await openBoard(page, { anchor, tailscaleIp: IP, width: 180 })
    const bar = await box(filterBar(sidebar))
    const hint = await box(hintBar(sidebar))
    const gear = await box(sidebar.getByRole('button', { name: 'Settings', exact: true }))
    const side = await box(sidebar)
    const filter = await box(sidebar.getByRole('button', { name: 'Filter', exact: true }))
    const controls = [
      await box(dotButton(sidebar)),
      await box(sidebar.getByRole('button', { name: 'New session', exact: true })),
      await box(sidebar.getByRole('button', { name: 'Settings', exact: true })),
    ]
    // The bar keeps its single-row height (same h-10 as the hint bar).
    expect(Math.abs(bar.height - hint.height)).toBeLessThanOrEqual(0.5)
    for (const control of controls) {
      expect(Math.abs(control.height - gear.height)).toBeLessThanOrEqual(0.5)
      expect(inside(control, bar)).toBe(true)
      expect(control.right).toBeLessThanOrEqual(side.right)
      // One row: every control shares the dot's vertical position.
      expect(Math.abs(control.top - controls[0].top)).toBeLessThanOrEqual(0.5)
    }
    // Same 28px square as the gear, at the bar's left end.
    expect(Math.abs(filter.height - gear.height)).toBeLessThanOrEqual(0.5)
    expect(Math.abs(filter.right - filter.left - (gear.right - gear.left))).toBeLessThanOrEqual(0.5)
    expect(inside(filter, bar)).toBe(true)
    // Left to right without overlap: filter, then the right-hand controls.
    expect(filter.right).toBeLessThanOrEqual(controls[0].left)
    expect(controls[0].right).toBeLessThanOrEqual(controls[1].left)
    expect(controls[1].right).toBeLessThanOrEqual(controls[2].left)
    // Nothing is clipped: the bar does not overflow horizontally.
    expect(
      await filterBar(sidebar).evaluate((el) => el.scrollWidth <= el.clientWidth)
    ).toBe(true)
  })
}
