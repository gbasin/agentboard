// Antigravity transcript -> matching -> metadata worker -> session card and rail.
import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import { activityLine, seedActivity } from './helpers/activityFixture'

const repo = 'example/agentboard-fixture'
const prUrl = (number: number) => `https://github.com/${repo}/pull/${number}`

test.skip(process.env.ACTIVITY_E2E_MATRIX !== '1', 'Uses the isolated activity matrix for temporary-path matching')
test.use({ viewport: { width: 1280, height: 900 } })

test('Antigravity background creates appear on an active session and after reload', async ({ page, request }, info) => {
  test.setTimeout(120_000)
  const fixture = seedActivity('antigravity')
  const session = async () => {
    const rows: { name: string; agentSessionId?: string; prs?: { url: string; repo: string; number: number }[] }[] =
      await (await request.get('/api/sessions')).json()
    return rows.find(row => row.name === fixture.name)
  }
  const step = (step_index: number, stepFields: object) =>
    activityLine({ step_index, created_at: new Date().toISOString(), ...stepFields })
  const command = 'git push && gh pr create --fill && gh pr ready'
  const createReceipt = `Creating draft pull request for feature into main in ${repo}`
  const background = (index: number, description: string) => step(index, {
    source: 'MODEL', type: 'GENERIC', status: 'RUNNING',
    content: `Created At: 2026-11-24T12:00:00Z
Tool is running as a background task with task id: ${fixture.sessionId}/task-${index}
Task Description: ${description}
Task logs are available at: file:///fixture/task-${index}.log
Log output:
Working...`,
  })
  const completion = (index: number, task: number, code: number, output: string) => step(index, {
    source: 'SYSTEM', type: 'SYSTEM_MESSAGE', status: 'DONE',
    content: `The following is a <SYSTEM_MESSAGE> not actually sent by the user.

<SYSTEM_MESSAGE>
[Message] timestamp=2026-11-24T12:00:05Z sender=${fixture.sessionId}/task-${task} priority=MESSAGE_PRIORITY_HIGH content=Task id "${fixture.sessionId}/task-${task}" finished with result:
Command exited with code ${code}.

Command output:
${output}

Log: file:///fixture/task-${task}.log
</SYSTEM_MESSAGE>`,
  })

  try {
    await page.goto('/')
    const card = page.locator('[data-testid="session-card"]:visible').filter({ hasText: fixture.name }).first()
    await expect(card).toBeVisible({ timeout: 30_000 })
    await expect.poll(async () => {
      const row = await session()
      if (row?.agentSessionId !== fixture.sessionId) fixture.refreshPrompt()
      return row?.agentSessionId
    }, { timeout: 60_000 }).toBe(fixture.sessionId)

    const older = card.locator(`a[href="${prUrl(21)}"]`)
    const newer = card.locator(`a[href="${prUrl(22)}"]`)
    await expect(older).toHaveCount(0)
    await expect(newer).toHaveCount(0)

    fs.appendFileSync(fixture.log, step(1, {
      source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', truncated_fields: ['tool_calls'],
      tool_calls: [
        { name: 'run_command', args: { CommandLine: JSON.stringify('gh pr view 99') } },
        { name: 'run_command', args: { CommandLine: '"git push && gh pr create --fill\n<truncated 55 bytes>' } },
      ],
    }) + background(2, 'gh pr view 99') + background(3, command) +
      completion(4, 2, 0, prUrl(99)) +
      completion(5, 3, 1, `${createReceipt}\n\nWorking...\n${prUrl(21)}\nWorking...\nLater command failed.`))

    await expect(older).toBeVisible({ timeout: 30_000 })
    expect((await session())?.prs).toEqual([{ url: prUrl(21), repo, number: 21 }])

    // The next completion embeds a different PR in the JSON output of a subsequent command.
    fs.appendFileSync(fixture.log, step(6, {
      source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE',
      tool_calls: [{ name: 'run_command', args: { CommandLine: JSON.stringify(command) } }],
    }) + background(7, command) + completion(8, 7, 0,
      `${createReceipt}\n\nWorking...\n${prUrl(22)}\n{"url":"${prUrl(99)}"}`))

    await expect(newer).toBeVisible({ timeout: 30_000 })
    expect((await session())?.prs).toEqual([21, 22].map(number => ({ url: prUrl(number), repo, number })))

    await card.click({ position: { x: 100, y: 12 } })
    const rail = page.locator('footer')
    await expect(rail.locator(`a[href="${prUrl(21)}"]`)).toBeVisible()
    await expect(rail.locator(`a[href="${prUrl(22)}"]`)).toBeVisible()
    await info.attach('antigravity-pr-card', { body: await card.screenshot({
      path: info.outputPath('antigravity-pr-card.png'),
    }), contentType: 'image/png' })
    await info.attach('antigravity-pr-rail', { body: await rail.screenshot({
      path: info.outputPath('antigravity-pr-rail.png'),
    }), contentType: 'image/png' })

    await page.reload()
    await expect(older).toBeVisible({ timeout: 30_000 })
    await expect(newer).toBeVisible()
    await expect(card.locator(`a[href="${prUrl(99)}"]`)).toHaveCount(0)
  } finally { fixture.stop() }
})
