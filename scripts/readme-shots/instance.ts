// instance.ts - A fully isolated Agentboard instance for README captures.
//
// Everything lives under one literal directory (ROOT). The server and every
// tmux client get an environment built from a whitelist, never a copy of the
// caller's: the caller is often a shell inside the live agentboard tmux
// server, so $TMUX, $TMUX_PANE, AGENTBOARD_* and LOG_LEVEL must not leak. HOME
// itself points into ROOT, so no code path can read the real ~/.claude,
// ~/.codex or ~/.agentboard. tmux is always addressed with an explicit -S
// socket, which errors instead of falling back to the live server.

import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { reapPrivateTmuxServer, socketPath } from '../../tests/e2e/tmuxReap'

/** Literal and short: tmux falls back to the live socket if TMUX_TMPDIR is missing. */
export const ROOT = '/private/tmp/ab-shots'
export const PORT = 4199
export const TMUX_SESSION = 'agentboard'
export const LOCAL_HOST = 'studio'
export const REMOTE_HOST = 'build-box'
export const REPO = join(import.meta.dir, '..', '..')

export const paths = {
  root: ROOT,
  home: join(ROOT, 'home'),
  bin: join(ROOT, 'bin'),
  data: join(ROOT, 'data'),
  state: join(ROOT, 'state'),
  media: join(ROOT, 'media'),
  remoteTmux: join(ROOT, 'remote'),
  claude: join(ROOT, 'home', '.claude'),
  codex: join(ROOT, 'home', '.codex'),
  socket: socketPath(ROOT),
  remoteSocket: socketPath(join(ROOT, 'remote')),
}

/** Where fixture projects live; shown as ~/<name> because HOME is paths.home. */
export const projectDir = (name: string) => join(paths.home, name)

const PASS_THROUGH = ['LANG', 'TERM'] as const

/** The only environment any process we start ever sees. */
export function isolatedEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {
    PATH: `${paths.bin}:${dirnameOf(process.execPath)}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
    HOME: paths.home,
    USER: 'dev',
    LOGNAME: 'dev',
    SHELL: '/bin/sh',
    TMPDIR: join(ROOT, 'tmp'),
    TMUX_TMPDIR: ROOT,
    LC_ALL: 'en_US.UTF-8',
    LANG: 'en_US.UTF-8',
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
  }
  for (const key of PASS_THROUGH) {
    if (process.env[key] && !env[key]) env[key] = process.env[key]!
  }
  return { ...env, ...extra }
}

function dirnameOf(p: string): string {
  return p.slice(0, p.lastIndexOf('/'))
}

/** tmux on a private socket (local board, or the fake remote host). */
export function tmux(args: string[], socket = paths.socket): string {
  const result = spawnSync('tmux', ['-S', socket, ...args], {
    encoding: 'utf-8',
    env: isolatedEnv(),
    timeout: 10_000,
  })
  if (result.status !== 0) {
    throw new Error(`tmux ${args.join(' ')} failed: ${result.stderr}`)
  }
  return result.stdout.trim()
}

let server: ChildProcess | null = null

function portInUse(port: number): boolean {
  const result = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], { encoding: 'utf-8' })
  return result.stdout.trim().length > 0
}

/** Remove leftovers of an earlier run (only things under ROOT). */
export function reset(): void {
  for (const socket of [paths.socket, paths.remoteSocket]) reapPrivateTmuxServer(socket)
  rmSync(ROOT, { recursive: true, force: true })
  for (const dir of [paths.home, paths.bin, paths.data, paths.state, paths.media, paths.remoteTmux,
    paths.claude, paths.codex, join(ROOT, 'tmp'), join(paths.home, '.pi'), join(paths.home, '.omp'),
    join(paths.home, '.grok'), join(paths.home, '.devin')]) {
    mkdirSync(dir, { recursive: true })
  }
  // tmux -S does not create the socket's parent directory.
  for (const socket of [paths.socket, paths.remoteSocket]) {
    mkdirSync(dirnameOf(socket), { recursive: true, mode: 0o700 })
  }
}

/**
 * Start the local private tmux server with Agentboard's managed session. Its
 * first window carries the server's bootstrap name, which the board hides.
 */
export function startTmux(): void {
  tmux(['new-session', '-d', '-s', TMUX_SESSION, '-n', '__agentboard_root__', '-c', paths.home, 'tail -f /dev/null'])
}

export async function startServer(): Promise<void> {
  if (portInUse(PORT)) throw new Error(`port ${PORT} is already in use; refusing to start`)
  if (!existsSync(join(REPO, 'dist', 'client', 'index.html'))) {
    throw new Error('dist/client is missing; run `bun run build` first')
  }
  const env = isolatedEnv({
    PORT: String(PORT),
    HOSTNAME: '127.0.0.1',
    TMUX_SESSION,
    AGENTBOARD_DATA_DIR: paths.data,
    AGENTBOARD_DB_PATH: join(paths.data, 'agentboard.db'),
    AGENTBOARD_TMUX_PID_FILE: join(paths.data, 'tmux-server.pid'),
    LOG_FILE: join(paths.data, 'agentboard.log'),
    LOG_LEVEL: 'info',
    CLAUDE_CONFIG_DIR: paths.claude,
    CODEX_HOME: paths.codex,
    PI_HOME: join(paths.home, '.pi'),
    PI_CODING_AGENT_DIR: join(paths.home, '.omp'),
    DEVIN_CLI_DIR: join(paths.home, '.devin'),
    GROK_HOME: join(paths.home, '.grok'),
    AGENTBOARD_STATIC_DIR: join(REPO, 'dist', 'client'),
    AGENTBOARD_LOG_WATCH_MODE: 'poll',
    REFRESH_INTERVAL_MS: '700',
    AGENTBOARD_HOST: LOCAL_HOST,
    AGENTBOARD_REMOTE_HOSTS: REMOTE_HOST,
    AGENTBOARD_REMOTE_POLL_MS: '1000',
    AGENTBOARD_REMOTE_ALLOW_ATTACH: 'true',
  })
  server = spawn(process.execPath, ['src/server/index.ts'], {
    cwd: REPO,
    env,
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  server.stderr?.on('data', (chunk: Buffer) => {
    const text = chunk.toString()
    if (/error/i.test(text)) process.stderr.write(`[server] ${text}`)
  })
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/api/sessions`)
      if (res.ok) return
    } catch {
      // not up yet
    }
    await Bun.sleep(300)
  }
  throw new Error('agentboard server did not come up within 60s')
}

/** Stop only what this script started, then remove ROOT. */
export async function teardown(keep = false): Promise<void> {
  if (server && server.exitCode === null) {
    server.kill('SIGTERM')
    const exited = await Promise.race([
      new Promise<boolean>((resolve) => server!.once('exit', () => resolve(true))),
      Bun.sleep(5000).then(() => false),
    ])
    if (!exited) server.kill('SIGKILL')
  }
  server = null
  for (const socket of [paths.socket, paths.remoteSocket]) reapPrivateTmuxServer(socket)
  if (!keep) rmSync(ROOT, { recursive: true, force: true })
}

export const baseUrl = `http://127.0.0.1:${PORT}`
