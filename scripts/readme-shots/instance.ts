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
// falling back.
//
// One run at a time: the run lock is a listening socket on a loopback port,
// so the kernel grants it to one process and frees it when that process dies.
// Leftovers of a run that died are recognised by command line, never by a
// remembered pid.

import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { reapPrivateTmuxServer, socketPath } from '../../tests/e2e/tmuxReap'

/** Literal and short: tmux falls back to the live socket if TMUX_TMPDIR is missing. */
export const ROOT = '/private/tmp/ab-shots'
export const PORT = 4199
/** Loopback port whose listener is the run lock (see acquireLock). */
export const LOCK_PORT = 4198
/** Not `agentboard`, so it can never be mistaken for the live session. */
export const TMUX_SESSION = 'ab-shots'
export const LOCAL_HOST = 'studio'
export const REMOTE_HOST = 'build-box'
export const REPO = join(import.meta.dir, '..', '..')
const HOST = 'localhost'
export const baseUrl = `http://${HOST}:${PORT}`
/** Argument that marks the fixture server's command line as ours; the server ignores arguments. */
const SERVER_MARKER = `--readme-shots=${ROOT}`

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

/** Real binaries, resolved once from the caller's PATH. */
const TMUX_BIN = Bun.which('tmux')
const TOOLS: Record<string, string | null> = { tmux: TMUX_BIN, cwebp: Bun.which('cwebp'), ffmpeg: Bun.which('ffmpeg') }

/** Fail early, naming the tool, instead of halfway through a run. */
export function checkTools(): void {
  const missing = Object.entries(TOOLS).filter(([, found]) => !found).map(([name]) => name)
  if (missing.length) throw new Error(`missing required tool(s): ${missing.join(', ')}`)
}

/** The private bin directory first, then Bun, the tools found above, and the system directories. */
function isolatedPath(): string {
  const toolDirs = Object.values(TOOLS).filter((tool): tool is string => tool !== null).map(dirnameOf)
  return [...new Set([paths.bin, dirnameOf(process.execPath), ...toolDirs,
    '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'])].join(':')
}

/**
 * The only environment any process we start ever sees: the server, tmux, the
 * client build, the browsers, the compositor and its encoders.
 */
export function isolatedEnv(extra: Record<string, string> = {}): Record<string, string> {
  return {
    PATH: isolatedPath(),
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

/**
 * Playwright launch options. The browser process gets the isolated
 * environment. Playwright must not install its own signal handlers: they exit
 * before teardown.
 */
export function browserLaunch() {
  return { handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false, env: isolatedEnv() }
}

/**
 * Environment for a child that itself runs Playwright (the compositor). The
 * one addition is PLAYWRIGHT_BROWSERS_PATH: Playwright finds its browsers
 * under the home directory, and HOME here points into ROOT.
 */
export function playwrightChildEnv(): Record<string, string> {
  const cache = process.platform === 'darwin'
    ? join(homedir(), 'Library', 'Caches')
    : process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache')
  return isolatedEnv({ PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH ?? join(cache, 'ms-playwright') })
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

/** Pids listening on a loopback TCP port. */
function listeners(port: number): number[] {
  const result = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fp'], { encoding: 'utf-8', env: isolatedEnv() })
  return (result.stdout ?? '').split('\n').filter((line) => line.startsWith('p')).map((line) => Number(line.slice(1)))
}

export function portInUse(port = PORT): boolean {
  return listeners(port).length > 0
}

/** Keeps the lock socket referenced for the life of the process; never closed explicitly. */
const held: unknown[] = []

/**
 * One run at a time on this machine, across checkouts. The lock is a
 * listening socket on a fixed loopback port. The kernel gives the port to one
 * process and frees it when that process exits, however it exits, so there is
 * no stale lock to detect and no race in breaking one. Child processes do not
 * inherit the socket. Take it before anything is deleted.
 */
export function acquireLock(): void {
  try {
    held.push(Bun.listen({ hostname: '127.0.0.1', port: LOCK_PORT, socket: { data() {}, open(socket) { socket.end() } } }))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error
    const holder = listeners(LOCK_PORT)[0]
    throw new Error(`the run lock (loopback port ${LOCK_PORT}) is held${holder ? ` by pid ${holder}` : ''}: another readme:shots run is active, or another program uses that port; refusing to start (nothing was changed)`)
  }
}

/** Flag for the compositor child: its parent holds the lock for it. */
export const PARENT_LOCK_FLAG = '--lock-held-by-parent'

/** The flag is a claim; check it against the kernel. */
export function assertParentHoldsLock(): void {
  if (!listeners(LOCK_PORT).includes(process.ppid)) {
    throw new Error(`${PARENT_LOCK_FLAG} was passed, but the parent process does not hold the run lock (loopback port ${LOCK_PORT})`)
  }
}

interface Proc { pid: number; ppid: number; command: string }

function processes(): Proc[] {
  const out = spawnSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf-8', env: isolatedEnv() }).stdout ?? ''
  return out.split('\n').flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)
    return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), command: match[3]! }] : []
  })
}

/**
 * True when the command's program (its first word) is named `name`. Anchored
 * there so a shell or a grep that merely mentions our paths never matches.
 */
function runs(command: string, name: string): boolean {
  const program = command.split(' ', 1)[0]!
  return program === name || program.endsWith(`/${name}`)
}

/** A tmux server or client started with -S on one of the two private sockets. */
function isOurTmux(command: string): boolean {
  const [, flag, socket] = command.split(' ')
  return runs(command, 'tmux') && flag === '-S' && (socket === paths.socket || socket === paths.remoteSocket)
}

/** A fixture agent TUI (its last argument is the state directory) or the fixture server. */
function isOurProcess(command: string): boolean {
  if (!runs(command, 'bun')) return false
  return (command.includes('scripts/readme-shots/agent-tui.ts ') && command.endsWith(` ${paths.state}`))
    || command.endsWith(` src/server/index.ts ${SERVER_MARKER}`)
}

function kill(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal)
  } catch {
    // already gone
  }
}

/**
 * Stop every process of this or an earlier run. First the two private tmux
 * servers through their sockets (tmuxReap.ts always passes -S, so it cannot
 * reach another server). Then whatever is left, including a server whose
 * socket file is gone. Those are found by command line in a fresh process
 * list, not by a pid recorded earlier, which the system may have reused.
 * Call it with the run lock held: no other run's processes can exist then.
 */
export function reapLeftovers(): void {
  for (const socket of [paths.socket, paths.remoteSocket]) reapPrivateTmuxServer(socket)
  const all = processes()
  for (const proc of all) {
    if (proc.pid === process.pid) continue
    if (isOurTmux(proc.command)) {
      // Pane processes lead their own process groups.
      const panes = all.filter((child) => child.ppid === proc.pid)
      kill(proc.pid, 'SIGKILL')
      for (const pane of panes) {
        kill(-pane.pid, 'SIGKILL')
        kill(pane.pid, 'SIGKILL')
      }
    } else if (isOurProcess(proc.command)) {
      kill(proc.pid, 'SIGKILL')
    }
  }
}

const ROOT_DIRS = () => [paths.home, paths.bin, paths.data, paths.state, paths.media, paths.remoteTmux,
  paths.claude, paths.codex, join(ROOT, 'tmp'), join(paths.home, '.pi'), join(paths.home, '.omp'),
  join(paths.home, '.grok'), join(paths.home, '.devin'), join(paths.home, '.local', 'share'), join(paths.home, '.config')]

/** Remove leftovers of an earlier run and recreate ROOT. Lock held. */
export function reset(): void {
  reapLeftovers()
  rmSync(ROOT, { recursive: true, force: true })
  for (const dir of ROOT_DIRS()) mkdirSync(dir, { recursive: true })
  // tmux -S does not create the socket's parent directory.
  for (const socket of [paths.socket, paths.remoteSocket]) {
    mkdirSync(dirnameOf(socket), { recursive: true, mode: 0o700 })
  }
  writeTmuxWrapper()
}

/** HOME and TMPDIR for a browser when no instance is set up (--composite-only). Lock held. */
export function prepareScratch(): void {
  for (const dir of [paths.home, join(ROOT, 'tmp')]) mkdirSync(dir, { recursive: true })
}

export function removeRoot(): void {
  rmSync(ROOT, { recursive: true, force: true })
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
  const child = spawn(process.execPath, ['--no-env-file', 'src/server/index.ts', SERVER_MARKER], {
    cwd: REPO,
    env,
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  server = child
  child.stderr?.on('data', (chunk: Buffer) => {
    serverStderr = (serverStderr + chunk.toString()).slice(-8000)
  })
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`agentboard server exited early (${child.exitCode ?? child.signalCode}):\n${serverLogTail()}`)
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

/**
 * Stop the fixture server and both private tmux servers. Safe to call again:
 * a later call also stops what was started in between. ROOT stays.
 */
export async function stopInstance(): Promise<void> {
  const child = server
  server = null
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGTERM')
    const exited = await Promise.race([
      new Promise<boolean>((resolve) => child.once('exit', () => resolve(true))),
      Bun.sleep(5000).then(() => false),
    ])
    if (!exited) child.kill('SIGKILL')
  }
  reapLeftovers()
}
