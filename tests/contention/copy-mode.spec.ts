import { test, expect, type Page } from '@playwright/test'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

test.use({ serviceWorkers: 'block' })
test.setTimeout(60_000)

declare global {
  interface Window {
    contention: { frames: { type: string; sessionId?: string; data?: string; at: number }[] }
  }
}

async function instrument(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem('agentboard-settings', JSON.stringify({ state: { useWebGL: false }, version: 8 }))
    window.contention = { frames: [] }
    const Original = window.WebSocket
    window.WebSocket = class extends Original {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols)
        this.addEventListener('message', (event) => {
          try {
            const frame = JSON.parse(event.data)
            if (['terminal-output', 'terminal-ready', 'tmux-copy-mode-status'].includes(frame.type)) {
              window.contention.frames.push({ ...frame, at: Date.now() })
            }
          } catch { /* non-JSON traffic is irrelevant */ }
        })
      }
    }
  })
}
function tmux(args: string[]) {
  const root = process.env.E2E_TMUX_TMPDIR!
  const env = { ...process.env }
  delete env.TMUX
  const result = spawnSync(process.env.AB_REAL_TMUX!, ['-S', path.join(root, `tmux-${process.getuid?.() ?? 0}`, 'default'), ...args], { env, encoding: 'utf8' })
  expect(result.status, result.stderr).toBe(0)
  return result.stdout.trim()
}
async function select(page: Page, id: string) {
  const card = page.locator(`[data-testid="session-card"][data-session-id="${id}"]`)
  await expect(card).toBeVisible({ timeout: 20_000 })
  await card.click()
}
async function ready(page: Page, id: string) {
  await expect.poll(() => page.evaluate((id) => window.contention.frames.some((f) => f.type === 'terminal-ready' && f.sessionId === id), id)).toBe(true)
}

test('a delayed copy-mode query does not block another terminal or the selected pane rendering', async ({ page, context, request }, testInfo) => {
  const gate = process.env.AB_COPY_MODE_GATE!
  if (!gate || !process.env.AB_REAL_TMUX) throw new Error('Run with playwright.contention.config.ts')
  const session = process.env.E2E_TMUX_SESSION!
  const a = `${session}:${tmux(['new-window', '-P', '-F', '#{window_id}', '-t', `=${session}`, '-n', 'contention-a', '/bin/sh'])}`
  const b = `${session}:${tmux(['new-window', '-P', '-F', '#{window_id}', '-t', `=${session}`, '-n', 'contention-b', '/bin/sh'])}`
  const other = await context.newPage()
  let releaseTimer: ReturnType<typeof setTimeout> | undefined
  let releasedAt = 0
  try {
    tmux(['send-keys', '-t', b, "printf 'TARGET-B\\n'", 'Enter'])
    await instrument(page)
    await instrument(other)
    await page.goto('/')
    await other.goto('/')
    await select(page, a)
    await ready(page, a)
    await select(other, a)
    await ready(other, a)
    for (const file of ['started', 'held', 'release', 'arm']) fs.rmSync(path.join(gate, file), { force: true })
    // resolveCopyModeTarget uses the raw requested window while attach is pending.
    fs.writeFileSync(path.join(gate, 'arm'), b)
    const switchAt = Date.now()
    await select(other, b)
    await expect.poll(() => fs.existsSync(path.join(gate, 'started')), { timeout: 10_000 }).toBe(true)
    const heldAt = Date.now()
    let profile: Promise<void> | undefined
    if (process.env.AB_PROFILE_SAMPLE && process.platform === 'darwin') {
      const root = process.env.E2E_TMUX_TMPDIR!
      const { pid } = JSON.parse(fs.readFileSync(path.join(root, 'server.lock'), 'utf8'))
      const output = testInfo.outputPath('server-sample.txt')
      const child = spawn('/usr/bin/sample', [String(pid), '1', '-file', output])
      profile = new Promise((resolve, reject) => {
        child.once('error', reject)
        child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`sample exited ${code}`)))
      }).then(async () => { await testInfo.attach('server-sample', { path: output, contentType: 'text/plain' }) })
    }
    releaseTimer = setTimeout(() => {
      releasedAt = Date.now()
      fs.writeFileSync(path.join(gate, 'release'), '')
    }, 1200)
    const token = `OK${testInfo.repeatEachIndex}${Date.now()}`
    const inputAt = Date.now()
    const health = request.get('/api/health').then((r) => { expect(r.ok()).toBe(true); return Date.now() })
    await page.locator('.xterm-helper-textarea').focus()
    await page.keyboard.type(`printf '%s%s\\n' 'DONE' '${token}'`)
    await page.keyboard.press('Enter')
    await expect(page.locator('.xterm-rows')).toContainText(`DONE${token}`, { timeout: 10_000 })
    const renderedAt = Date.now()
    await expect(other.locator('.xterm-rows')).toContainText('TARGET-B')
    const switchedAt = Date.now()
    await ready(other, b)
    const healthAt = await health
    const frameAt = await page.evaluate((token) => window.contention.frames.find((f) => f.type === 'terminal-output' && f.data?.includes(`DONE${token}`))?.at, token)
    await expect.poll(() => releasedAt).toBeGreaterThan(0)
    await expect.poll(() => other.evaluate((id) => window.contention.frames.some((f) => f.type === 'tmux-copy-mode-status' && f.sessionId === id), b)).toBe(true)
    const metrics = { switchAt, heldAt, inputAt, frameAt, renderedAt, switchedAt, healthAt, releasedAt,
      inputToRenderMs: renderedAt - inputAt, healthMs: healthAt - inputAt, switchToObservedRenderMs: switchedAt - switchAt }
    await profile
    await testInfo.attach('server-log', { path: process.env.LOG_FILE!, contentType: 'text/plain' })
    await testInfo.attach('timeline', { body: JSON.stringify(metrics, null, 2), contentType: 'application/json' })
    await testInfo.attach('terminal', { body: await page.screenshot(), contentType: 'image/png' })
    // Order, not a tight performance threshold: unrelated traffic must finish
    // while the deliberately slow query is still waiting.
    expect(renderedAt).toBeLessThan(releasedAt)
    expect(healthAt).toBeLessThan(releasedAt)
    expect(switchedAt).toBeLessThan(releasedAt)
  } finally {
    if (releaseTimer) clearTimeout(releaseTimer)
    fs.writeFileSync(path.join(gate, 'release'), '')
    await other.close()
    tmux(['kill-window', '-t', a])
    tmux(['kill-window', '-t', b])
  }
})
