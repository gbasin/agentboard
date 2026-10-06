import { test, expect } from '@playwright/test'
import { spawnSync } from 'node:child_process'
import { rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// A parked Claude Code AskUserQuestion card with enough options and
// descriptions that the ❯ selector sits more than 10 lines above the
// footer — outside detectsPermissionPrompt's recent-lines window. Status
// must key on the navigation footer, which Claude only renders while the
// card is open. Regression: such windows reported "waiting" instead of
// "Needs Input" (permission).
const TALL_ASK_USER_QUESTION_CARD = [
  'Which hosted substrate should run the iOS simulator lane?',
  '',
  '❯ 1. EAS Workflows maestro job (Recommended)',
  '     Expo builds the simulator app and runs Maestro flows with shards',
  '     + retries, $0.075/min + $0.05/job, YAML-driven. No runner upkeep.',
  '  2. Expand GitHub Actions macOS',
  '     Grow ios-smoke from nightly evidence into a PR or merge-queue',
  '     lane. $0.062/min, full shell control (notifyutil, simctl push).',
  '  3. Appetize.io streamed simulators',
  '     $59/mo, Playwright SDK, biometry() built in.',
  '  4. Maestro Cloud hosted devices',
  '     $250/device/mo, unlimited runs, AI assertions included.',
  '  5. Type something.',
  '  6. Chat about this',
  '',
  'Enter to select · ↑/↓ to navigate · Esc to cancel',
].join('\n')

test('a window parked on a tall AskUserQuestion card reports Needs Input', async ({
  page,
}) => {
  const session = process.env.E2E_TMUX_SESSION
  if (!session) throw new Error('E2E_TMUX_SESSION is not set')
  const name = `askq-${process.pid}-${Date.now()}`

  // Render the card and park: capture-pane sees it until the window dies.
  const cardFile = join(tmpdir(), `${name}.txt`)
  writeFileSync(cardFile, `${TALL_ASK_USER_QUESTION_CARD}\n`)
  const created = spawnSync(
    'tmux',
    [
      'new-window',
      '-t',
      `=${session}`,
      '-n',
      name,
      `cat ${cardFile} && sleep 600`,
    ],
    { encoding: 'utf-8' }
  )
  if (created.status !== 0) {
    rmSync(cardFile, { force: true })
    throw new Error(`Failed to create askq window: ${created.stderr}`)
  }

  try {
    await page.goto('/')
    const card = page
      .getByTestId('session-card')
      .filter({ hasText: name })
    await expect(card).toBeVisible({ timeout: 15000 })
    await expect(card.getByLabel('Needs input')).toBeVisible({
      timeout: 15000,
    })
  } finally {
    rmSync(cardFile, { force: true })
  }
})
