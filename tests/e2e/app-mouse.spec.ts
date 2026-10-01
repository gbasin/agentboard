// E2E: mouse input must keep reaching the pane after switching between two
// mouse-reporting apps. Regression test for the stale-appMouse bug: a
// session switch runs terminal.reset(), which wipes xterm's DECSET mouse
// modes, but the appMouse flag survived — so no false→true transition ever
// re-emitted ENABLE_MOUSE_TRACKING and drags became dead DOM selections.
// Both fixture windows enable mouse reporting BEFORE the browser attaches,
// matching Claude/Codex panes where mouse_any_flag=1.
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { test, expect, type Page } from '@playwright/test'

test.use({ viewport: { width: 1440, height: 900 } })

const WINDOW_A = 'mouse-a'
const WINDOW_B = 'mouse-b'
const REPL_PATH = fileURLToPath(new URL('./fixtures/mouse-repl.py', import.meta.url))

function tmux(args: string[]): { status: number | null; stdout: string } {
  const result = spawnSync('tmux', args, { encoding: 'utf-8' })
  return { status: result.status, stdout: result.stdout ?? '' }
}

function capturePane(target: string): string {
  return tmux(['capture-pane', '-t', target, '-p']).stdout
}

async function waitForPaneText(
  target: string,
  needle: string,
  timeoutMs = 10000
): Promise<string> {
  const deadline = Date.now() + timeoutMs
  let content = ''
  while (Date.now() < deadline) {
    content = capturePane(target)
    if (content.includes(needle)) return content
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(
    `Timed out waiting for ${JSON.stringify(needle)} in pane ${target}. Last content:\n${content}`
  )
}

async function selectSession(page: Page, name: string) {
  const card = page.getByTestId('session-card').filter({ hasText: name }).first()
  await expect(card).toBeVisible({ timeout: 20000 })
  await card.click()
  await expect(page.locator('.xterm')).toBeVisible()
  // The copy-mode poll runs every 750ms; wait past one interval plus the
  // attach round-trip so ENABLE_MOUSE_TRACKING has been applied.
  await page.waitForTimeout(2500)
}

async function dragInTerminal(page: Page) {
  const box = await page.locator('.xterm').boundingBox()
  if (!box) throw new Error('xterm not visible')
  const y = box.y + box.height / 2
  await page.mouse.move(box.x + 80, y)
  await page.mouse.down()
  await page.mouse.move(box.x + 320, y, { steps: 8 })
  await page.mouse.up()
}

test('mouse input is forwarded to both panes across a session switch', async ({ page }) => {
  const session = process.env.E2E_TMUX_SESSION
  test.skip(!session, 'E2E_TMUX_SESSION not set')
  const targetA = `${session}:${WINDOW_A}`
  const targetB = `${session}:${WINDOW_B}`

  // terminal-input frames the browser actually sent — if xterm's mouse
  // tracking is off, a drag degrades to a DOM selection and no SGR ever
  // leaves the client, regardless of what tmux/the pane would do with it.
  const inputFrames: string[] = []
  page.on('websocket', (ws) =>
    ws.on('framesent', (f) => {
      const payload = String(f.payload ?? '')
      if (payload.includes('terminal-input')) inputFrames.push(payload)
    })
  )
  const sgrSent = () =>
    inputFrames.some((f) => f.includes('\\u001b[<') || f.includes('\u001b[<'))

  for (const [name, arg] of [[WINDOW_A, 'A'], [WINDOW_B, 'B']] as const) {
    const created = tmux([
      'new-window', '-t', session!, '-n', name,
      `python3 ${REPL_PATH} ${arg}`,
    ])
    expect(created.status).toBe(0)
  }

  try {
    await waitForPaneText(targetA, 'MOUSE-REPL READY')
    await waitForPaneText(targetB, 'MOUSE-REPL READY')

    await page.goto('/')

    // Attach to A and drag — SGR mouse reports must reach the pane.
    await selectSession(page, WINDOW_A)
    await dragInTerminal(page)
    await waitForPaneText(targetA, 'MOUSESEQ')
    expect(sgrSent()).toBe(true)

    // Switch to B (also mouse=1): xterm's DECSET mouse modes can be lost
    // without an appMouse false→true transition, so the client must keep
    // re-asserting ENABLE_MOUSE_TRACKING. The drag must still produce SGR
    // input frames and reach the pane — this is the regression assertion.
    inputFrames.length = 0
    await selectSession(page, WINDOW_B)
    await dragInTerminal(page)
    await waitForPaneText(targetB, 'MOUSESEQ')
    expect(sgrSent()).toBe(true)
  } finally {
    tmux(['kill-window', '-t', targetA])
    tmux(['kill-window', '-t', targetB])
  }
})

test('forced local selection survives the appMouse status poll', async ({ page }) => {
  const session = process.env.E2E_TMUX_SESSION
  test.skip(!session, 'E2E_TMUX_SESSION not set')
  const targetA = `${session}:${WINDOW_A}`

  // Selection children only exist under the DOM renderer — force it off WebGL
  // before the app reads its persisted settings.
  await page.addInitScript(() => {
    const raw = localStorage.getItem('agentboard-settings')
    let stored: { state?: Record<string, unknown>; version?: number } = {}
    try {
      stored = JSON.parse(raw ?? '') || {}
    } catch {
      /* fresh state */
    }
    stored.state = { ...stored.state, useWebGL: false }
    stored.version = 8
    localStorage.setItem('agentboard-settings', JSON.stringify(stored))
  })

  const created = tmux([
    'new-window', '-t', session!, '-n', WINDOW_A,
    `python3 ${REPL_PATH} A`,
  ])
  expect(created.status).toBe(0)

  // Forensics: a completed selection is cleared by onUserInput (input sent),
  // onResize (rowsChanged), trim, or buffer-activate — input/resize leave as
  // WS frames, so log every sent frame with a timestamp.
  const sentFrames: string[] = []
  const modeFrames: string[] = []
  page.on('websocket', (ws) => {
    ws.on('framesent', (f) =>
      sentFrames.push(`${Date.now()}:${String(f.payload ?? '').slice(0, 80)}`)
    )
    ws.on('framereceived', (f) => {
      const p = String(f.payload ?? '')
      if (p.includes('\\u001b[?') || p.includes('\u001b[?'))
        modeFrames.push(`${Date.now()}:${p.slice(0, 160)}`)
    })
  })

  try {
    await waitForPaneText(targetA, 'MOUSE-REPL READY')
    await page.goto('/')
    await selectSession(page, WINDOW_A)
    await expect(page.locator('.xterm.enable-mouse-events')).toBeVisible()

    const selKids = () => page.locator('.xterm-selection > *').count()

    // Force a local selection while the pane app owns the mouse: Option+drag
    // on macOS (macOptionClickForcesSelection), Shift+drag elsewhere. Hold
    // both so the spec works on either platform.
    const box = await page.locator('.xterm').boundingBox()
    if (!box) throw new Error('xterm not visible')
    const y = box.y + box.height / 2
    await page.keyboard.down('Alt')
    await page.keyboard.down('Shift')
    await page.mouse.move(box.x + 80, y)
    await page.mouse.down()
    await page.mouse.move(box.x + 320, y, { steps: 8 })
    await expect.poll(selKids).toBeGreaterThan(0)

    // Regression: the 750ms appMouse poll used to rewrite ENABLE_MOUSE_TRACKING
    // unconditionally, and every DECSET fires xterm's onProtocolChange →
    // selectionService.disable() → clearSelection() — killing a live drag and
    // detaching its document listeners. Hold across two poll intervals.
    const trace: string[] = []
    const t0 = Date.now()
    for (let i = 0; i < 20; i++) {
      const kids = await selKids()
      const mouseCls = await page.locator('.xterm.enable-mouse-events').count()
      trace.push(`${Date.now() - t0}ms kids=${kids} cls=${mouseCls}`)
      if (kids === 0) break
      await page.waitForTimeout(100)
    }
    // Still holding the button — keep extending to prove the drag is alive.
    await page.mouse.move(box.x + 420, y + 20, { steps: 4 })
    await page.mouse.up()
    await page.keyboard.up('Shift')
    await page.keyboard.up('Alt')

    // A completed selection must also survive the poll (it used to be cleared
    // ≤750ms later, before the user could copy).
    const post: string[] = []
    for (let i = 0; i < 16; i++) {
      const kids = await selKids()
      post.push(kids === 0 ? '0' : String(kids))
      await page.waitForTimeout(100)
    }
    expect(
      post.includes('0'),
      `selection cleared post-release; selKids trace: [${post.join(',')}]; hold trace: ${trace.join(' | ')}; sent: ${sentFrames.slice(-15).join(' || ')}; modeFrames: ${modeFrames.slice(-15).join(' || ')}`
    ).toBe(false)
  } finally {
    tmux(['kill-window', '-t', targetA])
  }
})
