// instance.ts - A fully isolated Agentboard instance for README captures.
//
// Everything lives under one literal directory (ROOT). The server and every
// tmux client get an environment built from a whitelist, never a copy of the
// caller's: the caller is often a shell inside the live agentboard tmux
// server, so $TMUX, $TMUX_PANE, AGENTBOARD_* and LOG_LEVEL must not leak. HOME
// itself points into ROOT, so no code path can read the real ~/.claude,
// ~/.codex or ~/.agentboard.
//
// tmux isolation does not rely on TMUX_TMPDIR alone (tmux silently falls back
// to the default, live socket when that directory is missing). This script
// calls the real tmux with an explicit -S. The server and the shims call
// `tmux` by name, which resolves to a wrapper in the private bin directory
// that execs the real binary with -S "$AB_TMUX_SOCKET"; -S fails instead of
// falling back. A run lock (outside ROOT) keeps a second run from deleting
// the directory under a running instance.

import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { reapPrivateTmuxServer, socketPath } from '../../tests/e2e/tmuxReap'

/** Literal and short: tmux falls back to the live socket if TMUX_TMPDIR is missing. */
export const ROOT = '/private/tmp/ab-shots'
export const LOCK = '/private/tmp/ab-shots.lock'
export const PORT = 4199
/** Not `agentboard`, so it can never be mistaken for the live session. */
export const TMUX_SESSION = 'ab-shots'
export const LOCAL_HOST = 'studio'
export const REMOTE_HOST = 'build-box'
export const REPO = join(import.meta.dir, '..', '..')
const HOST = 'localhost'
export const baseUrl = `http://${HOST}:${PORT}`
/** Playwright must not install its own signal handlers: they exit before teardown. */
export const LAUNCH = { handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false }

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

function dirnameOf(p: string): string {
  return p.slice(0, p.lastIndexOf('/'))
}

/** The real tmux binary, resolved once from the caller's PATH. */
const TMUX_BIN = Bun.which('tmux')

/** Fail early, naming the tool, instead of halfway through a run. */
export function checkTools(): void {
  const missing = [['tmux', TMUX_BIN], ['cwebp', Bun.which('cwebp')], ['ffmpeg', Bun.which('ffmpeg')]]
    .filter(([, found]) => !found).map(([name]) => name)
  if (missing.length) throw new Error(`missing required tool(s): ${missing.join(', ')}`)
}

/** The only environment any process we start ever sees. */
export function isolatedEnv(extra: Record<string, string> = {}): Record<string, string> {
  return {
    PATH: `${paths.bin}:${dirnameOf(process.execPath)}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
    HOME: paths.home,
    USER: 'dev',
    LOGNAME: 'dev',
    SHELL: '/bin/sh',
    TMPDIR: join(ROOT, 'tmp'),
    TMUX_TMPDIR: ROOT,
    AB_TMUX_SOCKET: paths.socket,
    // Pinned so a .env or a parent shell cannot point these at real data.
    XDG_DATA_HOME: join(paths.home, '.local', 'share'),
    XDG_CONFIG_HOME: join(paths.home, '.config'),
    LC_ALL: 'en_US.UTF-8',
    LANG: 'en_US.UTF-8',
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    ...extra,
  }
}

/** tmux on a private socket (local board, or the fake remote host). */
export function tmux(args: string[], socket = paths.socket): string {
  const result = spawnSync(TMUX_BIN!, ['-S', socket, ...args], {
    encoding: 'utf-8',
    env: isolatedEnv({ AB_TMUX_SOCKET: socket }),
    timeout: 10_000,
  })
  if (result.status !== 0) {
    throw new Error(`tmux ${args.join(' ')} failed: ${result.stderr}`)
  }
  return result.stdout.trim()
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * One run at a time. The lock lives outside ROOT and is taken before anything
 * is deleted; a lock whose pid is gone is stale and replaced.
 */
export function acquireLock(): void {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(LOCK, 'wx')
      writeSync(fd, String(process.pid))
      closeSync(fd)
      return
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const holder = Number.parseInt(readFileSync(LOCK, 'utf-8'), 10)
      if (Number.isInteger(holder) && holder > 0 && isAlive(holder)) {
        throw new Error(`another readme:shots run (pid ${holder}) holds ${LOCK}; refusing to start`)
      }
      rmSync(LOCK, { force: true })
    }
  }
  throw new Error(`could not take ${LOCK}`)
}

export function releaseLock(): void {
  try {
    if (Number.parseInt(readFileSync(LOCK, 'utf-8'), 10) === process.pid) rmSync(LOCK)
  } catch {
    // not ours or already gone
  }
}

export function portInUse(port = PORT): boolean {
  const result = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], { encoding: 'utf-8' })
  return result.stdout.trim().length > 0
}

/** Private tmux server pids, recorded so teardown can reap them without a socket. */
const tmuxServers = new Set<number>()

export function recordTmuxServer(socket: string): void {
  const pid = Number.parseInt(tmux(['display-message', '-p', '#{pid}'], socket), 10)
  if (Number.isInteger(pid) && pid > 0) tmuxServers.add(pid)
}

function childPids(parent: number): number[] {
  const out = spawnSync('ps', ['-axo', 'pid=,ppid='], { encoding: 'utf-8' }).stdout ?? ''
  return out.split('\n').map((l) => l.trim().split(/\s+/).map(Number))
    .filter(([pid, ppid]) => ppid === parent && pid! > 0).map(([pid]) => pid!)
}

function kill(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal)
  } catch {
    // already gone
  }
}

/** Remove leftovers of an earlier run (only things under ROOT). Lock held. */
export function reset(): void {
  for (const socket of [paths.socket, paths.remoteSocket]) reapPrivateTmuxServer(socket)
  rmSync(ROOT, { recursive: true, force: true })
  for (const dir of [paths.home, paths.bin, paths.data, paths.state, paths.media, paths.remoteTmux,
    paths.claude, paths.codex, join(ROOT, 'tmp'), join(paths.home, '.pi'), join(paths.home, '.omp'),
    join(paths.home, '.grok'), join(paths.home, '.devin'), join(paths.home, '.local', 'share'), join(paths.home, '.config')]) {
    mkdirSync(dir, { recursive: true })
  }
  // tmux -S does not create the socket's parent directory.
  for (const socket of [paths.socket, paths.remoteSocket]) {
    mkdirSync(dirnameOf(socket), { recursive: true, mode: 0o700 })
  }
  writeTmuxWrapper()
}

/**
 * `tmux` for everything the server and the shims run: the real binary with
 * -S "$AB_TMUX_SOCKET" prepended. It refuses to run without that variable and
 * refuses a caller-supplied -S or -L, so no call can reach another server.
 */
function writeTmuxWrapper(): void {
  const file = join(paths.bin, 'tmux')
  writeFileSync(file, `#!/bin/sh
[ -n "$AB_TMUX_SOCKET" ] || { echo "readme-shots tmux wrapper: AB_TMUX_SOCKET is not set" >&2; exit 97; }
skip=0
for arg in "$@"; do
  if [ "$skip" = 1 ]; then skip=0; continue; fi
  case "$arg" in
    -L|-S|-L*|-S*) echo "readme-shots tmux wrapper: refusing $arg" >&2; exit 97 ;;
    -c|-f|-T) skip=1 ;;
    -*) ;;
    *) break ;;
  esac
done
exec "${TMUX_BIN}" -S "$AB_TMUX_SOCKET" "$@"
`)
  chmodSync(file, 0o755)
}

/**
 * Start the local private tmux server with the fixture's managed session. Its
 * first window carries the server's bootstrap name, which the board hides.
 */
export function startTmux(): void {
  tmux(['new-session', '-d', '-s', TMUX_SESSION, '-n', '__agentboard_root__', '-c', paths.home, 'tail -f /dev/null'])
  // No status line: its default right side shows the machine's real hostname.
  tmux(['set-option', '-g', 'status', 'off'])
  recordTmuxServer(paths.socket)
}

let server: ChildProcess | null = null
let serverStderr = ''

function serverLogTail(): string {
  const log = join(paths.data, 'agentboard.log')
  const text = existsSync(log) ? readFileSync(log, 'utf-8') : ''
  return [text.split('\n').slice(-15).join('\n'), serverStderr.slice(-2000)].filter(Boolean).join('\n--- stderr ---\n')
}

export async function startServer(): Promise<void> {
  const env = isolatedEnv({
    PORT: String(PORT),
    // Not 127.0.0.1: for that value the server also binds the Tailscale IP.
    HOSTNAME: HOST,
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
    PI_CONFIG_DIR: join(paths.home, '.pi'),
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
  // --no-env-file: Bun would otherwise load .env* from the repo into the server.
  server = spawn(process.execPath, ['--no-env-file', 'src/server/index.ts'], {
    cwd: REPO,
    env,
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  server.stderr?.on('data', (chunk: Buffer) => {
    serverStderr = (serverStderr + chunk.toString()).slice(-8000)
  })
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    if (server.exitCode !== null || server.signalCode !== null) {
      throw new Error(`agentboard server exited early (${server.exitCode ?? server.signalCode}):\n${serverLogTail()}`)
    }
    try {
      const res = await fetch(`${baseUrl}/api/sessions`)
      if (res.ok) return
    } catch {
      // not up yet
    }
    await Bun.sleep(300)
  }
  throw new Error(`agentboard server did not come up within 60s:\n${serverLogTail()}`)
}

/** Stop only what this script started, remove ROOT, release the lock. */
export async function teardown(): Promise<void> {
  if (server && server.exitCode === null && server.signalCode === null) {
    server.kill('SIGTERM')
    const exited = await Promise.race([
      new Promise<boolean>((resolve) => server!.once('exit', () => resolve(true))),
      Bun.sleep(5000).then(() => false),
    ])
    if (!exited) server.kill('SIGKILL')
  }
  server = null
  for (const socket of [paths.socket, paths.remoteSocket]) reapPrivateTmuxServer(socket)
  // A server whose socket file is already gone: kill it and its panes by pid.
  for (const pid of tmuxServers) {
    if (!isAlive(pid)) continue
    const children = childPids(pid)
    kill(pid, 'SIGTERM')
    await Bun.sleep(500)
    for (const child of children) {
      kill(-child, 'SIGKILL')
      kill(child, 'SIGKILL')
    }
    kill(pid, 'SIGKILL')
  }
  tmuxServers.clear()
  rmSync(ROOT, { recursive: true, force: true })
  releaseLock()
}
