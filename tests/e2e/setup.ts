import { spawnSync } from 'node:child_process'
import { dirname } from 'node:path'
import { reapStaleE2eServers } from './tmuxReap'

// The specs need at least one visible session card. A fresh base session only
// has the invisible bootstrap window (filtered from listings), and CI used to
// paper over that with a workflow step that pre-created an `agentboard`
// session on the default tmux server — which the suite no longer sees now
// that it runs on a private one (TMUX_TMPDIR, see playwright.config.ts).
// Create the visible window here instead, on whatever server the suite uses.
export default async function setup() {
  const session = process.env.E2E_TMUX_SESSION
  if (!session) {
    throw new Error('E2E_TMUX_SESSION is not set')
  }

  // Teardown never runs when Playwright itself is killed, leaving that run's
  // private tmux server and its ptys behind. Reap such leftovers from earlier
  // runs of this checkout before starting (scoping rules in tmuxReap.ts).
  const currentDir = process.env.E2E_TMUX_TMPDIR
  if (currentDir) {
    const reaped = reapStaleE2eServers(dirname(currentDir), currentDir, process.cwd())
    for (const dir of reaped) {
      console.log(`[e2e setup] reaped stale tmux server from ${dir}`)
    }
  }

  const created = spawnSync(
    'tmux',
    ['new-session', '-d', '-s', session, '-n', 'test'],
    { encoding: 'utf-8' }
  )
  if (created.status === 0) {
    return
  }

  // The session already exists (the webServer's ensureSession won the race);
  // add the visible window to it.
  const added = spawnSync(
    'tmux',
    ['new-window', '-t', `=${session}`, '-n', 'test'],
    { encoding: 'utf-8' }
  )
  if (added.status !== 0) {
    throw new Error(
      `Failed to create test window in ${session}: ${created.stderr}${added.stderr}`
    )
  }
}
