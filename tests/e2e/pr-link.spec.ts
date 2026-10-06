import { test, expect } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

// End-to-end coverage for the pr-link extraction path: a Claude log that
// only pushes to an existing PR (no `gh pr create` tool call) carries
// `{"type":"pr-link",...}` records. The suite's server discovers the log
// via the real LogPoller, scans it through the byte prefilter + extractor,
// and broadcasts `prs` on the `agent-sessions` frame — nothing is stubbed,
// so a regression anywhere in that chain fails this test.
//
// The session never attaches to a tmux window, so it lands in History;
// its chips come from the background dormantPrScan.

const PR_URL = 'https://github.com/e2e/prlink/pull/123'
const PR_LINK = `a[href="${PR_URL}"]`

function seedClaudePrLinkLog(): string {
  const claudeDir = process.env.CLAUDE_CONFIG_DIR
  if (!claudeDir) throw new Error('CLAUDE_CONFIG_DIR is not set')
  const projectDir = path.join(claudeDir, 'projects', '-tmp-ab-e2e-prlink')
  fs.mkdirSync(projectDir, { recursive: true })

  const sessionId = randomUUID()
  const ts = new Date().toISOString()
  fs.writeFileSync(
    path.join(projectDir, `${sessionId}.jsonl`),
    [
      JSON.stringify({
        type: 'user',
        sessionId,
        cwd: '/tmp/ab-e2e-prlink',
        timestamp: ts,
        message: { role: 'user', content: 'push the review fixes' },
      }),
      // The association record Claude Code writes — no tool call involved.
      JSON.stringify({
        type: 'pr-link',
        sessionId,
        prNumber: 123,
        prUrl: PR_URL,
        prRepository: 'e2e/prlink',
        timestamp: ts,
      }),
    ].join('\n') + '\n'
  )
  return sessionId
}

test('a claude session with only a pr-link record gets a PR chip in History', async ({
  page,
}) => {
  // Discovery is one 5s LogPoller cycle plus the dormant scan slices.
  test.slow()
  seedClaudePrLinkLog()

  await page.goto('/')

  // History starts collapsed and renders nothing until the poll finds the
  // seeded log; the toggle appearing means discovery ran.
  const historyToggle = page.getByRole('button', { name: /^History/ })
  await expect(historyToggle).toBeVisible({ timeout: 20_000 })
  await historyToggle.click()

  // The chip is the PR URL link itself — populated only after the dormant
  // scan reads the pr-link record.
  await expect(page.locator(PR_LINK)).toBeVisible({ timeout: 20_000 })
})
