// The team default approval walkthrough against the SDK-free fixture
// (team-approval-default 4.3): setting the default on one tab's Members tab
// reaches a second open tab without a reload, the group row names the team
// default as its source, and a member spawned afterwards runs its tool
// without an approval card. Written for CI; run locally only on a spare
// E2E_PORT after `bun run build`.
import { expect, test, type Page } from '@playwright/test'
import { rmSync } from 'node:fs'
import { createChat, createTask, resultsTeam, say, spawnedSession } from './support/taskResults'

test.skip(process.env.AGENTBOARD_CHAT_FIXTURE !== '1', 'Requires development chat fixture')

async function openTab(page: Page, teamKey: string, tab: string) {
  await page.evaluate(([key, name]) => { window.location.hash = `#/team/${encodeURIComponent(key!)}/${name}` }, [teamKey, tab])
  await expect(page.getByTestId('team-workspace')).toHaveAttribute('data-team-key', teamKey)
}

const devsApproval = (page: Page) =>
  page.locator('[data-testid="member-group"][data-group-id="devs"]').getByTestId('member-approval')

// @covers: team-workspace › The Members tab sets the team's default approval policy › Another open view follows the change
test('an auto team default reaches the other open view and the next spawned member runs its tool without a card', async ({ page, context }, info) => {
  const team = resultsTeam()
  try {
    await page.goto('/')
    await createChat(page, team.root, 'Approval default lead', 'leads')
    await openTab(page, team.root, 'members')
    const other = await context.newPage()
    await other.goto('/')
    await openTab(other, team.root, 'members')
    await expect(other.getByTestId('team-approval-default-value')).toHaveText('Not set: spawned members start on manual.')
    await expect(devsApproval(other)).toHaveText('manual · built-in')

    await page.getByTestId('team-approval-default-auto').click()
    await expect(page.getByTestId('team-approval-default-auto')).toHaveAttribute('aria-pressed', 'true')
    // The second tab follows the push without a reload.
    await expect(other.getByTestId('team-approval-default-value')).toHaveText('Set to auto-approve.')
    await expect(devsApproval(other)).toHaveText('auto · team default')
    await other.screenshot({ path: info.outputPath('members-team-default.png') })
    await other.close()

    // A member spawned from now on starts on auto: its tool runs with no card.
    await openTab(page, team.root, 'tasks')
    await createTask(page, { title: 'Approval default task', direction: 'Export rows', worktree: team.worktree, assign: 'devs' })
    const dev = await spawnedSession(page, team.worktree)
    await say(page, dev, 'approval')
    await expect(page.getByTestId('chat-transcript')).toContainText('Request accepted.', { timeout: 30_000 })
    await expect(page.getByRole('button', { name: 'Allow', exact: true })).toHaveCount(0)
  } finally { rmSync(team.root, { recursive: true, force: true }) }
})
