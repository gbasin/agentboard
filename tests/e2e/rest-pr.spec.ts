// Real Codex log -> discovery -> metadata worker -> WebSocket -> PR chips.
import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import { seedActivity, activityLine } from './helpers/activityFixture'
import { restCompletion, restCommand, pythonRestCommand, restPrUrl } from '../fixtures/restPr'

test.skip(process.env.ACTIVITY_E2E_MATRIX !== '1', 'Uses the isolated lifecycle matrix with temporary-path matching')
test.use({ viewport: { width: 1280, height: 900 } })
test('REST command completion adds one PR chip to the session card and panel', async ({ page, request }, info) => {
  test.setTimeout(120_000)
  const fixture = seedActivity('codex')
  const find = async () => ((await (await request.get('/api/sessions')).json()) as
    { name: string; agentSessionId?: string; prs?: { url: string }[] }[]).find(s => s.name === fixture.name)
  try {
    await page.goto('/')
    const card = page.locator('[data-testid="session-card"]:visible').filter({ hasText: fixture.name }).first()
    await expect(card).toBeVisible({ timeout: 30_000 })
    await expect.poll(async () => {
      const session = await find()
      if (session?.agentSessionId !== fixture.sessionId) fixture.refreshPrompt()
      return session?.agentSessionId
    }, { timeout: 60_000 }).toBe(fixture.sessionId)
    const chip = card.locator(`a[href="${restPrUrl}"]`)
    await expect(chip).toHaveCount(0)
    // Prose, a failed create, and a read must not produce a chip.
    fs.appendFileSync(fixture.log,
      activityLine({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: restPrUrl } }) +
      activityLine(restCompletion(restCommand, { status: 'failed', exit_code: 1 })) +
      activityLine(restCompletion(restCommand.replace('POST', 'GET'))))
    await expect.poll(async () => (await find())?.prs ?? [], { timeout: 10_000 }).toEqual([])
    // The initial exec returns no URL; the self-contained completion arrives
    // after a different write_stdin poll. Cover Python subprocess and shell.
    fs.appendFileSync(fixture.log, activityLine({ type: 'response_item', payload: {
      type: 'custom_tool_call_output', call_id: 'create', output: '{"session_id":66236,"output":""}',
    } }))
    const completion = activityLine(restCompletion(pythonRestCommand))
    // Split inside the prefilter word across metadata-worker scans.
    const cut = completion.indexOf('pulls') + 2
    fs.appendFileSync(fixture.log, completion.slice(0, cut))
    await page.waitForTimeout(6000)
    await expect(chip).toHaveCount(0)
    fs.appendFileSync(fixture.log, completion.slice(cut) + activityLine(restCompletion()) + completion)
    await expect(chip).toHaveCount(1, { timeout: 30_000 })
    await expect(chip).toBeVisible()
    expect((await find())?.prs).toEqual([{ url: restPrUrl, repo: 'e2e/rest-pr', number: 15 }])
    await card.click({ position: { x: 100, y: 12 } })
    const railChip = page.locator('footer').locator(`a[href="${restPrUrl}"]`)
    await expect(railChip).toBeVisible()
    await expect(railChip).toHaveCount(1)
    await page.screenshot({ path: info.outputPath('rest-pr-session-panel.png') })
    await info.attach('rest-pr-session-panel', { path: info.outputPath('rest-pr-session-panel.png'), contentType: 'image/png' })
    await page.reload()
    await expect(chip).toBeVisible({ timeout: 30_000 })
    await expect(chip).toHaveCount(1)
  } finally { fixture.stop() }
})
