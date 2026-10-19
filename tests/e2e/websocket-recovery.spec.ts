import { test as base, expect } from '@playwright/test'
import { spawnSync } from 'node:child_process'
import path from 'node:path'

const test = base.extend<{ target: string }>({
  target: async ({}, use) => {
    const root = process.env.E2E_TMUX_TMPDIR
    const session = process.env.E2E_TMUX_SESSION
    if (!root || !session) throw new Error('Private E2E tmux is required')
    const env = { ...process.env }
    delete env.TMUX
    const socket = path.join(root, `tmux-${process.getuid?.() ?? 0}`, 'default')
    const created = spawnSync('tmux', ['-S', socket, 'new-window', '-P', '-F', '#{window_id}', '-t', `=${session}`, '-c', root, '-n', 'ws-recovery-test', '/bin/sh'], { env, encoding: 'utf-8' })
    expect(created.status, created.stderr).toBe(0)
    const target = `${session}:${created.stdout.trim()}`
    try { await use(target) } finally {
      spawnSync('tmux', ['-S', socket, 'kill-window', '-t', target], { env })
    }
  },
})

test.use({ serviceWorkers: 'block' })

// The actual app and server exchange frames. Only pong delivery is interrupted;
// virtual browser time exercises heartbeat deadlines without a 90-second sleep.
test('missing pongs reconnect and reattach without retaining closed sockets', async ({ page, target }) => {
  const logs: { event: string; data: Record<string, unknown> }[] = []
  const frames: { type: string; sessionId?: string }[] = []
  let connections = 0
  let dropped = 0
  let dropPongs = true
  page.on('request', (request) => {
    if (request.url().endsWith('/api/client-log') && request.method() === 'POST') logs.push(request.postDataJSON())
  })
  await page.routeWebSocket(/\/ws$/, (ws) => {
    connections++
    const server = ws.connectToServer()
    ws.onMessage((message) => server.send(message))
    server.onMessage((message) => {
      const frame = JSON.parse(String(message))
      if (frame.type === 'pong' && dropPongs) { dropped++; return }
      frames.push(frame)
      ws.send(message)
    })
  })
  await page.clock.install()
  await page.goto('/')
  const card = page.locator(`[data-testid="session-card"][data-session-id="${target}"]`)
  await expect(card).toBeVisible()
  const id = await card.getAttribute('data-session-id')
  await card.click()
  await expect.poll(() => frames.some((f) => f.type === 'terminal-ready' && f.sessionId === id)).toBe(true)
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000))
  for (let cycle = 0; cycle < 3; cycle++) {
    const before = connections
    const previousDrops = dropped
    frames.length = 0
    await page.clock.runFor(20_000)
    await expect.poll(() => dropped).toBeGreaterThan(previousDrops)
    await page.clock.runFor(10_000)
    await expect.poll(() => logs.filter((l) => l.event === 'ws_pong_timeout').length).toBe(cycle + 1)
    const timeout = logs.filter((l) => l.event === 'ws_pong_timeout').at(-1)!
    expect(timeout.data.leaked).toBe(0)
    await page.clock.runFor(1000)
    await expect.poll(() => connections).toBe(before + 1)
    await expect.poll(async () => {
      await page.clock.runFor(100)
      return frames.some((f) => f.type === 'terminal-ready' && f.sessionId === id)
    }).toBe(true)
    await expect(card).toHaveClass(/selected/)
  }
  for (const timeout of logs.filter((l) => l.event === 'ws_pong_timeout')) {
    expect(timeout.data.visibility).toBe('visible')
    expect(timeout.data.pingSeq).toBeGreaterThan(0)
  }
  // Positive control: restoring matching pongs stops reconnection churn.
  dropPongs = false
  const healthyConnections = connections
  await page.clock.runFor(20_000)
  await expect.poll(() => frames.some((f) => f.type === 'pong')).toBe(true)
  await page.clock.runFor(10_000)
  expect(connections).toBe(healthyConnections)
  expect(logs.filter((l) => l.event === 'ws_pong_timeout')).toHaveLength(3)
  expect(new Set(logs.filter((l) => l.event === 'ws_pong_timeout').map((l) => l.data.traceId)).size).toBe(1)
})
