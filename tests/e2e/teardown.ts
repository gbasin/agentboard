import { spawnSync } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'

export default async function teardown() {
  const dir = process.env.E2E_TMUX_TMPDIR
  if (dir) {
    // The suite ran on a private tmux server (see playwright.config.ts), so
    // cleanup is one kill-server. Address it with an explicit -S socket path:
    // unlike TMUX_TMPDIR (ignored if the dir vanished) or $TMUX (overrides the
    // socket choice), -S can never resolve to the user's live tmux server.
    const socket = join(dir, `tmux-${process.getuid?.() ?? 0}`, 'default')
    if (existsSync(socket)) {
      spawnSync('tmux', ['-S', socket, 'kill-server'], { stdio: 'ignore' })
    }
    rmSync(dir, { recursive: true, force: true })
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
