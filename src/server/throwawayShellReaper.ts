// Kills login shells that tmux spawned for a grouped session's discarded
// initial window and that never got their hangup (see tmuxGroupedSession.ts).
//
// Runs off the connection path and off the event loop: creating a grouped
// session only calls noteGroupedSessionCreated(), which (re)arms a timer.
// Every process query below is an async Bun.spawn with a timeout; a slow or
// failed step abandons the run with one log line. The 0.23.0 version ran two
// synchronous `ps -axo` per WebSocket connection and froze a starved server
// for tens of seconds (load 70-105, swap full).
//
// There is no before/after snapshot, so the candidate test alone must only
// ever match a stuck throwaway shell. A candidate is all of:
//   - a direct child of the tmux server (pgrep -P <server pid>)
//   - not the pid of any pane (pane list taken after the child list)
//   - holding a tty (macOS keeps it after the pty master closes; Linux
//     drops it, which is why the job only runs on macOS)
//   - a login-shell argv0 (`-zsh`): tmux only execs a dashed argv0 for a
//     pane running the default shell (spawn.c). Popups and jobs go through
//     job_run(), whose argv0 is never dashed (`/bin/zsh`, `sh`); jobs
//     (run-shell, #(), pipe-pane) also have no tty.
//   - older than MIN_AGE_MS, far beyond any legitimate shell startup
//   - no children
//   - exactly fds 0, 1 and 2 open. A shell that finished starting keeps its
//     tty on another fd (zsh: 10, bash: 255); the stuck shell is blocked in
//     zsh's init_io open() of its tty, before that fd exists.
// Survivors of SIGHUP get SIGKILL only after re-checking they still match.

import { logger } from './logger'
import { sanitizedTmuxEnv } from './tmuxEnv'

export interface CommandResult {
  exitCode: number
  stdout: string
}

/** Runs argv without blocking; null on timeout, exit code -1 if it could not start. */
export type RunCommand = (argv: string[], timeoutMs: number) => Promise<CommandResult | null>

export interface ReaperTiming {
  /** A candidate must have been running at least this long. */
  minAgeMs: number
  /** Delay after the last creation, so its throwaway shell is old enough. */
  settleMs: number
  /** Minimum time between run starts. */
  minIntervalMs: number
  /** A pending creation waits at most this long for a run. */
  maxDelayMs: number
  /** Each spawned query is killed and the run abandoned after this. */
  stepTimeoutMs: number
  /** Wait between SIGHUP and the SIGKILL re-check. */
  hupGraceMs: number
}

// 60s: a shell that started normally is already excluded by its extra fd;
// the age keeps a shell that is merely slow to start (event-loop lags of 46s
// were measured on the starved machine) out of reach.
export const MIN_AGE_MS = 60_000
export const DEFAULT_TIMING: ReaperTiming = {
  minAgeMs: MIN_AGE_MS,
  // A run sooner than MIN_AGE_MS after a burst could not judge the burst's
  // shells; 5s of slack covers ps's 1s etime resolution and timer jitter.
  settleMs: MIN_AGE_MS + 5_000,
  // At most one run a minute, however many connections arrive.
  minIntervalMs: 60_000,
  // A reconnect storm keeps pushing the settle deadline; still run every 2m.
  maxDelayMs: 120_000,
  stepTimeoutMs: 10_000,
  hupGraceMs: 1_000,
}

export interface ProcessInfo {
  pid: number
  ppid: number
  ageSec: number
  stat: string
  tty: string
  comm: string
}

export type ReapStep = 'server-pid' | 'children' | 'process-info' | 'panes' | 'grandchildren' | 'fds'

export type ReapOutcome =
  | { kind: 'skipped'; reason: 'platform' | 'in-flight' }
  | { kind: 'nothing' }
  | { kind: 'abandoned'; step: ReapStep; reason: 'timeout' | 'failed' | 'server-changed' }
  | { kind: 'reaped'; hupPids: number[]; killedPids: number[] }

const NO_TTY = new Set(['', '?', '??', '-'])
const PS_FORMAT = 'pid=,ppid=,etime=,stat=,tty=,comm='

export function isValidPid(pid: number): boolean {
  return Number.isSafeInteger(pid) && pid > 1
}

/** `[[dd-]hh:]mm:ss` → seconds; NaN when malformed. */
export function parseEtime(value: string): number {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(value)
  if (!match) return Number.NaN
  const [, days, hours, minutes, seconds] = match
  return (
    Number(days ?? 0) * 86_400 + Number(hours ?? 0) * 3_600 + Number(minutes) * 60 + Number(seconds)
  )
}

export function parsePidList(output: string): number[] {
  const pids: number[] = []
  for (const line of output.split('\n')) {
    const pid = Number(line.trim())
    if (line.trim() !== '' && isValidPid(pid)) pids.push(pid)
  }
  return pids
}

export function parseProcessInfo(output: string): ProcessInfo[] {
  const rows: ProcessInfo[] = []
  for (const line of output.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(.+)$/.exec(line)
    if (!match) continue
    const ageSec = parseEtime(match[3] ?? '')
    if (Number.isNaN(ageSec)) continue
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      ageSec,
      stat: match[4] ?? '',
      tty: match[5] ?? '',
      comm: (match[6] ?? '').trim(),
    })
  }
  return rows
}

/** `#{pid} #{pane_pid}` lines → server pids seen and pane pids. */
export function parsePaneList(output: string): { serverPids: Set<number>; panePids: Set<number> } {
  const serverPids = new Set<number>()
  const panePids = new Set<number>()
  for (const line of output.split('\n')) {
    const [server, pane] = line.trim().split(' ')
    if (!server || !pane) continue
    serverPids.add(Number(server))
    panePids.add(Number(pane))
  }
  return { serverPids, panePids }
}

/** `lsof -F pf` output → numeric fds per pid (cwd, txt, … are dropped). */
export function parseLsofFds(output: string): Map<number, Set<number>> {
  const fds = new Map<number, Set<number>>()
  let current: Set<number> | null = null
  for (const line of output.split('\n')) {
    if (line.startsWith('p')) {
      current = new Set()
      fds.set(Number(line.slice(1)), current)
    } else if (line.startsWith('f') && current) {
      const fd = line.slice(1)
      if (/^\d+$/.test(fd)) current.add(Number(fd))
    }
  }
  return fds
}

/** The checks one `ps` row can answer: child, live, tty, login argv0, age. */
export function rowLooksStuck(row: ProcessInfo, serverPid: number, minAgeMs: number): boolean {
  return (
    row.ppid === serverPid &&
    !row.stat.startsWith('Z') &&
    !NO_TTY.has(row.tty) &&
    row.comm.length > 1 &&
    row.comm.startsWith('-') &&
    row.ageSec * 1000 >= minAgeMs
  )
}

export function hasOnlyStdioOpen(fds: ReadonlySet<number> | undefined): boolean {
  return fds !== undefined && fds.size === 3 && fds.has(0) && fds.has(1) && fds.has(2)
}

export interface StuckShellEvidence {
  rows: readonly ProcessInfo[]
  serverPid: number
  panePids: ReadonlySet<number>
  parentsWithChildren: ReadonlySet<number>
  fdsByPid: ReadonlyMap<number, ReadonlySet<number>>
  minAgeMs: number
}

/** The full candidate test. Missing evidence for a pid never matches. */
export function findStuckShells(evidence: StuckShellEvidence): number[] {
  return evidence.rows
    .filter(
      (row) =>
        rowLooksStuck(row, evidence.serverPid, evidence.minAgeMs) &&
        !evidence.panePids.has(row.pid) &&
        !evidence.parentsWithChildren.has(row.pid) &&
        hasOnlyStdioOpen(evidence.fdsByPid.get(row.pid))
    )
    .map((row) => row.pid)
}

function pidArgs(flag: string, pids: readonly number[]): string[] {
  return pids.filter(isValidPid).flatMap((pid) => [flag, String(pid)])
}

/** Bun.spawn with a timeout; the process is SIGKILLed when it expires. */
export const spawnWithTimeout: RunCommand = async (argv, timeoutMs) => {
  let killTimer: ReturnType<typeof setTimeout> | null = null
  let proc: ReturnType<typeof Bun.spawn<'ignore', 'pipe', 'ignore'>>
  try {
    proc = Bun.spawn(argv, {
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'ignore',
      env: sanitizedTmuxEnv(),
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
    })
  } catch {
    return { exitCode: -1, stdout: '' }
  }
  try {
    // Do not rely on Bun's timeout alone to settle `exited`.
    let timedOut = false
    killTimer = setTimeout(() => {
      timedOut = true
      try {
        proc.kill('SIGKILL')
      } catch {
        // Already exited
      }
    }, timeoutMs + 250)
    const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
    if (timedOut || proc.signalCode !== null) return null
    return { exitCode, stdout }
  } catch {
    return null
  } finally {
    if (killTimer !== null) clearTimeout(killTimer)
  }
}

type Signal = 'SIGHUP' | 'SIGKILL'
// Opaque to the reaper apart from Node's optional unref().
type TimerHandle = object

export interface ReaperDeps {
  /** The tmux server pid this process last saw (in memory, no I/O). */
  getServerPid: () => number | null
  runCommand?: RunCommand
  signal?: (pid: number, signal: Signal) => void
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => TimerHandle
  clearTimer?: (handle: TimerHandle) => void
  log?: (event: string, data: Record<string, unknown>) => void
  platform?: NodeJS.Platform
  timing?: Partial<ReaperTiming>
}

class Abandon extends Error {
  constructor(
    readonly step: ReapStep,
    readonly reason: 'timeout' | 'failed' | 'server-changed'
  ) {
    super(`${step}: ${reason}`)
  }
}

export class ThrowawayShellReaper {
  private readonly deps: Required<Omit<ReaperDeps, 'timing'>>
  readonly timing: ReaperTiming
  private timer: TimerHandle | null = null
  private inFlight = false
  private lastCreatedAt = 0
  private pendingSince: number | null = null
  private lastRunStartedAt = Number.NEGATIVE_INFINITY
  private step: ReapStep = 'server-pid'

  constructor(deps: ReaperDeps) {
    this.timing = { ...DEFAULT_TIMING, ...deps.timing }
    this.deps = {
      getServerPid: deps.getServerPid,
      runCommand: deps.runCommand ?? spawnWithTimeout,
      signal: deps.signal ?? ((pid, signal) => process.kill(pid, signal)),
      sleep: deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
      now: deps.now ?? Date.now,
      setTimer: deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms)),
      clearTimer:
        deps.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)),
      log: deps.log ?? ((event, data) => logger.info(event, data)),
      platform: deps.platform ?? process.platform,
    }
  }

  /** The only work on the connection path: (re)arm one timer. */
  noteGroupedSessionCreated(): void {
    if (this.deps.platform !== 'darwin') return
    const now = this.deps.now()
    this.lastCreatedAt = now
    this.pendingSince ??= now
    this.schedule()
  }

  dispose(): void {
    this.cancelTimer()
    this.pendingSince = null
  }

  private cancelTimer(): void {
    if (this.timer !== null) this.deps.clearTimer(this.timer)
    this.timer = null
  }

  private schedule(): void {
    if (this.pendingSince === null) return
    const { settleMs, maxDelayMs, minIntervalMs } = this.timing
    const due = Math.max(
      Math.min(this.lastCreatedAt + settleMs, this.pendingSince + maxDelayMs),
      this.lastRunStartedAt + minIntervalMs
    )
    this.cancelTimer()
    this.timer = this.deps.setTimer(() => this.onTimer(), Math.max(0, due - this.deps.now()))
    ;(this.timer as { unref?: () => unknown }).unref?.()
  }

  private onTimer(): void {
    this.timer = null
    // Skipped, not queued: the running one reschedules when it finishes.
    if (this.inFlight) return
    void this.runScheduled()
  }

  private async runScheduled(): Promise<void> {
    const startedAt = this.deps.now()
    const outcome = await this.runNow()
    if (outcome.kind === 'skipped') return
    if (outcome.kind === 'abandoned') {
      // Stay pending, but let the next creation re-arm: no retry loop
      // against a tmux or kernel that is already struggling.
      return
    }
    // Creations within minAge of the start left shells too young to judge.
    const coveredUpTo = startedAt - this.timing.minAgeMs
    this.pendingSince =
      this.lastCreatedAt > coveredUpTo ? Math.max(this.pendingSince ?? coveredUpTo, coveredUpTo) : null
    this.schedule()
  }

  /** One reap pass. Never overlaps another; never throws. */
  async runNow(): Promise<ReapOutcome> {
    if (this.deps.platform !== 'darwin') return { kind: 'skipped', reason: 'platform' }
    if (this.inFlight) return { kind: 'skipped', reason: 'in-flight' }
    this.inFlight = true
    this.lastRunStartedAt = this.deps.now()
    try {
      const outcome = await this.reap()
      if (outcome.kind === 'reaped') {
        this.deps.log('tmux_group_throwaway_reaped', {
          hupPids: outcome.hupPids,
          killedPids: outcome.killedPids,
        })
      }
      return outcome
    } catch (error) {
      const outcome: ReapOutcome =
        error instanceof Abandon
          ? { kind: 'abandoned', step: error.step, reason: error.reason }
          : { kind: 'abandoned', step: this.step, reason: 'failed' }
      this.deps.log('tmux_throwaway_reap_abandoned', { step: outcome.step, reason: outcome.reason })
      return outcome
    } finally {
      this.inFlight = false
    }
  }

  private async query(
    step: ReapStep,
    argv: string[],
    okExitCodes: readonly number[]
  ): Promise<CommandResult> {
    this.step = step
    const result = await this.deps.runCommand(argv, this.timing.stepTimeoutMs)
    if (result === null) throw new Abandon(step, 'timeout')
    if (!okExitCodes.includes(result.exitCode)) throw new Abandon(step, 'failed')
    return result
  }

  private async processInfo(step: ReapStep, pids: readonly number[]): Promise<ProcessInfo[]> {
    // ps exits 1 when none of the pids exist; missing rows never match.
    const { stdout } = await this.query(step, ['ps', '-o', PS_FORMAT, ...pidArgs('-p', pids)], [0, 1])
    return parseProcessInfo(stdout)
  }

  private async reap(): Promise<ReapOutcome> {
    this.step = 'server-pid'
    const serverPid = this.deps.getServerPid()
    if (serverPid === null || !isValidPid(serverPid)) throw new Abandon('server-pid', 'failed')
    const { minAgeMs } = this.timing

    // pgrep exits 1 when the server has no children.
    const children = parsePidList(
      (await this.query('children', ['pgrep', '-P', String(serverPid)], [0, 1])).stdout
    )
    if (children.length === 0) return { kind: 'nothing' }

    const rows = (await this.processInfo('process-info', children)).filter((row) =>
      rowLooksStuck(row, serverPid, minAgeMs)
    )
    if (rows.length === 0) return { kind: 'nothing' }

    // After the child list, so a pane created in between is still excluded.
    const panes = parsePaneList(
      (await this.query('panes', ['tmux', 'list-panes', '-a', '-F', '#{pid} #{pane_pid}'], [0])).stdout
    )
    if ([...panes.serverPids].some((pid) => pid !== serverPid)) {
      throw new Abandon('panes', 'server-changed')
    }
    const notPanes = rows.filter((row) => !panes.panePids.has(row.pid))
    if (notPanes.length === 0) return { kind: 'nothing' }
    const candidatePids = notPanes.map((row) => row.pid)

    const grandchildren = parsePidList(
      (await this.query('grandchildren', ['pgrep', ...pidArgs('-P', candidatePids)], [0, 1])).stdout
    )
    const parentsWithChildren = new Set<number>()
    if (grandchildren.length > 0) {
      for (const row of await this.processInfo('grandchildren', grandchildren)) {
        parentsWithChildren.add(row.ppid)
      }
    }

    // lsof exits 1 when a pid vanished; the rest of its output still holds.
    const fdsByPid = parseLsofFds(
      (
        await this.query('fds', ['lsof', '-n', '-P', '-w', '-F', 'pf', ...pidArgs('-p', candidatePids)], [0, 1])
      ).stdout
    )

    const stuck = findStuckShells({
      rows: notPanes,
      serverPid,
      panePids: panes.panePids,
      parentsWithChildren,
      fdsByPid,
      minAgeMs,
    })
    if (stuck.length === 0) return { kind: 'nothing' }

    const hupPids = this.sendAll(stuck, 'SIGHUP')
    if (hupPids.length === 0) return { kind: 'nothing' }
    await this.deps.sleep(this.timing.hupGraceMs)

    // A pid that died and was reused cannot be an old, dashed, tty-holding
    // child of the tmux server, so the same row test guards the SIGKILL.
    let survivors: number[] = []
    try {
      survivors = (await this.processInfo('process-info', hupPids))
        .filter((row) => rowLooksStuck(row, serverPid, minAgeMs))
        .map((row) => row.pid)
    } catch {
      // The SIGHUP went out; report it and leave survivors to the next run.
    }
    return { kind: 'reaped', hupPids, killedPids: this.sendAll(survivors, 'SIGKILL') }
  }

  private sendAll(pids: readonly number[], signal: Signal): number[] {
    const sent: number[] = []
    for (const pid of pids) {
      if (!isValidPid(pid)) continue
      try {
        this.deps.signal(pid, signal)
        sent.push(pid)
      } catch {
        // Already exited
      }
    }
    return sent
  }
}
