import { test, expect } from '@playwright/test'
import type { Page, WebSocketRoute } from '@playwright/test'
import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { activityLine, seedActivity } from './helpers/activityFixture'
import { connectorPrCompletion } from '../fixtures/connectorPr'

const repo = 'e2e/shared-pr-status'
const number = 52
const url = `https://github.com/${repo}/pull/${number}`

test.skip(process.env.PR_STATUS_E2E !== '1', 'Requires the isolated fake gh from playwright.pr-status.config.ts')
test.use({ viewport: { width: 1280, height: 900 } })

test('two browsers share one PR check per cycle and recover the merged state after reconnect', async ({ page, browser, request }, info) => {
  // Exercise the real 30-second active repository cadence with the fake GitHub server.
  test.setTimeout(215_000)
  const root = process.env.E2E_TMUX_TMPDIR!
  const callsFile = join(root, 'gh-calls')
  const calls = () => existsSync(callsFile) ? readFileSync(callsFile, 'utf8').trim().split('\n') : []
  const githubState = (state: 'OPEN' | 'MERGED') => {
    const now = new Date().toISOString()
    const body = [{
      number,
      state: state === 'OPEN' ? 'open' : 'closed',
      merged_at: state === 'MERGED' ? now : null,
      draft: false,
      title: 'Shared status fixture',
      user: { login: 'fixture' },
      head: { sha: 'a'.repeat(40) },
      updated_at: now,
    }]
    const responseFile = join(root, 'gh-response.json')
    writeFileSync(`${responseFile}.tmp`, JSON.stringify(body))
    renameSync(`${responseFile}.tmp`, responseFile)
  }
  githubState('OPEN')
  const fixture = seedActivity('codex')
  const second = await browser.newPage({ baseURL: info.project.use.baseURL, serviceWorkers: 'block', viewport: { width: 1280, height: 900 } })
  const chip = (viewer: Page) => viewer.locator('[data-testid="session-card"]:visible').filter({ hasText: fixture.name }).locator(`a[href="${url}"]`)
  let mergedBroadcast = false
  page.on('websocket', socket => {
    if (!new URL(socket.url()).pathname.endsWith('/ws')) return
    socket.on('framereceived', ({ payload }) => {
      if (typeof payload !== 'string') return
      const message = JSON.parse(payload)
      if (message.type === 'pr-status' && message.infos.some((pr: { url: string; state: string }) =>
        pr.url === url && pr.state === 'MERGED')) mergedBroadcast = true
    })
  })
  let secondSocket: WebSocketRoute | undefined
  let connections = 0
  let dropStatus = false
  await second.routeWebSocket(/\/ws(?:\?.*)?$/, (socket) => {
    connections++
    secondSocket = socket
    const upstream = socket.connectToServer()
    upstream.onMessage(message => {
      if (dropStatus && typeof message === 'string' && JSON.parse(message).type === 'pr-status') return
      socket.send(message)
    })
  })
  try {
    await expect.poll(async () => {
      const sessions: { name: string; agentSessionId?: string }[] = await (await request.get('/api/sessions')).json()
      const session = sessions.find(s => s.name === fixture.name)
      if (session?.agentSessionId !== fixture.sessionId) fixture.refreshPrompt()
      return session?.agentSessionId
    }, { timeout: 60_000 }).toBe(fixture.sessionId)
    appendFileSync(fixture.log, activityLine(connectorPrCompletion({ result: { structuredContent: { url, number } } })))
    // The first GitHub confirmation happens with no browser connected.
    await expect.poll(calls, { timeout: 30_000 }).toHaveLength(1)
    await Promise.all([page.goto('/'), second.goto('/')])
    await expect(chip(page)).toHaveAccessibleName(`${repo}#${number} Open`)
    await expect(chip(second)).toHaveAccessibleName(`${repo}#${number} Open`)
    expect(calls()).toHaveLength(1)

    // Let the first browser receive the actual merge broadcast. The second
    // misses that frame and must get the same state when it reconnects.
    dropStatus = true
    githubState('MERGED')
    await expect(chip(page)).toHaveAccessibleName(`${repo}#${number} Merged`, { timeout: 45_000 })
    expect(mergedBroadcast).toBe(true)
    await expect(chip(second)).toHaveAccessibleName(`${repo}#${number} Open`)
    expect(calls()).toHaveLength(2)

    dropStatus = false
    await secondSocket!.close({ code: 1012, reason: 'Test reconnect' })
    await expect.poll(() => connections).toBe(2)
    await expect(chip(second)).toHaveAccessibleName(`${repo}#${number} Merged`)
    expect(calls()).toHaveLength(2)
    await page.screenshot({ path: info.outputPath('shared-pr-status-merged.png') })
    await info.attach('shared-pr-status-merged', { path: info.outputPath('shared-pr-status-merged.png'), contentType: 'image/png' })
  } finally {
    await second.close()
    fixture.stop()
  }
})
