// E2E: the arrow-key cluster. Tapping ✥ shows ↑ ← ↓ → floating above the
// key deck without reflowing it; a tap sends one arrow, a hold repeats, and
// tapping outside closes it. Touches are raw CDP touch sequences (Playwright's
// locator.tap() adds a native scroll-into-view that can pan the deck) and
// keys are read back from the tmux pane via the paste-repl fixture.
import { writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { test, expect, type CDPSession, type Page } from '@playwright/test'

test.use({
  userAgent:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
})

const WINDOW_NAME = 'arrows-repl'
const REPL_PATH = fileURLToPath(new URL('./fixtures/paste-repl.py', import.meta.url))
const ARROWS: Record<string, string> = {
  '1b5b41': 'UP',
  '1b5b42': 'DOWN',
  '1b5b43': 'RIGHT',
  '1b5b44': 'LEFT',
}

function tmux(args: string[]): { status: number | null; stdout: string } {
  const result = spawnSync('tmux', args, { encoding: 'utf-8' })
  return { status: result.status, stdout: result.stdout ?? '' }
}

function hexLines(target: string): string[] {
  // -J joins wrapped rows: a held key produces a hex line wider than the pane.
  return tmux(['capture-pane', '-t', target, '-p', '-J', '-S', '-200'])
    .stdout.split('\n')
    .filter((line) => line.startsWith('INPUT_HEX:'))
    .map((line) => line.slice('INPUT_HEX:'.length))
}

function decode(hex: string): string {
  const keys: string[] = []
  for (let i = 0; i < hex.length; i += 6) {
    const chunk = hex.slice(i, i + 6)
    keys.push(ARROWS[chunk] ?? `?${chunk}`)
  }
  return keys.join(' ') || '(nothing)'
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function touch(
  page: Page,
  x: number,
  y: number,
  holdMs: number,
  whileHeld?: (cdp: CDPSession) => Promise<void>
) {
  const cdp = await page.context().newCDPSession(page)
  const point = [{ x, y, radiusX: 4, radiusY: 4, force: 1 }]
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: point })
  await sleep(holdMs)
  await whileHeld?.(cdp)
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await cdp.detach()
}

async function center(page: Page, name: string) {
  const box = (await page.getByRole('button', { name, exact: true }).boundingBox())!
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}

async function deckLayout(page: Page) {
  return page.evaluate(() => {
    const deck = document.querySelector('.grid-flow-col') as HTMLElement
    const keys = Array.from(deck.querySelectorAll('button.terminal-key')).map((b) => {
      const r = b.getBoundingClientRect()
      return `${Math.round(r.left)},${Math.round(r.top)}`
    })
    return { scrollLeft: deck.scrollLeft, keys: keys.join(' ') }
  })
}

test('arrow cluster: tap sends, hold repeats, deck never reflows', async ({ page }, testInfo) => {
  const session = process.env.E2E_TMUX_SESSION
  test.skip(!session, 'E2E_TMUX_SESSION not set')
  const target = `${session}:${WINDOW_NAME}`

  const created = tmux(['new-window', '-t', session!, '-n', WINDOW_NAME, `python3 ${REPL_PATH}`])
  expect(created.status).toBe(0)

  const submitAndRead = async (enter: { x: number; y: number }) => {
    const before = hexLines(target).length
    await touch(page, enter.x, enter.y, 40)
    const deadline = Date.now() + 5000
    let lines = hexLines(target)
    while (lines.length <= before && Date.now() < deadline) {
      await sleep(150)
      lines = hexLines(target)
    }
    return decode(lines[lines.length - 1] ?? '')
  }

  try {
    await page.goto('/')
    // On mobile the session list lives in a drawer: the card is in the DOM
    // but not visible, so select it with a DOM click.
    const card = page.getByTestId('session-card').filter({ hasText: WINDOW_NAME }).first()
    await card.waitFor({ state: 'attached', timeout: 20000 })
    await card.evaluate((el) => (el as HTMLElement).click())
    await expect(page.locator('.xterm')).toBeVisible()
    await sleep(2000) // let the terminal attach settle

    const trigger = await center(page, 'Arrow keys')
    const enter = await center(page, 'Enter')
    const layoutBefore = await deckLayout(page)

    const cluster = page.getByRole('group', { name: 'Arrow key cluster' })
    await expect(cluster).toHaveCount(0)

    // Open: the cluster appears above the deck and the deck does not move.
    await touch(page, trigger.x, trigger.y, 40)
    await expect(cluster).toBeVisible()
    const clusterBox = (await cluster.boundingBox())!
    const deckBox = (await page.locator('.grid-flow-col').boundingBox())!
    expect(clusterBox.y + clusterBox.height).toBeLessThanOrEqual(deckBox.y)
    expect(await deckLayout(page)).toEqual(layoutBefore)

    // Each arrow is a real 44px target.
    for (const name of ['Arrow up', 'Arrow down', 'Arrow left', 'Arrow right']) {
      const box = (await page.getByRole('button', { name, exact: true }).boundingBox())!
      expect(box.width, name).toBeGreaterThanOrEqual(44)
      expect(box.height, name).toBeGreaterThanOrEqual(44)
    }

    // Single taps send single arrows, and the cluster stays open between them.
    const up = await center(page, 'Arrow up')
    const right = await center(page, 'Arrow right')
    const left = await center(page, 'Arrow left')
    const down = await center(page, 'Arrow down')
    await touch(page, up.x, up.y, 40)
    expect(await submitAndRead(enter)).toBe('UP')
    await expect(cluster).toBeVisible()
    await touch(page, right.x, right.y, 40)
    await touch(page, left.x, left.y, 40)
    await touch(page, down.x, down.y, 40)
    expect(await submitAndRead(enter)).toBe('RIGHT LEFT DOWN')

    // A hold repeats: 400ms initial delay then every 100ms.
    await touch(page, up.x, up.y, 1000, async (cdp) => {
      const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' })
      writeFileSync(testInfo.outputPath('arrow-cluster.png'), Buffer.from(data, 'base64'))
    })
    const held = (await submitAndRead(enter)).split(' ')
    expect(held.length, held.join(' ')).toBeGreaterThanOrEqual(4)
    expect(held.every((key) => key === 'UP'), held.join(' ')).toBe(true)

    // Other deck keys stay live while the cluster is open: Esc goes through
    // and the cluster remains.
    const esc = await center(page, 'esc')
    await touch(page, esc.x, esc.y, 40)
    expect(await submitAndRead(enter)).toBe('?1b')
    await expect(cluster).toBeVisible()

    // Tapping outside (on the terminal) closes it without sending anything.
    await touch(page, 200, 400, 40)
    await expect(cluster).toHaveCount(0)
    expect(await submitAndRead(enter)).toBe('(nothing)')

    // The trigger toggles it closed too.
    await touch(page, trigger.x, trigger.y, 40)
    await expect(cluster).toBeVisible()
    await touch(page, trigger.x, trigger.y, 40)
    await expect(cluster).toHaveCount(0)

    expect(await deckLayout(page)).toEqual(layoutBefore)
  } finally {
    tmux(['kill-window', '-t', target])
  }
})
