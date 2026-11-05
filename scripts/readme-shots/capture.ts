// capture.ts - Drives the real Agentboard UI and saves raw screenshots.
//
// Desktop shots: Chromium at 2x. Phone shots: WebKit with an iPhone profile
// at 3x. Each context starts from fixed per-device settings (light theme,
// sidebar width, terminal font size). Viewports are deliberately small so
// the published images can show the UI near 1:1 instead of shrinking a
// whole board. Raw files go to `raw`; composite.ts makes the final images.

import { devices, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { join } from 'node:path'
import { baseUrl } from './instance'
import { AGES } from './scenes'

export const HERO = { width: 900, height: 600 }
export const FEATURE = { width: 1040, height: 900 }
export const LOOP = { width: 800, height: 560 }
export const PHONE = { width: 393, height: 852 }

export type Box = { x: number; y: number; width: number; height: number }
/** Crop boxes (CSS px) measured on the live page, keyed by image. */
export type Crops = Record<string, Box>
/** Computed CSS font sizes, for reporting displayed sizes. */
export type Metrics = Record<string, number>

/** Per-device UI settings, as the app persists them in localStorage. */
function seedStorage(sidebarWidth: number, fontSize = 13): string {
  return `
    localStorage.setItem('agentboard-theme', JSON.stringify({ state: { theme: 'light' }, version: 0 }));
    localStorage.setItem('agentboard-settings', JSON.stringify({
      state: { sidebarWidth: ${sidebarWidth}, fontSize: ${fontSize}, useWebGL: false,
        hibernatingSessionsExpanded: true, historySessionsExpanded: false },
      version: 8,
    }));`
}

// Working sessions keep their real "now"; this only pins their order.
const WORKING_ORDER = ['orders-migration', 'router-refactor', 'nightly-e2e']

/**
 * Age badges. The server dates a session's last activity from when it last
 * saw the pane change, so in a fresh instance every session reads "now".
 * This rewrites `lastActivity` (and nothing else) in session frames: waiting
 * sessions get the ages from scenes.ts, working ones a fixed order. It is
 * the same frame-patching technique the e2e sidebar harness uses.
 */
async function installAges(context: BrowserContext): Promise<void> {
  const patch = (session: Record<string, unknown>) => {
    const name = String(session.name ?? '')
    const minutes = AGES[name]
    if (minutes !== undefined && session.status === 'waiting') {
      session.lastActivity = new Date(Date.now() - minutes * 60_000).toISOString()
    } else if (WORKING_ORDER.includes(name)) {
      session.lastActivity = new Date(Date.now() - WORKING_ORDER.indexOf(name) * 2000).toISOString()
    }
  }
  await context.routeWebSocket(/\/ws(?:\?.*)?$/, (ws) => {
    const server = ws.connectToServer()
    ws.onMessage((message) => server.send(message))
    server.onMessage((message) => {
      if (typeof message !== 'string' || !message.includes('lastActivity')) return ws.send(message)
      try {
        const frame = JSON.parse(message) as { type?: string; sessions?: Record<string, unknown>[]; session?: Record<string, unknown> }
        if (frame.type === 'sessions') frame.sessions?.forEach(patch)
        else if ((frame.type === 'session-update' || frame.type === 'session-created') && frame.session) patch(frame.session)
        else return ws.send(message)
        ws.send(JSON.stringify(frame))
      } catch {
        ws.send(message)
      }
    })
  })
}

async function newContext(browser: Browser, viewport: { width: number; height: number }, sidebar: number, extra: object = {}, fontSize = 13) {
  const context = await browser.newContext({
    viewport, deviceScaleFactor: 2, colorScheme: 'light', serviceWorkers: 'block', ...extra,
  })
  await context.addInitScript(seedStorage(sidebar, fontSize))
  await installAges(context)
  return context
}

async function open(context: BrowserContext): Promise<Page> {
  const page = await context.newPage()
  await page.goto(baseUrl)
  await page.evaluate(() => document.fonts.ready)
  await page.getByTestId('session-card').nth(6).waitFor({ state: 'attached', timeout: 30_000 })
  // Last prompts arrive after the first catalog frame.
  for (const text of ['orders.currency from the accounts', 'typed route params', 'one run in twenty']) {
    await page.getByText(text, { exact: false }).first().waitFor({ state: 'attached', timeout: 30_000 })
  }
  await page.waitForTimeout(1500)
  return page
}

const card = (page: Page, name: string) =>
  page.locator('aside:not(.session-drawer aside) [data-testid="session-card"]', { hasText: name }).first()

/**
 * Park the pointer on empty terminal space, drop keyboard focus, and wait out
 * the status-pill pulse (it plays when a session goes working -> waiting).
 */
async function rest(page: Page, ms = 3000): Promise<void> {
  const size = page.viewportSize()!
  await page.mouse.move(size.width - 24, size.height / 2)
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await page.waitForTimeout(ms)
}

async function select(page: Page, name: string): Promise<void> {
  await card(page, name).click()
  await page.getByTestId('terminal-panel').waitFor()
  await rest(page)
}

async function box(page: Page, selector: string): Promise<Box> {
  const b = await page.locator(selector).first().boundingBox()
  if (!b) throw new Error(`no box for ${selector}`)
  return b
}

const union = (a: Box, b: Box): Box => {
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y)
  return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y }
}

async function fontSizes(page: Page): Promise<Metrics> {
  return page.evaluate(() => {
    const size = (el: Element | null | undefined) => (el ? parseFloat(getComputedStyle(el).fontSize) : 0)
    const row = document.querySelector('aside [data-testid="session-card"]')
    const leaf = (root: Element | null, test: (t: string) => boolean) =>
      [...(root?.querySelectorAll('*') ?? [])].find((el) => el.children.length === 0 && test(el.textContent ?? ''))
    return {
      sessionName: size(leaf(row, (t) => t.trim() === 'orders-migration')),
      lastPrompt: size(leaf(row, (t) => t.includes('backfills'))),
      terminal: size(document.querySelector('.xterm-rows')),
    }
  })
}

export async function captureDesktop(browser: Browser, raw: string): Promise<{ crops: Crops; metrics: Metrics }> {
  const crops: Crops = {}
  let metrics: Metrics
  // Hero: a small window so it can be shown near full size.
  {
    const context = await newContext(browser, HERO, 280)
    const page = await open(context)
    await select(page, 'router-refactor')
    await page.screenshot({ path: join(raw, 'desktop-hero.png'), animations: 'disabled' })
    metrics = await fontSizes(page)
    await context.close()
  }

  const context = await newContext(browser, FEATURE, 400)
  const page = await open(context)
  const shot = (name: string) => page.screenshot({ path: join(raw, `${name}.png`), animations: 'disabled' })
  const sidebar = await box(page, 'aside:not(.session-drawer aside)')

  // Hosts: rows from both hosts, a remote session selected.
  await select(page, 'nightly-e2e')
  await shot('desktop-hosts')
  const firstRow = await card(page, 'orders-migration').boundingBox()
  const hostRows = union(firstRow!, (await card(page, 'resize-worker-bench').boundingBox())!)
  crops.hosts = { x: 0, y: hostRows.y - 30, width: sidebar.width, height: hostRows.height + 38 }

  // Pull requests: only the projects with PRs, hover the failing one.
  const toggleProjects = async () => {
    await page.getByRole('button', { name: /^Filter/ }).first().click()
    for (const project of ['acme-api', 'storefront']) {
      await page.getByRole('menuitemcheckbox', { name: project, exact: true }).click()
    }
    await page.keyboard.press('Escape')
    await page.waitForTimeout(1500)
  }
  await toggleProjects()
  // Collapse Hibernating so the hover card does not cover half-hidden rows.
  const hibernating = page.getByRole('button', { name: /^Hibernating/ })
  await hibernating.click()
  await page.waitForTimeout(600)
  const chip = card(page, 'flaky-checkout-test').locator('a[href*="/pull/"]').first()
  await chip.hover()
  await page.getByTestId('pr-hovercard').waitFor()
  await page.waitForTimeout(1500)
  await shot('desktop-pull-requests')
  const hover = await box(page, '[data-testid="pr-hovercard"]')
  const top = (await card(page, 'orders-migration').boundingBox())!
  crops['pull-requests'] = { x: 0, y: top.y - 6, width: sidebar.width, height: hover.y + hover.height + 14 - (top.y - 6) }
  await rest(page, 500)
  await toggleProjects()
  await hibernating.click()

  // History: open the React 19 conversation's transcript preview.
  await page.getByRole('button', { name: /^History/ }).click()
  await page.waitForTimeout(800)
  await page.locator('aside').getByText('upgrade the admin app', { exact: false }).first().click()
  await page.getByRole('button', { name: 'Wake', exact: true }).waitFor()
  await rest(page, 1500)
  await shot('desktop-history')
  crops.history = await page.getByRole('button', { name: 'Wake', exact: true }).evaluate((el, vw) => {
    // The dialog element spans the backdrop; walk up to the visible panel.
    let node = el as HTMLElement
    while (node.parentElement && node.parentElement.getBoundingClientRect().width < vw * 0.8) node = node.parentElement
    const r = node.getBoundingClientRect()
    return { x: r.x, y: r.y, width: r.width, height: r.height }
  }, FEATURE.width)

  await context.close()
  return { crops, metrics }
}

/** Frames of one session going working -> permission -> working. */
export async function captureLoop(
  browser: Browser,
  raw: string,
  setMode: (mode: 'working' | 'permission') => void,
): Promise<{ frames: { file: string; ms: number }[]; crop: Box }> {
  const context = await newContext(browser, LOOP, 250)
  const page = await open(context)
  setMode('working')
  await select(page, 'orders-migration')
  const frames: { file: string; ms: number }[] = []
  const start = Date.now()
  const timeline: [atMs: number, action: () => void][] = [
    [2000, () => setMode('permission')],
    [6400, () => setMode('working')],
  ]
  let i = 0
  while (Date.now() - start < 9_400) {
    const now = Date.now() - start
    while (timeline.length && timeline[0]![0] <= now) timeline.shift()![1]()
    const file = join(raw, `loop-${String(i++).padStart(3, '0')}.png`)
    await page.screenshot({ path: file, animations: 'disabled' })
    frames.push({ file, ms: Date.now() - start })
    await page.waitForTimeout(40)
  }
  await context.close()
  // Sidebar plus a sliver of terminal: enough to see the prompt card.
  return { frames, crop: { x: 0, y: 0, width: 450, height: LOOP.height - 36 } }
}

export async function capturePhones(webkit: Browser, raw: string, setMode: (id: string, mode: 'permission') => void): Promise<Crops> {
  const { viewport: _, ...iphone } = devices['iPhone 15 Pro']
  const context = await newContext(webkit, PHONE, 300, { ...iphone, deviceScaleFactor: 3 }, 15)
  const page = await open(context)
  const pick = async (name: string) => {
    await page.getByRole('button', { name: 'Open session menu' }).click()
    const drawer = page.getByRole('dialog', { name: 'Session list' })
    await drawer.getByTestId('session-card').filter({ hasText: name }).click()
    await page.waitForTimeout(3000)
  }
  const shot = (name: string) => page.screenshot({ path: join(raw, `${name}.png`), animations: 'disabled' })

  setMode('orders-migration', 'permission')
  await pick('router-refactor')
  await shot('phone-hero')

  await page.getByRole('button', { name: 'Open session menu' }).click()
  await page.waitForTimeout(1200)
  await page.getByRole('dialog', { name: 'Session list' }).evaluate((el) => {
    for (const node of [el, ...el.querySelectorAll('*')]) if (node.scrollTop) node.scrollTop = 0
  })
  await page.waitForTimeout(600)
  await shot('phone-drawer')
  await page.mouse.click(PHONE.width - 20, PHONE.height / 2)
  await page.waitForTimeout(800)

  await pick('orders-migration')
  await shot('phone-keys')

  await pick('latency-report')
  await page.locator('button[aria-label="Paste"]').click()
  const textarea = page.getByRole('textbox', { name: 'Paste here' })
  await textarea.fill([
    'GET /search     402 ms',
    'POST /checkout  231 ms',
    'did the vector cache land?',
  ].join('\n'))
  await textarea.blur()
  await page.waitForTimeout(800)
  await shot('phone-paste')
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  await page.waitForTimeout(500)

  // Media rail on the phone, for comparison with the desktop rail.
  await page.getByTestId('media-rail-pill').click()
  await page.getByTestId('media-thumbnail').nth(3).waitFor()
  await page.waitForTimeout(2500)
  await shot('phone-media')
  // The rail plus the transcript lines it was collected from.
  const rail = await box(page, '[data-testid="media-rail"]')
  const pdfLine = await page.locator('.xterm-rows > div', { hasText: 'Read PDF' }).first().boundingBox()
  const bottom = pdfLine ? pdfLine.y + pdfLine.height + 10 : rail.y + rail.height + 300

  await context.close()
  return { 'media-rail': { x: 0, y: rail.y - 8, width: PHONE.width, height: bottom - (rail.y - 8) } }
}
