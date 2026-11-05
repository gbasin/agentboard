// capture.ts - Drives the real Agentboard UI and saves raw screenshots.
//
// Desktop shots: Chromium at 2x. Phone shots: WebKit with an iPhone profile
// at 3x. Every page starts from the same per-device settings (light theme, a
// wider sidebar) so the shots match. Raw files go to `raw/`; composite.ts
// turns them into the published images.

import { devices, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { join } from 'node:path'
import { baseUrl } from './instance'

export const DESKTOP = { width: 1280, height: 800 }
export const PHONE = { width: 393, height: 852 }

export type Box = { x: number; y: number; width: number; height: number }
/** Crop boxes (CSS px) measured on the live page, keyed by feature. */
export type Crops = Record<string, Box>

/** Per-device UI settings, as the app persists them in localStorage. */
export function seedStorage(sidebarWidth: number) {
  return `
    localStorage.setItem('agentboard-theme', JSON.stringify({ state: { theme: 'light' }, version: 0 }));
    localStorage.setItem('agentboard-settings', JSON.stringify({
      state: { sidebarWidth: ${sidebarWidth}, useWebGL: false, hibernatingSessionsExpanded: true, historySessionsExpanded: false },
      version: 8,
    }));`
}

export async function open(context: BrowserContext): Promise<Page> {
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

/** Park the pointer where it cannot hover anything, then let the UI settle. */
async function rest(page: Page, ms = 900): Promise<void> {
  await page.mouse.move(DESKTOP.width - 40, DESKTOP.height - 120)
  await page.waitForTimeout(ms)
}

async function select(page: Page, name: string): Promise<void> {
  await card(page, name).click()
  await page.getByTestId('terminal-panel').waitFor()
  await rest(page, 2500)
}

async function box(page: Page, selector: string): Promise<Box> {
  const b = await page.locator(selector).first().boundingBox()
  if (!b) throw new Error(`no box for ${selector}`)
  return b
}

export async function captureDesktop(browser: Browser, raw: string): Promise<Crops> {
  const context = await browser.newContext({
    viewport: DESKTOP, deviceScaleFactor: 2, colorScheme: 'light', serviceWorkers: 'block',
  })
  await context.addInitScript(seedStorage(300))
  const page = await open(context)
  const crops: Crops = {}
  const shot = (name: string, clip?: Box) => page.screenshot({ path: join(raw, `${name}.png`), clip })

  // Hero: the board with the router refactor selected.
  await select(page, 'router-refactor')
  await shot('desktop-hero')

  // Pull requests: hover the failing PR's chip so its CI card opens.
  await card(page, 'flaky-checkout-test').locator('a[href*="/pull/"]').first().hover()
  await page.getByTestId('pr-hovercard').waitFor()
  await page.waitForTimeout(1200)
  await shot('desktop-pull-requests')
  await rest(page)

  // Media rail: the latency report, rail open.
  await select(page, 'latency-report')
  await page.getByTestId('media-rail-pill').click()
  await page.getByTestId('media-thumbnail').nth(2).waitFor()
  await rest(page, 1500)
  await shot('desktop-media-rail')
  crops.media = await box(page, '[data-testid="media-rail"]')
  await page.getByTestId('media-thumb').nth(2).click()
  await page.getByTestId('media-lightbox').waitFor()
  await rest(page, 2000)
  await shot('desktop-lightbox')
  crops.lightbox = await box(page, '[data-testid="media-lightbox"]')
  await page.keyboard.press('Escape')
  await page.waitForTimeout(500)
  await page.getByLabel('Collapse media rail').click()

  // History: expand it and open a transcript preview.
  await page.getByRole('button', { name: /^History/ }).click()
  await page.waitForTimeout(800)
  await page.locator('aside').getByText('upgrade the admin app', { exact: false }).first().click()
  await page.getByRole('button', { name: 'Wake', exact: true }).waitFor()
  await rest(page, 1200)
  await shot('desktop-history')
  crops.preview = await page.getByRole('button', { name: 'Wake', exact: true }).evaluate((el, vw) => {
    // The dialog element spans the backdrop; walk up to the visible panel.
    let node: HTMLElement | null = el as HTMLElement
    while (node.parentElement && node.parentElement.getBoundingClientRect().width < vw * 0.8) node = node.parentElement
    const r = node.getBoundingClientRect()
    return { x: r.x, y: r.y, width: r.width, height: r.height }
  }, DESKTOP.width)
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: /^History/ }).click()

  // Hosts: a session on the remote host selected, next to local ones.
  await select(page, 'nightly-e2e')
  await page.locator('aside').first().evaluate((el) => {
    for (const node of [el, ...el.querySelectorAll('*')]) if (node.scrollTop) node.scrollTop = 0
  })
  await page.waitForTimeout(1500)
  await shot('desktop-hosts')

  await context.close()
  return crops
}

/** Frames of one session going working -> permission -> working. */
export async function captureLoop(
  browser: Browser,
  raw: string,
  setMode: (mode: 'working' | 'permission') => void,
): Promise<{ file: string; ms: number }[]> {
  const context = await browser.newContext({
    viewport: { width: 860, height: 540 }, deviceScaleFactor: 1.25, colorScheme: 'light', serviceWorkers: 'block',
  })
  await context.addInitScript(seedStorage(300))
  const page = await open(context)
  setMode('working')
  await select(page, 'orders-migration')
  await page.waitForTimeout(3000)
  const frames: { file: string; ms: number }[] = []
  const start = Date.now()
  const timeline: [atMs: number, action: () => void][] = [
    [2200, () => setMode('permission')],
    [6800, () => setMode('working')],
  ]
  let i = 0
  while (Date.now() - start < 10_000) {
    const now = Date.now() - start
    while (timeline.length && timeline[0]![0] <= now) timeline.shift()![1]()
    const file = join(raw, `loop-${String(i++).padStart(3, '0')}.png`)
    await page.screenshot({ path: file })
    frames.push({ file, ms: Date.now() - start })
    await page.waitForTimeout(60)
  }
  await context.close()
  return frames
}

export async function capturePhones(webkit: Browser, raw: string, setMode: (id: string, mode: 'permission') => void): Promise<void> {
  const context = await webkit.newContext({
    ...devices['iPhone 15 Pro'], viewport: PHONE, colorScheme: 'light', serviceWorkers: 'block',
  })
  await context.addInitScript(seedStorage(300))
  const page = await open(context)
  const pick = async (name: string) => {
    await page.getByRole('button', { name: 'Open session menu' }).click()
    const drawer = page.getByRole('dialog', { name: 'Session list' })
    await drawer.getByTestId('session-card').filter({ hasText: name }).click()
    await page.waitForTimeout(3000)
  }
  const shot = (name: string) => page.screenshot({ path: join(raw, `${name}.png`) })

  setMode('orders-migration', 'permission')
  await pick('router-refactor')
  await shot('phone-hero')

  await page.getByRole('button', { name: 'Open session menu' }).click()
  await page.waitForTimeout(1200)
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

  await context.close()
}
