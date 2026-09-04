// E2E: the DPad joystick must send the arrow key matching the finger's
// displacement from where it touched down. The ring is drawn 80px above the
// finger; before the fix direction was measured from the ring's center, so
// every gesture registered as DOWN and UP needed an 80px+ drag.
//
// Gestures are raw touch sequences dispatched through CDP so nothing but the
// page's own handlers run (Playwright's locator.tap() adds a native
// scroll-into-view that can shift the horizontally scrollable key deck).
// Results are read back from the tmux pane via the paste-repl fixture, which
// echoes each submitted line as hex.
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

const WINDOW_NAME = 'dpad-repl'
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
  return tmux(['capture-pane', '-t', target, '-p', '-S', '-200'])
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

type Move = [dx: number, dy: number, holdBeforeMs: number]

/** Touch down at (x, y), then each move after its hold, then lift. */
async function gesture(
  page: Page,
  x: number,
  y: number,
  moves: Move[],
  beforeRelease?: (cdp: CDPSession) => Promise<void>
) {
  const cdp = await page.context().newCDPSession(page)
  const point = (px: number, py: number) => [{ x: px, y: py, radiusX: 4, radiusY: 4, force: 1 }]
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: point(x, y) })
  for (const [dx, dy, hold] of moves) {
    await sleep(hold)
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: point(x + dx, y + dy) })
  }
  await sleep(120)
  await beforeRelease?.(cdp)
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await cdp.detach()
}

async function tap(page: Page, x: number, y: number) {
  await gesture(page, x, y, [[0, 0, 40]])
}

/** Tap Enter and return the decoded keys the fixture had buffered. */
async function submitAndRead(page: Page, target: string, enterX: number, enterY: number) {
  const before = hexLines(target).length
  await tap(page, enterX, enterY)
  const deadline = Date.now() + 5000
  let lines = hexLines(target)
  while (lines.length <= before && Date.now() < deadline) {
    await sleep(150)
    lines = hexLines(target)
  }
  return decode(lines[lines.length - 1] ?? '')
}

test('joystick sends the arrow matching finger displacement from touch-down', async ({ page }, testInfo) => {
  const session = process.env.E2E_TMUX_SESSION
  test.skip(!session, 'E2E_TMUX_SESSION not set')
  const target = `${session}:${WINDOW_NAME}`

  const created = tmux(['new-window', '-t', session!, '-n', WINDOW_NAME, `python3 ${REPL_PATH}`])
  expect(created.status).toBe(0)

  try {
    await page.goto('/')
    // On mobile the session list lives in a drawer: the card is in the DOM
    // but not visible, so select it with a DOM click.
    const card = page.getByTestId('session-card').filter({ hasText: WINDOW_NAME }).first()
    await card.waitFor({ state: 'attached', timeout: 20000 })
    await card.evaluate((el) => (el as HTMLElement).click())
    await expect(page.locator('.xterm')).toBeVisible()
    await sleep(2000) // let the terminal attach settle

    const dpadBox = (await page.getByRole('button', { name: 'Arrow keys' }).boundingBox())!
    const enterBox = (await page.getByRole('button', { name: 'Enter' }).boundingBox())!
    const cx = dpadBox.x + dpadBox.width / 2
    const cy = dpadBox.y + dpadBox.height / 2
    const ex = enterBox.x + enterBox.width / 2
    const ey = enterBox.y + enterBox.height / 2

    const cases: Array<[name: string, moves: Move[], expected: string]> = [
      ['long-press, hold still, release', [[0, 0, 400]], '(nothing)'],
      ['long-press, nudge 5px (dead zone)', [[0, 0, 300], [5, 0, 100]], '(nothing)'],
      ['long-press, move 40px up', [[0, 0, 300], [0, -40, 100]], 'UP'],
      ['long-press, move 40px right', [[0, 0, 300], [40, 0, 100]], 'RIGHT'],
      ['long-press, move 40px left', [[0, 0, 300], [-40, 0, 100]], 'LEFT'],
      ['long-press, move 40px down', [[0, 0, 300], [0, 40, 100]], 'DOWN'],
      ['long-press, up then right', [[0, 0, 300], [0, -40, 100], [40, 0, 300]], 'UP RIGHT'],
      ['quick tap under the long-press delay', [[0, 0, 20]], '(nothing)'],
    ]
    for (const [name, moves, expected] of cases) {
      await gesture(page, cx, cy, moves)
      expect(await submitAndRead(page, target, ex, ey), name).toBe(expected)
    }

    // Holding a direction auto-repeats it. 60px is past the clamp radius, so
    // the repeat runs at its fastest (400ms) and a 1.5s hold yields several.
    await gesture(page, cx, cy, [[0, 0, 300], [0, -60, 100], [0, -60, 1500]], async (cdp) => {
      // Captured while the finger is still down, via the same CDP session:
      // page.screenshot() re-applies mobile emulation and cancels the touch.
      const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' })
      writeFileSync(testInfo.outputPath('joystick.png'), Buffer.from(data, 'base64'))
    })
    const repeated = (await submitAndRead(page, target, ex, ey)).split(' ')
    expect(repeated.length, `auto-repeat sent ${repeated.join(' ')}`).toBeGreaterThanOrEqual(2)
    expect(repeated.every((key) => key === 'UP'), repeated.join(' ')).toBe(true)

    // None of that may have panned the horizontally scrollable key deck.
    const deckScroll = await page.evaluate(
      () => (document.querySelector('.grid-flow-col') as HTMLElement | null)?.scrollLeft
    )
    expect(deckScroll).toBe(0)
  } finally {
    tmux(['kill-window', '-t', target])
  }
})
