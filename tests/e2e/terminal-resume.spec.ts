// Real browser + application + tmux regression tests. Visibility events below
// are synthetic; the Chromium freeze test suspends its renderer processes. Neither
// substitutes for iOS Simulator/device suspension and networking validation.
import { test as base, expect, type Page, type WebSocketRoute } from '@playwright/test'
import { spawnSync } from 'node:child_process'
import path from 'node:path'

type Frame = { type: string; sessionId?: string; data?: string; seq?: number; attachId?: number }
type Pane = { id: string; capture: () => string }
type Panes = { a: Pane; b: Pane }

function privateTmux(...args: string[]): string {
  const dir = process.env.E2E_TMUX_TMPDIR
  if (!dir) throw new Error('Private E2E tmux directory is required')
  const env = { ...process.env }
  delete env.TMUX
  const socket = path.join(dir, `tmux-${process.getuid?.() ?? 0}`, 'default')
  const result = spawnSync('tmux', ['-S', socket, ...args], { env, encoding: 'utf-8' })
  if (result.status !== 0) throw new Error(`Private tmux ${args[0]}: ${result.stderr}`)
  return result.stdout.trim()
}

const test = base.extend<{ panes: Panes }>({
  // Playwright inspects the destructured fixture signature.
  // eslint-disable-next-line no-empty-pattern
  panes: async ({}, use) => {
    const session = process.env.E2E_TMUX_SESSION
    if (!session) throw new Error('E2E_TMUX_SESSION is required')
    const created: string[] = []
    function pane(name: string): Pane {
      const window = privateTmux('new-window', '-P', '-F', '#{window_id}', '-t', `=${session}`,
        '-n', name, 'stty -echo; exec /bin/cat')
      const id = `${session}:${window}`
      created.push(id)
      return { id, capture: () => privateTmux('capture-pane', '-p', '-t', id, '-S', '-200') }
    }
    try { await use({ a: pane('resume-a'), b: pane('resume-b') }) }
    finally { for (const id of created) privateTmux('kill-window', '-t', id) }
  },
})

class Wire {
  sent: Frame[] = []
  received: Frame[] = []
  connections = 0
  holdPongs = false
  holdReadyFor: string | null = null
  private held: Array<{ ws: WebSocketRoute; message: string | Buffer }> = []
  private heldReady: Array<{ ws: WebSocketRoute; message: string | Buffer }> = []
  private currentSocket: WebSocketRoute | null = null

  async install(page: Page) {
    await page.routeWebSocket(/\/ws(?:\?|$)/, ws => {
      this.connections++
      this.currentSocket = ws
      const server = ws.connectToServer()
      ws.onMessage(message => {
        this.sent.push(JSON.parse(String(message)))
        server.send(message)
      })
      server.onMessage(message => {
        const frame = JSON.parse(String(message)) as Frame
        if (frame.type === 'pong' && this.holdPongs) { this.held.push({ ws, message }); return }
        if (frame.type === 'terminal-ready' && frame.sessionId === this.holdReadyFor) { this.heldReady.push({ ws, message }); return }
        this.received.push(frame)
        ws.send(message)
      })
    })
  }

  releasePongs() {
    this.holdPongs = false
    for (const { ws, message } of this.held.splice(0)) ws.send(message)
  }

  releaseReady() {
    this.holdReadyFor = null
    for (const { ws, message } of this.heldReady.splice(0)) {
      this.received.push(JSON.parse(String(message)))
      ws.send(message)
    }
  }

  inject(frame: Frame) { this.currentSocket?.send(JSON.stringify(frame)) }
  get pendingReady() { return this.heldReady.length }

  readyCount(id: string) { return this.received.filter(f => f.type === 'terminal-ready' && f.sessionId === id).length }
  inputContaining(text: string) { return this.sent.filter(f => ['terminal-input', 'terminal-paste'].includes(f.type) && f.data?.includes(text)) }
}

const card = (page: Page, pane: Pane) => page.locator(`[data-testid="session-card"][data-session-id="${pane.id}"]`).first()

async function select(page: Page, pane: Pane, wire: Wire) {
  const before = wire.readyCount(pane.id)
  await expect(card(page, pane)).toBeVisible({ timeout: 15_000 })
  await card(page, pane).click()
  await expect.poll(() => wire.readyCount(pane.id)).toBeGreaterThan(before)
  await expect(card(page, pane)).toHaveClass(/selected/)
}

async function write(page: Page, text: string) {
  // A genuine browser text-input event exercises xterm's keyboard/IME path.
  await page.locator('.xterm-helper-textarea').evaluate((textarea: HTMLTextAreaElement) => textarea.focus())
  await page.keyboard.insertText(text)
  await page.keyboard.press('Enter')
}

async function visibility(page: Page, value: 'hidden' | 'visible', extraSignals = false) {
  await page.evaluate(({ value, extraSignals }) => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => value })
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => value === 'hidden' })
    document.dispatchEvent(new Event('visibilitychange'))
    if (extraSignals) {
      window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }))
      document.dispatchEvent(new Event('visibilitychange'))
    }
  }, { value, extraSignals })
}

async function paste(page: Page, text: string) {
  await page.locator('.xterm-helper-textarea').evaluate((textarea, value) => {
    const data = new DataTransfer()
    data.setData('text/plain', value)
    textarea.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
  }, text)
}

test('resume gates keyboard and paste until verified reattach, retaining a healthy socket', async ({ page, panes }, testInfo) => {
  const wire = new Wire()
  await wire.install(page)
  await page.goto('/')
  await select(page, panes.a, wire)
  await write(page, 'before-resume')
  await expect.poll(panes.a.capture).toContain('before-resume')
  wire.holdPongs = true
  const before = wire.readyCount(panes.a.id)
  const connections = wire.connections
  await visibility(page, 'hidden')
  await visibility(page, 'visible')
  await expect.poll(() => wire.sent.filter(f => f.type === 'ping').length).toBeGreaterThan(0)
  await write(page, 'BLOCKED_KEY')
  await paste(page, 'BLOCKED_PASTE')
  expect(wire.inputContaining('BLOCKED_')).toHaveLength(0)
  expect(panes.a.capture()).not.toContain('BLOCKED_')
  expect(wire.connections).toBe(connections)
  wire.releasePongs()
  await expect.poll(() => wire.readyCount(panes.a.id)).toBeGreaterThan(before)
  await write(page, 'after-resume')
  await expect.poll(panes.a.capture).toContain('after-resume')
  await expect.poll(() => wire.received.some(f => f.type === 'terminal-output' && f.data?.includes('after-resume'))).toBe(true)
  // Allow xterm's batched write and the browser paint to finish for evidence.
  await page.waitForTimeout(100)
  const screenshot = testInfo.outputPath('resumed-terminal.png')
  await page.screenshot({ path: screenshot })
  await testInfo.attach('verified resumed terminal', { path: screenshot, contentType: 'image/png' })
  expect(panes.a.capture()).not.toContain('BLOCKED_')
  expect(wire.connections).toBe(connections)
})

test('overlapping resume signals verify once without replacing a healthy socket', async ({ page, panes }) => {
  const wire = new Wire()
  await wire.install(page)
  await page.goto('/')
  await select(page, panes.a, wire)
  wire.holdPongs = true
  const before = wire.readyCount(panes.a.id)
  const pings = wire.sent.filter(f => f.type === 'ping').length
  const connections = wire.connections
  await visibility(page, 'hidden')
  await visibility(page, 'visible', true)
  await expect.poll(() => wire.sent.filter(f => f.type === 'ping').length).toBe(pings + 1)
  wire.releasePongs()
  await expect.poll(() => wire.readyCount(panes.a.id)).toBeGreaterThan(before)
  await write(page, 'coalesced-resume')
  await expect.poll(panes.a.capture).toContain('coalesced-resume')
  expect(wire.connections).toBe(connections)
})

test('missing resume pong replaces the socket without replaying blocked input', async ({ page, panes }) => {
  const wire = new Wire()
  await wire.install(page)
  await page.goto('/')
  await select(page, panes.a, wire)
  const before = wire.readyCount(panes.a.id)
  wire.holdPongs = true
  await visibility(page, 'hidden')
  await visibility(page, 'visible')
  await write(page, 'DO_NOT_REPLAY')
  await expect.poll(() => wire.connections, { timeout: 10_000 }).toBe(2)
  // Do not release the old pong: replacement readiness must stand on its own.
  wire.holdPongs = false
  await expect.poll(() => wire.readyCount(panes.a.id)).toBeGreaterThan(before)
  await write(page, 'fresh-connection')
  await expect.poll(panes.a.capture).toContain('fresh-connection')
  expect(wire.inputContaining('DO_NOT_REPLAY')).toHaveLength(0)
  expect(panes.a.capture()).not.toContain('DO_NOT_REPLAY')
})

test('A-B-A selection during recovery accepts input only in final A', async ({ page, panes }) => {
  const wire = new Wire()
  await wire.install(page)
  await page.goto('/')
  await select(page, panes.a, wire)
  const before = wire.readyCount(panes.a.id)
  wire.holdPongs = true
  await visibility(page, 'hidden')
  await visibility(page, 'visible')
  await card(page, panes.b).click()
  await card(page, panes.a).click()
  await write(page, 'BLOCKED_SWITCH')
  expect(wire.inputContaining('BLOCKED_SWITCH')).toHaveLength(0)
  wire.releasePongs()
  await expect.poll(() => wire.readyCount(panes.a.id)).toBeGreaterThan(before)
  await write(page, 'FINAL_A_ONLY')
  await expect.poll(panes.a.capture).toContain('FINAL_A_ONLY')
  expect(panes.b.capture()).not.toContain('FINAL_A_ONLY')
  expect(panes.a.capture()).not.toContain('BLOCKED_SWITCH')
  expect(panes.b.capture()).not.toContain('BLOCKED_SWITCH')
})

test('old A readiness cannot enable input during a later B-to-A attachment', async ({ page, panes }) => {
  const wire = new Wire()
  await wire.install(page)
  await page.goto('/')
  await select(page, panes.a, wire)
  const oldReady = wire.received.find(f => f.type === 'terminal-ready' && f.sessionId === panes.a.id)!
  expect(oldReady.attachId).toEqual(expect.any(Number))
  await select(page, panes.b, wire)
  wire.holdReadyFor = panes.a.id
  await card(page, panes.a).click()
  await expect.poll(() => wire.pendingReady).toBeGreaterThan(0)
  wire.inject(oldReady)
  await write(page, 'STALE_READY_INPUT')
  expect(wire.inputContaining('STALE_READY_INPUT')).toHaveLength(0)
  expect(panes.a.capture()).not.toContain('STALE_READY_INPUT')
  const loading = page.getByTestId('terminal-panel').getByRole('status').filter({ hasText: 'Loading' })
  await expect(loading).toBeVisible()
  wire.releaseReady()
  await expect(loading).toHaveCount(0)
  await write(page, 'CURRENT_READY_INPUT')
  await expect.poll(panes.a.capture).toContain('CURRENT_READY_INPUT')
  expect(panes.b.capture()).not.toContain('CURRENT_READY_INPUT')
})

test('real browser network offline followed by reload reconnects the selected pane', async ({ page, context, panes }) => {
  const frames: Frame[] = []
  page.on('websocket', ws => ws.on('framereceived', event => { frames.push(JSON.parse(String(event.payload))) }))
  await page.goto('/')
  await expect(card(page, panes.a)).toBeVisible({ timeout: 15_000 })
  await card(page, panes.a).click()
  await expect.poll(() => frames.some(f => f.type === 'terminal-ready' && f.sessionId === panes.a.id)).toBe(true)
  await context.setOffline(true)
  await visibility(page, 'hidden')
  await context.setOffline(false)
  frames.length = 0
  await page.reload()
  await expect.poll(() => frames.some(f => f.type === 'terminal-ready' && f.sessionId === panes.a.id)).toBe(true)
  await write(page, 'after-network-reload')
  await expect.poll(panes.a.capture).toContain('after-network-reload')
})

test('suspended Chromium renderer resumes after a real scheduling gap and reattaches', async ({ page, browser, browserName, panes }) => {
  test.skip(browserName !== 'chromium' || process.platform === 'win32', 'Uses test-owned Chromium renderer PIDs and POSIX signals, not iOS emulation')
  const frames: Frame[] = []
  page.on('websocket', ws => ws.on('framereceived', event => { frames.push(JSON.parse(String(event.payload))) }))
  await page.addInitScript(() => {
    const state = window as unknown as { resumeTickCount: number }
    state.resumeTickCount = 0
    setInterval(() => state.resumeTickCount++, 50)
  })
  await page.goto('/')
  await expect(card(page, panes.a)).toBeVisible({ timeout: 15_000 })
  await card(page, panes.a).click()
  await expect.poll(() => frames.some(f => f.type === 'terminal-ready' && f.sessionId === panes.a.id)).toBe(true)
  const session = await browser.newBrowserCDPSession()
  // The browser-scoped API identifies only processes belonging to this
  // Playwright-launched browser, never the user's Chrome/Safari processes.
  const { processInfo } = await session.send('SystemInfo.getProcessInfo')
  const renderers = processInfo.filter((p: { type: string }) => p.type === 'renderer')
  expect(renderers.length).toBeGreaterThan(0)
  const ticks = await page.evaluate(() => (window as unknown as { resumeTickCount: number }).resumeTickCount)
  const before = frames.filter(f => f.type === 'terminal-ready' && f.sessionId === panes.a.id).length
  const stopped: number[] = []
  const resumeErrors: unknown[] = []
  try {
    for (const renderer of renderers) {
      process.kill(renderer.id, 'SIGSTOP')
      stopped.push(renderer.id)
    }
    // Wall-clock wait in the test runner: no page.clock or synthetic timers.
    // Page.setWebLifecycleState proved insufficient in this harness: the
    // page's independent interval kept running during the requested freeze.
    await new Promise(resolve => setTimeout(resolve, 16_000))
  } finally {
    for (const pid of stopped) {
      try { process.kill(pid, 'SIGCONT') }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') resumeErrors.push(error) }
    }
  }
  expect(resumeErrors).toEqual([])
  const afterTicks = await page.evaluate(() => (window as unknown as { resumeTickCount: number }).resumeTickCount)
  expect(afterTicks - ticks).toBeLessThan(20) // 320 ticks would have run without freezing.
  await expect.poll(() => frames.filter(f => f.type === 'terminal-ready' && f.sessionId === panes.a.id).length,
    { timeout: 12_000 }).toBeGreaterThan(before)
  await write(page, 'after-real-freeze')
  await expect.poll(panes.a.capture).toContain('after-real-freeze')
  await session.detach()
})
