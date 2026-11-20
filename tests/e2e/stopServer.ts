// Stops the agentboard server an e2e run started, before teardown touches the
// run's temp dir.
//
// Playwright runs globalTeardown before it stops config.webServer, so the
// server is still alive while teardown reaps the private tmux server and
// removes the dir. A live server keeps writing agentboard.log and the SQLite
// WAL there, and its next session refresh recreates the base session — a new
// tmux server whose socket appears inside the dir. That made rmSync fail with
// ENOTEMPTY, and when rmSync won the race the recreated tmux server leaked
// with its socket deleted, out of reach of every later reap.
//
// The server records its pid in <dataDir>/server.lock (see
// src/server/instanceLock.ts); the e2e data dir is the run's temp dir. A
// server reused from outside the run (reuseExistingServer) uses a different
// data dir, so it has no lock here and is never signalled. If the run's
// server died early, its pid may since belong to an unrelated process, so the
// pid is signalled only while its command line is still an agentboard server.

import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// The server's SIGTERM handler disposes its terminals before it exits.
export const SERVER_EXIT_GRACE_MS = 10_000
const SERVER_KILL_WAIT_MS = 2_000

export function readLockPid(dir: string): number | null {
  try {
    const { pid } = JSON.parse(readFileSync(join(dir, 'server.lock'), 'utf-8')) as {
      pid?: unknown
    }
    return typeof pid === 'number' && Number.isInteger(pid) && pid > 0 ? pid : null
  } catch {
    return null
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

// `bun src/server/index.ts` (the webServer command) or a compiled binary.
const SERVER_COMMAND = /(^|\/|\s)(src\/server\/index\.ts|agentboard)(\s|$)/

export function isAgentboardServer(pid: number): boolean {
  const ps = spawnSync('ps', ['-o', 'command=', '-p', String(pid)], {
    encoding: 'utf-8',
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
  })
  return ps.status === 0 && SERVER_COMMAND.test(ps.stdout.trim())
}

async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (isAlive(pid)) {
    if (Date.now() >= deadline) return false
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return true
}

export type StopResult = 'not-running' | 'stopped' | 'killed' | 'survived'

/**
 * SIGTERM the run's agentboard server and wait for it to exit; SIGKILL it if
 * it ignores SIGTERM for `graceMs`. Only 'stopped' and 'not-running' are a
 * clean shutdown — callers surface the others as a leak.
 */
export async function stopE2eServer(
  dir: string,
  graceMs = SERVER_EXIT_GRACE_MS
): Promise<StopResult> {
  const pid = readLockPid(dir)
  if (pid === null || pid === process.pid || !isAlive(pid) || !isAgentboardServer(pid)) {
    return 'not-running'
  }
  try {
    process.kill(pid, 'SIGTERM')
  } catch {
    return 'not-running'
  }
  if (await waitForExit(pid, graceMs)) return 'stopped'
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    // Exited between the check and the kill
  }
  return (await waitForExit(pid, SERVER_KILL_WAIT_MS)) ? 'killed' : 'survived'
}
