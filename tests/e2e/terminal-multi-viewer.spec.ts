// Real UI, WebSockets and tmux: opening/closing a second viewer must not steal
// the pane output feed. Run with TERMINAL_MODE=pipe-pane to cover shared pipes.
import { test, expect, type Page } from '@playwright/test'
import { spawnSync } from 'node:child_process'
import path from 'node:path'

test.use({ serviceWorkers: 'block', viewport: { width: 1280, height: 800 } })

test('both viewers receive live output and closing either leaves the other interactive', async ({ browser, page }, testInfo) => {
  const root = process.env.E2E_TMUX_TMPDIR
  const session = process.env.E2E_TMUX_SESSION
  if (!root || !session) throw new Error('Private E2E tmux server required')
  const env = { ...process.env }
  delete env.TMUX
  const socket = path.join(root, `tmux-${process.getuid?.() ?? 0}`, 'default')
  const tmux = (...args: string[]) => spawnSync('tmux', ['-S', socket, ...args], { env, encoding: 'utf8' })
  const created = tmux('new-window', '-P', '-F', '#{window_id}', '-t', `=${session}`, '-n', 'shared-feed-e2e', 'cat')
  expect(created.status, created.stderr).toBe(0)
  const target = `${session}:${created.stdout.trim()}`
  const secondContext = await browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: 'block' })
  const second = await secondContext.newPage()
  const output = new Map<Page, string>([[page, ''], [second, '']])
  const ready = new Set<Page>()
  for (const viewer of [page, second]) {
    viewer.on('websocket', ws => ws.on('framereceived', ({ payload }) => {
      const frame = JSON.parse(String(payload))
      if (frame.sessionId !== target) return
      if (frame.type === 'terminal-ready') ready.add(viewer)
      if (frame.type === 'terminal-output') output.set(viewer, output.get(viewer)! + frame.data)
    }))
  }
  const attach = async (viewer: Page) => {
    await viewer.goto(testInfo.project.use.baseURL as string)
    const card = viewer.locator(`[data-testid="session-card"][data-session-id="${target}"]`)
    await expect(card).toBeVisible({ timeout: 20_000 })
    await card.click()
    await expect.poll(() => ready.has(viewer)).toBe(true)
    await expect(viewer.locator('.xterm')).toBeVisible()
  }
  const type = async (viewer: Page, text: string) => {
    await viewer.locator('.xterm-helper-textarea').focus()
    await viewer.keyboard.type(text)
    await viewer.keyboard.press('Enter')
  }
  try {
    await attach(page)
    await attach(second)
    const fromFirst = `first-${Date.now()}`
    await type(page, fromFirst)
    for (const viewer of [page, second]) {
      await expect.poll(() => output.get(viewer)).toContain(fromFirst)
    }
    const fromSecond = `second-${Date.now()}`
    await type(second, fromSecond)
    for (const viewer of [page, second]) {
      await expect.poll(() => output.get(viewer)).toContain(fromSecond)
    }
    const sharedShot = testInfo.outputPath('both-viewers.png')
    await second.screenshot({ path: sharedShot })
    await testInfo.attach('both-viewers', { path: sharedShot, contentType: 'image/png' })
    await page.close()
    const afterClose = `after-close-${Date.now()}`
    await type(second, afterClose)
    await expect.poll(() => output.get(second)).toContain(afterClose)
    const survivingShot = testInfo.outputPath('surviving-viewer.png')
    await second.screenshot({ path: survivingShot })
    await testInfo.attach('surviving-viewer', { path: survivingShot, contentType: 'image/png' })
    const captured = tmux('capture-pane', '-p', '-t', target)
    expect(captured.status, captured.stderr).toBe(0)
    expect(captured.stdout).toContain(afterClose)
  } finally {
    await secondContext.close()
    tmux('kill-window', '-t', target)
  }
})
