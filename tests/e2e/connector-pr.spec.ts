// Real Codex log -> discovery -> metadata worker -> WebSocket -> PR chips.
import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import { seedActivity, activityLine } from './helpers/activityFixture'
import { connectorPrCompletion, connectorPrUrl } from '../fixtures/connectorPr'

test.skip(process.env.ACTIVITY_E2E_MATRIX !== '1', 'Uses the isolated lifecycle matrix with temporary-path matching')
test.use({ viewport: { width: 1280, height: 900 } })
test('connector completion adds one PR chip to the session card and panel', async ({ page, request }, info) => {
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
    const chip = card.locator(`a[href="${connectorPrUrl}"]`)
    await expect(chip).toHaveCount(0)
    // Failed create and successful read contain the same URL but must not link it.
    fs.appendFileSync(fixture.log, activityLine(connectorPrCompletion({ status: 'failed' })) +
      activityLine(connectorPrCompletion({ tool: 'github.get_pull_request' })))
    // A valid completion must independently identify its operation, even when
    // the outer exec cannot be attributed because it mixed multiple tools.
    fs.appendFileSync(fixture.log, activityLine({ type: 'response_item', payload: {
      type: 'custom_tool_call', name: 'exec', call_id: 'mixed',
      input: 'text(await tools.mcp__codex_apps__github_create_pull_request({})); text(await tools.exec_command({cmd:"pwd"}));',
    } }))
    const completion = activityLine(connectorPrCompletion())
    fs.appendFileSync(fixture.log, completion + completion)
    await expect(chip).toHaveCount(1, { timeout: 30_000 })
    await expect(chip).toBeVisible()
    expect((await find())?.prs).toEqual([{ url: connectorPrUrl, repo: 'gbasin/agentboard', number: 522 }])
    await card.click({ position: { x: 100, y: 12 } })
    const railChip = page.locator('footer').locator(`a[href="${connectorPrUrl}"]`)
    await expect(railChip).toBeVisible()
    await expect(railChip).toHaveCount(1)
    await page.screenshot({ path: info.outputPath('connector-pr-session-panel.png') })
    await info.attach('connector-pr-session-panel', { path: info.outputPath('connector-pr-session-panel.png'), contentType: 'image/png' })
    await page.reload()
    await expect(chip).toBeVisible({ timeout: 30_000 })
    await expect(chip).toHaveCount(1)
  } finally { fixture.stop() }
})
