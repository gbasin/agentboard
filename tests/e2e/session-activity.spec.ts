// Complete log -> private tmux association -> worker -> WS -> actual UI path.
import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import { seedActivity, activityLine } from './helpers/activityFixture'

// Real fixture processes have no harness ownership files. Exercise the existing
// text-association fallback explicitly; no session/activity WS frames are mocked.
test.describe.configure({ timeout: 90_000 })
test.skip(process.env.ACTIVITY_E2E_MATRIX !== '1', 'Lifecycle fixtures run in the isolated activity matrix with temporary-path matching enabled')
for (const kind of ['claude', 'codex'] as const) {
  test(`${kind}: independent child completion, resume, main activity and mobile popover`, async ({ page, request }, info) => {
    const fixture = seedActivity(kind)
    const associationPath = info.outputPath('fixture-association.json')
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    const observed: { at: string; type: string; running: number; phase: string }[] = []
    page.on('websocket', socket => socket.on('framereceived', ({ payload }) => {
      try {
        const frame = JSON.parse(String(payload))
        const rows = frame.sessions ?? (frame.session ? [frame.session] : [])
        const s = rows.find((s: { name: string }) => s.name === fixture.name)
        if (s?.activity) observed.push({ at: new Date().toISOString(), type: frame.type, running: s.activity.running, phase: s.activity.main.phase })
      } catch { /* terminal/binary frames */ }
    }))
    try {
      await page.emulateMedia({ reducedMotion: 'reduce' })
      await page.goto('/')
      const card = page.locator('[data-testid="session-card"]:visible').filter({ hasText: fixture.name }).first()
      await expect(card).toBeVisible({ timeout: 30_000 })
      await expect.poll(async () => {
        const sessions = await (await request.get('/api/sessions')).json()
        const session = sessions.find((s: { name: string }) => s.name === fixture.name)
        fs.writeFileSync(associationPath, JSON.stringify({ session, terminal: fixture.capture(),
          parentLog: fs.readFileSync(fixture.log, 'utf8'), childLog: fs.readFileSync(fixture.child, 'utf8'),
        }, null, 2))
        if (session?.agentSessionId !== fixture.sessionId) fixture.refreshPrompt()
        return session?.activity?.running
      }, { timeout: 60_000 }).toBe(1)
      const trigger = card.getByTestId('session-activity-counter')
      await expect(trigger).toHaveText('1')
      const height = (await card.boundingBox())!.height
      await trigger.click()
      const popover = page.getByTestId('session-activity-popover')
      await expect(popover).toContainText(kind === 'claude' ? 'Review activity parser' : '/root/review-parser')
      await expect(popover).toContainText(kind === 'claude' ? 'Tool pending: Bash' : 'Tool pending: exec')
      await expect(popover).not.toContainText('secret body')
      await expect(popover).not.toContainText('private command')
      expect((await card.boundingBox())!.height).toBeCloseTo(height, 2)
      const parentBefore = fs.readFileSync(fixture.log, 'utf8')
      fixture.append(kind === 'claude'
        ? { type: 'assistant', message: { stop_reason: 'end_turn', content: [] } }
        : { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'child1' } })
      await expect(popover).toContainText('0 running', { timeout: 20_000 })
      await expect(trigger).toHaveText('0')
      expect(fs.readFileSync(fixture.log, 'utf8')).toBe(parentBefore)
      fixture.append(kind === 'claude' ? { type: 'api-request' } : { type: 'event_msg', payload: { type: 'task_started', turn_id: 'child2' } })
      await expect(popover).toContainText('1 running', { timeout: 20_000 })
      await expect(trigger).toHaveText('1')
      await page.screenshot({ path: info.outputPath(`${kind}-desktop.png`) })
      await page.keyboard.press('Escape')
      await expect(popover).toBeHidden()
      await expect(trigger).toBeFocused()
      // Main-only changes publish without inventing a child change.
      fs.appendFileSync(fixture.log, activityLine(kind === 'claude'
        ? { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'main-tool', name: 'Read', input: {} }] } }
        : { type: 'response_item', payload: { type: 'function_call', call_id: 'main-tool', name: 'read_file' } }))
      await card.getByTestId('session-activity-status').click()
      await expect(popover).toContainText(kind === 'claude' ? 'Tool pending: Read' : 'Tool pending: read_file', { timeout: 20_000 })
      await popover.getByRole('button', { name: 'Close activity' }).click()
      await card.click({ position: { x: 100, y: 12 } })
      await page.setViewportSize({ width: 390, height: 844 })
      await page.getByLabel('Open session menu', { exact: true }).click()
      await expect.poll(async () => (await page.locator('.session-drawer.open').boundingBox())?.x ?? -999).toBeGreaterThanOrEqual(-1)
      const mobileCard = page.locator('.session-drawer [data-testid="session-card"]').filter({ hasText: fixture.name }).first()
      await mobileCard.getByTestId('session-activity-counter').click()
      await expect(popover).toBeVisible()
      await expect(popover).toContainText('Main session')
      const box = (await popover.boundingBox())!
      expect(box.x).toBeGreaterThanOrEqual(0)
      expect(box.x + box.width).toBeLessThanOrEqual(390)
      expect(box.y + box.height).toBeLessThanOrEqual(844)
      await page.screenshot({ path: info.outputPath(`${kind}-mobile.png`) })
      expect(errors).toEqual([])
      expect(observed.some(s => s.running === 0)).toBe(true)
      expect(observed.some(s => s.running === 1)).toBe(true)
      await info.attach('activity-lifecycle-observations', { body: JSON.stringify({ kind, windowSize: fixture.windowSize, parentUnchangedDuringCompletion: true, observed, errors }, null, 2), contentType: 'application/json' })
    } catch (error) {
      // Preserve the association evidence before private tmux/data teardown.
      try {
        await info.attach('fixture-association', { path: associationPath, contentType: 'application/json' })
      } catch { /* retain the original assertion failure */ }
      throw error
    } finally { fixture.stop() }
  })
}
