import { test, expect } from '@playwright/test'

test.use({ serviceWorkers: 'block' })

// The actual app and server exchange frames. Only pong delivery is interrupted;
// virtual browser time exercises heartbeat deadlines without a 90-second sleep.
test('missing pongs reconnect and reattach without retaining closed sockets', async ({ page }) => {
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
  const card = page.getByTestId('session-card').first()
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
