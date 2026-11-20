import { spawnSync } from 'node:child_process'
import { readdirSync, rmSync } from 'node:fs'
import { stopE2eServer } from './stopServer'
import { reapPrivateTmuxServer, socketPath } from './tmuxReap'

export default async function teardown() {
  const dir = process.env.E2E_TMUX_TMPDIR
  if (dir) {
    // Playwright stops config.webServer only after this function returns.
    // Stop the agentboard server first: while it runs it writes into `dir`
    // and recreates the tmux server we are about to kill (see stopServer.ts).
    const server = await stopE2eServer(dir)
    if (server === 'killed' || server === 'survived') {
      console.warn(`[e2e teardown] agentboard server ignored SIGTERM (${server})`)
    }

    // The suite ran on a private tmux server (see playwright.config.ts), so
    // cleanup is kill-server plus killing any pane process that outlived it
    // (see tmuxReap.ts). Address it with an explicit -S socket path: unlike
    // TMUX_TMPDIR (ignored if the dir vanished) or $TMUX (overrides the
    // socket choice), -S can never resolve to the user's live tmux server.
    const survivors = reapPrivateTmuxServer(socketPath(dir))
    if (survivors > 0) {
      console.log(`[e2e teardown] killed ${survivors} process(es) that outlived the tmux server`)
    }
    // With every writer stopped this succeeds. If it does not, something
    // outlived teardown: report it rather than fail a run whose tests passed.
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch (error) {
      let left: string[] = []
      try {
        left = readdirSync(dir)
      } catch {
        // Gone after all
      }
      console.warn(
        `[e2e teardown] could not remove ${dir}: ${(error as Error).message}; ` +
          `remaining: ${left.join(', ') || '(none)'} — a process is still writing there`
      )
    }
    return
  }

  // No private server (E2E_TMUX_TMPDIR unset): the run shared the inherited
  // tmux server, so kill the base session and any grouped `-ws-` clones the
  // agentboard server left behind if it was killed before its own cleanup.
  const session = process.env.E2E_TMUX_SESSION
  if (!session) {
    return
  }

  const check = spawnSync('tmux', ['-V'], { stdio: 'ignore' })
  if (check.status !== 0) {
    return
  }

  spawnSync('tmux', ['kill-session', '-t', session], { stdio: 'ignore' })

  const list = spawnSync('tmux', ['list-sessions', '-F', '#{session_name}'], {
    encoding: 'utf-8',
  })
  if (list.status !== 0 || !list.stdout) {
    return
  }
  for (const line of list.stdout.split('\n')) {
    const name = line.trim()
    if (name.startsWith(`${session}-ws-`)) {
      spawnSync('tmux', ['kill-session', '-t', name], { stdio: 'ignore' })
    }
  }
}
