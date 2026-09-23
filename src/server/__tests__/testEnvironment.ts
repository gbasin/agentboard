import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export function isTmuxAvailable(): boolean {
  try {
    const result = Bun.spawnSync(['tmux', '-V'], {
      stdout: 'ignore',
      stderr: 'ignore',
    })
    return result.exitCode === 0
  } catch {
    return false
  }
}

export function canBindLocalhost(): boolean {
  let server: ReturnType<typeof Bun.serve> | null = null
  try {
    server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: () => new Response('ok'),
    })
    return true
  } catch {
    return false
  } finally {
    server?.stop(true)
  }
}

export function createTmuxTmpDir(prefix = 'agentboard-tmux-'): string {
  // These integration tests create a dedicated tmux server via TMUX_TMPDIR.
  // If the test process itself is running inside tmux, an inherited TMUX value
  // points tmux commands back at the parent server and silently defeats that
  // isolation.
  delete process.env.TMUX
  const baseDir = fs.existsSync('/tmp') ? '/tmp' : os.tmpdir()
  return fs.mkdtempSync(path.join(baseDir, prefix))
}

/**
 * Builds an environment pinned to the private tmux server under tmuxTmpDir.
 * TMUX is scrubbed on the copy rather than relying on createTmuxTmpDir's
 * mutation having run first: tmux resolves the socket from $TMUX before
 * TMUX_TMPDIR, so an inherited TMUX silently redirects every call —
 * including kill-session/kill-server — to the user's live server.
 */
export function privateTmuxEnv(
  tmuxTmpDir: string | null
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  delete env.TMUX
  if (tmuxTmpDir) env.TMUX_TMPDIR = tmuxTmpDir
  return env
}

/**
 * Socket path of the private server created under tmuxTmpDir. Pass it to tmux
 * via `-S` — an explicit socket path beats any inherited env, so the call can
 * never reach the user's live server even if TMUX somehow survives.
 */
export function privateTmuxSocket(tmuxTmpDir: string): string {
  return path.join(tmuxTmpDir, `tmux-${os.userInfo().uid}`, 'default')
}

type TmuxWindowListResult = {
  exitCode: number
  stderr: string
  windows: string[]
}

export function listTmuxWindows(
  sessionName: string,
  env?: NodeJS.ProcessEnv
): TmuxWindowListResult {
  const result = Bun.spawnSync(
    [
      'tmux',
      'list-windows',
      '-t',
      sessionName,
      '-F',
      '#{session_name}:#{window_id}',
    ],
    { stdout: 'pipe', stderr: 'pipe', env }
  )

  return {
    exitCode: result.exitCode,
    stderr: result.stderr.toString().trim(),
    windows: result.stdout
      .toString()
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean),
  }
}

export async function waitForTmuxWindows(
  sessionName: string,
  env?: NodeJS.ProcessEnv,
  options: { timeoutMs?: number; pollMs?: number } = {}
): Promise<string[]> {
  const timeoutMs = options.timeoutMs ?? 10000
  const pollMs = options.pollMs ?? 100
  const startedAt = Date.now()
  let lastResult: TmuxWindowListResult = {
    exitCode: -1,
    stderr: '',
    windows: [],
  }

  while (Date.now() - startedAt < timeoutMs) {
    lastResult = listTmuxWindows(sessionName, env)
    if (lastResult.windows.length > 0) {
      return lastResult.windows
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs))
  }

  const detail =
    lastResult.exitCode === 0
      ? 'tmux returned no windows'
      : `tmux list-windows exited ${lastResult.exitCode}${lastResult.stderr ? `: ${lastResult.stderr}` : ''}`
  throw new Error(
    `Failed to discover tmux windows for session ${sessionName} within ${timeoutMs}ms: ${detail}`
  )
}
