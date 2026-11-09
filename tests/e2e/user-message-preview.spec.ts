// Real JSONL -> log discovery/matching -> WebSocket -> desktop/mobile previews.
import { test, expect } from '@playwright/test'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

test.use({ serviceWorkers: 'block' })

for (const agent of ['claude', 'codex'] as const) {
  test(`${agent}: injected messages never replace the real preview`, async ({ page, request }, testInfo) => {
    test.setTimeout(150_000)
    const root = process.env.E2E_TMUX_TMPDIR!
    const sessionId = randomUUID()
    const name = `${agent}-preview-${sessionId.slice(0, 8)}`
    const cwd = join(root, name)
    mkdirSync(cwd, { recursive: true })
    const prompt = `Please fix the sidebar preview for ${name}`
    const env = { ...process.env }
    delete env.TMUX
    const tmux = (args: string[]) => spawnSync('tmux', args, { env, encoding: 'utf8' })
    const created = tmux(['new-window', '-d', '-P', '-F', '#{window_id}', '-t', `${process.env.E2E_TMUX_SESSION}:`, '-n', name, '-c', cwd,
      `printf '❯ ${prompt}\\n⏺ ack\\n'; tail -f /dev/null`])
    expect(created.status, created.stderr).toBe(0)
    const windowId = created.stdout.trim()
    const timestamp = () => new Date().toISOString()
    const entry = (text: string, event = false) => agent === 'claude'
      ? { type: 'user', sessionId, cwd, timestamp: timestamp(), message: { role: 'user', content: text } }
      : event
        ? { type: 'event_msg', timestamp: timestamp(), payload: { type: 'user_message', message: text } }
        : { type: 'response_item', timestamp: timestamp(), payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } }
    const dir = agent === 'claude'
      ? join(process.env.CLAUDE_CONFIG_DIR!, 'projects', cwd.replace(/\//g, '-'))
      : join(process.env.CODEX_HOME!, 'sessions', ...new Date().toISOString().slice(0, 10).split('-'))
    mkdirSync(dir, { recursive: true })
    const logPath = join(dir, `${agent === 'codex' ? 'rollout-' : ''}${sessionId}.jsonl`)
    const pollSession = async () => {
      const sessions = await (await request.get('/api/sessions')).json()
      return sessions.find((s: { name: string }) => s.name === name)
    }
    const append = (text: string, event = false) => appendFileSync(logPath, JSON.stringify(entry(text, event)) + '\n')
    try {
      await expect.poll(async () => Boolean(await pollSession()), { timeout: 30_000 }).toBe(true)
      const metadata = agent === 'codex'
        ? [{ type: 'session_meta', timestamp: timestamp(), payload: { id: sessionId, cwd, timestamp: timestamp(), source: 'cli' } }]
        : []
      writeFileSync(logPath, [...metadata, entry(prompt)].map(e => JSON.stringify(e)).join('\n') + '\n')
      await expect.poll(async () => (await pollSession())?.lastUserMessage, { timeout: 90_000 }).toBe(prompt)
      await page.goto('/')
      const card = page.locator('aside:not(.session-drawer aside)').getByTestId('session-card').filter({ hasText: name })
      await expect(card).toContainText(prompt)

      const previousActivity = (await pollSession()).lastActivity
      append('<system-reminder id="4506f64571faf1f5">Result of calling the Read tool: internal instructions</system-reminder id="4506f64571faf1f5">')
      append('Tool loaded.', true)
      // Wait for log ingestion before asserting the notices left the preview intact.
      await expect.poll(async () => (await pollSession())?.lastActivity, { timeout: 20_000 }).not.toBe(previousActivity)
      expect((await pollSession()).lastUserMessage).toBe(prompt)
      await expect(card).toContainText(prompt)
      await expect(card).not.toContainText('system-reminder')
      const mixed = `Keep the real user text for ${agent}`
      append(`<system-reminder id="preview-test">internal context</system-reminder id="preview-test">${mixed}`, true)
      await expect.poll(async () => (await pollSession())?.lastUserMessage, { timeout: 20_000 }).toBe(mixed)
      await expect(card).toContainText(mixed)
      await expect(card).not.toContainText('system-reminder')
      const reminderDesktop = testInfo.outputPath(`${agent}-reminder-desktop.png`)
      await page.screenshot({ path: reminderDesktop, animations: 'disabled' })
      await testInfo.attach(`${agent} reminder desktop`, { path: reminderDesktop, contentType: 'image/png' })
      await page.setViewportSize({ width: 390, height: 844 })
      await page.getByLabel('Open session menu').click()
      const reminderCard = page.locator('.session-drawer.open').getByTestId('session-card').filter({ hasText: name })
      await expect(reminderCard).toContainText(mixed)
      await expect(reminderCard).not.toContainText('system-reminder')
      await expect.poll(async () =>
        Math.round((await page.locator('.session-drawer.open').boundingBox())!.x)
      ).toBe(0)
      const reminderMobile = testInfo.outputPath(`${agent}-reminder-mobile.png`)
      await page.screenshot({ path: reminderMobile, animations: 'disabled' })
      await testInfo.attach(`${agent} reminder mobile`, { path: reminderMobile, contentType: 'image/png' })
      await page.setViewportSize({ width: 1280, height: 720 })
      await page.reload()

      const answer = `Use option B for ${agent}`
      append(`<send_user_message_question_reply>\n[{"answer":"${answer}"}]\n</send_user_message_question_reply>`)
      await expect.poll(async () => (await pollSession())?.lastUserMessage, { timeout: 20_000 }).toBe(answer)
      await expect(card).toContainText(answer)
      await expect(card).not.toContainText('send_user_message_question_reply')
      append('<image name=[Image #1] path="/tmp/paste.png"></image>Fix the attached screenshot [Image #1]', true)
      await expect.poll(async () => (await pollSession())?.lastUserMessage, { timeout: 20_000 }).toBe('Fix the attached screenshot')
      await expect(card).toContainText('Fix the attached screenshot')
      const imageActivity = (await pollSession()).lastActivity
      append('This session is being continued from a previous conversation that ran out of context. Summary')
      await expect.poll(async () => (await pollSession())?.lastActivity, { timeout: 20_000 }).not.toBe(imageActivity)
      expect((await pollSession()).lastUserMessage).toBe('Fix the attached screenshot')
      append('[Image #2]', true)
      await expect.poll(async () => (await pollSession())?.lastUserMessage, { timeout: 20_000 }).toBe('Image attached')
      await expect(card).toContainText('Image attached')
      await expect(card).not.toContainText('/tmp/paste')
      const desktop = testInfo.outputPath(`${agent}-desktop.png`)
      await page.screenshot({ path: desktop, animations: 'disabled' })
      await testInfo.attach(`${agent} desktop`, { path: desktop, contentType: 'image/png' })

      await page.setViewportSize({ width: 390, height: 844 })
      await page.getByLabel('Open session menu').click()
      const mobileCard = page.locator('.session-drawer.open').getByTestId('session-card').filter({ hasText: name })
      await expect(mobileCard).toContainText('Image attached')
      await expect(mobileCard).not.toContainText('system-reminder')
      await expect.poll(async () =>
        Math.round((await page.locator('.session-drawer.open').boundingBox())!.x)
      ).toBe(0)
      const mobile = testInfo.outputPath(`${agent}-mobile.png`)
      await page.screenshot({ path: mobile, animations: 'disabled' })
      await testInfo.attach(`${agent} mobile`, { path: mobile, contentType: 'image/png' })
      await page.reload()
      await page.getByLabel('Open session menu').click()
      await expect(mobileCard).toContainText('Image attached')
    } finally {
      tmux(['kill-window', '-t', windowId])
      rmSync(logPath, { force: true })
      rmSync(cwd, { recursive: true, force: true })
    }
  })
}
