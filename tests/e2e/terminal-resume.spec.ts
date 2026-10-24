// Real browser + application + tmux regression tests. Visibility events below
// are synthetic; the Chromium freeze test suspends its renderer processes. Neither
// substitutes for iOS Simulator/device suspension and networking validation.
import { test as base, expect, type Page, type WebSocketRoute } from '@playwright/test'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { shellQuote } from '../../src/server/shellQuote'

type Frame = { type: string; sessionId?: string; data?: string; seq?: number; attachId?: number; cols?: number; rows?: number }
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
  holdAcks = false
  openedAt: number[] = []
  closed: Array<{ code: number; at: number }> = []
  holdPongs = false
  holdReadyFor: string | null = null
  private held: Array<{ ws: WebSocketRoute; message: string | Buffer }> = []
  private heldReady: Array<{ ws: WebSocketRoute; message: string | Buffer }> = []
  private currentSocket: WebSocketRoute | null = null
  async install(page: Page) {
    await page.routeWebSocket(/\/ws(?:\?|$)/, ws => {
      this.connections++
      this.openedAt.push(Date.now())
      this.currentSocket = ws
      const server = ws.connectToServer()
      ws.onMessage(message => {
        const frame = JSON.parse(String(message)) as Frame
        this.sent.push(frame)
        if (frame.type !== 'terminal-ack' || !this.holdAcks) server.send(message)
      })
      server.onClose((code, reason) => {
        this.closed.push({ code, at: Date.now() })
        ws.close({ code, reason })
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
  async installNativePressure(page: Page) {
    await page.exposeFunction('__pressureClose', (code: number) => { this.closed.push({ code, at: Date.now() }) })
    await page.addInitScript(() => {
      const state = window as unknown as { __holdPressureAcks: boolean; __pressureClose(code: number): Promise<void> }
      state.__holdPressureAcks = true
      const NativeSocket = window.WebSocket
      window.WebSocket = class extends NativeSocket {
        constructor(url: string | URL, protocols?: string | string[]) {
          super(url, protocols)
          this.addEventListener('close', event => { void state.__pressureClose(event.code) })
        }
        send(data: string | ArrayBufferLike | Blob | ArrayBufferView) {
          if (typeof data === 'string' && state.__holdPressureAcks && JSON.parse(data).type === 'terminal-ack') return
          super.send(data)
        }
      }
    })
    page.on('websocket', socket => {
      this.connections++
      this.openedAt.push(Date.now())
      socket.on('framesent', event => { this.sent.push(JSON.parse(String(event.payload))) })
      socket.on('framereceived', event => { this.received.push(JSON.parse(String(event.payload))) })
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
  await expect(page.getByTestId('terminal-recovery-status')).toHaveCount(0)
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
  await expect(page.getByTestId('terminal-recovery-status')).toContainText('Reconnecting')
  await expect(page.getByTestId('terminal-recovery-status')).toContainText('Input paused')
  await write(page, 'BLOCKED_KEY')
  await paste(page, 'BLOCKED_PASTE')
  expect(wire.inputContaining('BLOCKED_')).toHaveLength(0)
  expect(panes.a.capture()).not.toContain('BLOCKED_')
  expect(wire.connections).toBe(connections)
  wire.releasePongs()
  await expect.poll(() => wire.readyCount(panes.a.id)).toBeGreaterThan(before)
  await expect(page.getByTestId('terminal-recovery-status')).toHaveCount(0)
  await page.getByRole('button', { name: 'Discard text', exact: true }).click()
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
  await page.getByRole('button', { name: 'Discard text', exact: true }).click()
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
  await page.getByRole('button', { name: 'Discard text', exact: true }).click()
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
  const loading = page.getByTestId('terminal-recovery-status')
  await expect(loading).toBeVisible()
  wire.releaseReady()
  await expect(loading).toHaveCount(0)
  await page.getByRole('button', { name: 'Discard text', exact: true }).click()
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

for (const sizing of ['latest', 'smallest']) {
  test(`background phone releases shared pane dimensions (${sizing})`, async ({ page, browser, panes }) => {
    privateTmux('set-window-option', '-t', panes.a.id, 'window-size', sizing)
    const desktop = new Wire()
    await desktop.install(page)
    await page.goto('/')
    await select(page, panes.a, desktop)
    const desktopCols = desktop.sent.findLast(f => f.type === 'terminal-attach')!.cols!
    const width = () => Number(privateTmux('display-message', '-p', '-t', panes.a.id, '#{pane_width}'))
    await expect.poll(width).toBe(desktopCols)
    const phoneContext = await browser.newContext({ viewport: { width: 1440, height: 900 } })
    try {
      const phone = await phoneContext.newPage()
      const mobile = new Wire()
      await mobile.install(phone)
      await phone.goto(new URL('/', page.url()).href)
      await select(phone, panes.a, mobile)
      await phone.setViewportSize({ width: 390, height: 844 })
      await expect.poll(() => mobile.sent.some(f => f.type === 'terminal-resize' && f.cols! < desktopCols)).toBe(true)
      const phoneCols = mobile.sent.findLast(f => f.type === 'terminal-resize')!.cols!
      await expect.poll(width).toBe(phoneCols)
      await visibility(phone, 'hidden')
      // No desktop keystroke or resize may be needed to reclaim its width.
      await expect.poll(width).toBe(desktopCols)
      const ready = mobile.readyCount(panes.a.id)
      await visibility(phone, 'visible')
      await expect.poll(() => mobile.readyCount(panes.a.id)).toBeGreaterThan(ready)
      await expect.poll(width).toBe(phoneCols)
      await write(phone, 'PHONE_RETURNED_ONCE')
      await expect.poll(() => panes.a.capture().split('PHONE_RETURNED_ONCE').length - 1).toBe(1)
      await phoneContext.close()
      await expect.poll(width).toBe(desktopCols)
      await write(page, 'DESKTOP_STILL_READY')
      await expect.poll(panes.a.capture).toContain('DESKTOP_STILL_READY')
    } finally { await phoneContext.close() }
  })
}

test('real output overload backs off and recovers once the producer stops', async ({ page, panes }, testInfo) => {
  test.setTimeout(60_000)
  const producer = path.resolve('tests/e2e/fixtures/terminalFlood.ts')
  privateTmux('respawn-window', '-k', '-t', panes.a.id, `stty -echo; exec bun ${shellQuote(producer)}`)
  const wire = new Wire()
  await wire.installNativePressure(page)
  await page.goto('/')
  await select(page, panes.a, wire)
  try {
  await write(page, 'FLOOD')
  await expect.poll(() => wire.received.filter(f => f.type === 'terminal-overload').length, { timeout: 35_000 }).toBeGreaterThanOrEqual(3)
  // Stop while cooling down, before the next snapshot starts streaming.
  privateTmux('send-keys', '-t', panes.a.id, 'STOP', 'Enter')
  await page.evaluate(() => { (window as unknown as { __holdPressureAcks: boolean }).__holdPressureAcks = false })
  await expect.poll(() => wire.connections, { timeout: 12_000 }).toBeGreaterThanOrEqual(4)
  const closures = wire.closed
  // Browser scheduling may add delay; it must not skip the retry floor.
  for (let i = 0; i < 3; i++) expect(wire.openedAt[i + 1]! - closures[i]!.at).toBeGreaterThanOrEqual(900 * 2 ** i)
  // Recovery uses the manager's own retry and retained lease, without a reload.
  await expect.poll(() => wire.readyCount(panes.a.id), { timeout: 15_000 }).toBeGreaterThanOrEqual(4)
  await expect(page.getByTestId('terminal-recovery-status')).toHaveCount(0)
  await write(page, 'PRESSURE_RECOVERED_ONCE')
  await expect.poll(() => panes.a.capture().split('PRESSURE_RECOVERED_ONCE').length - 1).toBe(1)
  } finally {
    console.log('pressure-summary', JSON.stringify({ openedAt: wire.openedAt, closed: wire.closed, inputs: wire.sent.filter(f => f.type === 'terminal-input'), ready: wire.readyCount(panes.a.id), outputs: wire.received.filter(f => f.type === 'terminal-output').length }))
    await testInfo.attach('pressure-transport', { body: JSON.stringify({ openedAt: wire.openedAt, closed: wire.closed, inputs: wire.sent.filter(f => f.type === 'terminal-input'), ready: wire.readyCount(panes.a.id), outputs: wire.received.filter(f => f.type === 'terminal-output').length }), contentType: 'application/json' })
  }
})

test('recovery text stays with its terminal until explicitly reviewed and sent', async ({ page, panes }, testInfo) => {
  const wire = new Wire()
  await wire.install(page)
  await page.goto('/')
  await select(page, panes.a, wire)
  wire.holdPongs = true
  await visibility(page, 'hidden')
  await visibility(page, 'visible')
  await write(page, 'UNSENT_ORIGINAL')
  await paste(page, 'PASTED_DRAFT')
  const draft = page.getByRole('textbox', { name: /Unsent text for/ })
  await expect(draft).toHaveValue('UNSENT_ORIGINAL\nPASTED_DRAFT')
  await expect(page.getByRole('button', { name: 'Send text', exact: true })).toBeDisabled()
  wire.releasePongs()
  await expect(page.getByTestId('terminal-recovery-status')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Send text', exact: true })).toBeEnabled()
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(page.getByRole('button', { name: 'esc', exact: true })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Enter', exact: true })).toBeDisabled()
  await expect(page.getByText('Terminal keys are paused until this draft is sent or discarded. You can keep editing here.')).toBeVisible()
  const screenshot = testInfo.outputPath('draft-controls-paused.png')
  await page.screenshot({ path: screenshot })
  await testInfo.attach('draft controls visibly paused', { path: screenshot, contentType: 'image/png' })
  await page.setViewportSize({ width: 1440, height: 900 })
  expect(wire.inputContaining('UNSENT_ORIGINAL')).toHaveLength(0)
  await write(page, '_STILL_A_DRAFT')
  await expect(draft).toHaveValue('UNSENT_ORIGINAL\nPASTED_DRAFT_STILL_A_DRAFT\n')
  expect(wire.inputContaining('_STILL_A_DRAFT')).toHaveLength(0)
  await select(page, panes.b, wire)
  await expect(draft).toHaveCount(0)
  await write(page, 'LIVE_B')
  await expect.poll(panes.b.capture).toContain('LIVE_B')
  await select(page, panes.a, wire)
  await expect(draft).toHaveValue('UNSENT_ORIGINAL\nPASTED_DRAFT_STILL_A_DRAFT\n')
  await draft.fill('REVIEWED_ONLY')
  await page.getByRole('button', { name: 'Send text', exact: true }).click()
  await expect(draft).toHaveCount(0)
  expect(wire.sent.filter(f => f.type === 'terminal-paste' && f.data === 'REVIEWED_ONLY')).toHaveLength(1)
  // Enter is a separate explicit gesture after reviewing/sending the text.
  await write(page, '')
  await expect.poll(() => panes.a.capture().split('REVIEWED_ONLY').length - 1).toBe(1)
  expect(panes.b.capture()).not.toContain('REVIEWED_ONLY')
  expect(panes.a.capture()).not.toContain('UNSENT_ORIGINAL')
})

test('locally saved recovery text survives reload and a new document until explicit discard', async ({ page, browser, panes }) => {
  const wire = new Wire()
  await wire.install(page)
  await page.goto('/')
  await select(page, panes.a, wire)
  wire.holdPongs = true
  await visibility(page, 'hidden')
  await visibility(page, 'visible')
  await write(page, 'PERSISTED_REVIEW_ONLY')
  await expect(page.getByRole('textbox', { name: /Unsent text for/ })).toHaveValue('PERSISTED_REVIEW_ONLY\n')
  const record = (await (await page.request.get('/api/sessions')).json()).find((item: { id: string }) => item.id === panes.a.id)
  wire.inject({ type: 'session-update', session: { ...record, createdAt: new Date().toISOString() } } as Frame)
  await expect(page.getByRole('textbox', { name: /Unsent text for/ })).toHaveValue('PERSISTED_REVIEW_ONLY\n')
  wire.releasePongs()
  await page.reload()
  await expect(page.getByRole('textbox', { name: /Unsent text for/ })).toHaveValue('PERSISTED_REVIEW_ONLY\n')
  await expect(page.getByRole('button', { name: 'Send text', exact: true })).toBeEnabled()
  expect(wire.inputContaining('PERSISTED_REVIEW_ONLY')).toHaveLength(0)
  expect(panes.a.capture()).not.toContain('PERSISTED_REVIEW_ONLY')
  // A new browser document has no shared React or module memory. Restore only
  // persisted browser storage, as after Safari discards and recreates a tab.
  const fresh = await browser.newContext({ storageState: await page.context().storageState(), viewport: { width: 1440, height: 900 } })
  try {
    const restored = await fresh.newPage()
    const newWire = new Wire()
    await newWire.install(restored)
    await restored.goto(page.url())
    await expect(restored.getByRole('textbox', { name: /Unsent text for/ })).toHaveValue('PERSISTED_REVIEW_ONLY\n')
    await expect(restored.getByRole('button', { name: 'Send text', exact: true })).toBeEnabled()
    expect(newWire.inputContaining('PERSISTED_REVIEW_ONLY')).toHaveLength(0)
    await restored.getByRole('button', { name: 'Discard text', exact: true }).click()
    await restored.reload()
    await expect(restored.getByTestId('terminal-recovery-status')).toHaveCount(0)
    await expect(restored.getByRole('textbox', { name: /Unsent text for/ })).toHaveCount(0)
    expect(panes.a.capture()).not.toContain('PERSISTED_REVIEW_ONLY')
  } finally { await fresh.close() }
  const sibling = await page.context().newPage()
  await sibling.goto(page.url())
  await expect(sibling.getByRole('textbox', { name: /Unsent text for/ })).toHaveValue('PERSISTED_REVIEW_ONLY\n')
  await sibling.getByRole('button', { name: 'Discard text', exact: true }).click()
  await expect(page.getByRole('textbox', { name: /Unsent text for/ })).toHaveCount(0)
  await page.reload()
  await expect(page.getByRole('textbox', { name: /Unsent text for/ })).toHaveCount(0)
  await sibling.close()
})
