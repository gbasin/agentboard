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
//   - a direct child of the tmux server, or a marked shell adopted by PID 1
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
import { getThrowawayCwd } from './tmuxGroupedSession'
import {
  findStuckShells, isValidPid, parsePidList, parseProcessInfo, parsePaneList,
  parseLsofFds, parseLsofCwds, rowLooksStuck, pidArgs, PS_FORMAT, type ProcessInfo,
} from './throwawayShellEvidence'

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

export type ReapStep = 'server-pid' | 'children' | 'process-info' | 'panes' | 'grandchildren' | 'fds'

export type ReapOutcome =
  | { kind: 'skipped'; reason: 'platform' | 'in-flight' | 'disposed' }
  | { kind: 'nothing' }
  | { kind: 'abandoned'; step: ReapStep; reason: 'timeout' | 'failed' | 'server-changed' }
  | { kind: 'reaped'; hupPids: number[]; killedPids: number[] }

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
  private disposed = false
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
    if (this.disposed || this.deps.platform !== 'darwin') return
    const now = this.deps.now()
    this.lastCreatedAt = now
    this.pendingSince ??= now
    this.schedule()
  }

  dispose(): void {
    this.disposed = true
    this.cancelTimer()
    this.pendingSince = null
  }

  private cancelTimer(): void {
    if (this.timer !== null) this.deps.clearTimer(this.timer)
    this.timer = null
  }

  private schedule(): void {
    if (this.disposed || this.pendingSince === null) return
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
    if (this.disposed) return { kind: 'skipped', reason: 'disposed' }
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
      if (this.disposed) return { kind: 'skipped', reason: 'disposed' }
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
    if (this.disposed) throw new Abandon(step, 'failed')
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
    const observedPid = this.deps.getServerPid()
    const serverPid = observedPid !== null && isValidPid(observedPid) ? observedPid : null

    // Include our user's PID-1 children: a private tmux server may have exited
    // before its delayed cleanup. Only marked orphans can pass findCandidates.
    // pgrep exits 1 when the server has no children.
    const children = parsePidList(
      (await this.query('children', ['pgrep', '-P', serverPid === null ? '1' : `${serverPid},1`, '-u', String(process.getuid!())], [0, 1])).stdout
    )
    if (children.length === 0) return { kind: 'nothing' }

    const stuck = await this.findCandidates(serverPid, children)
    if (stuck.length === 0) return { kind: 'nothing' }
    const hupPids = this.sendAll(stuck, 'SIGHUP')
    if (hupPids.length === 0) return { kind: 'nothing' }
    await this.deps.sleep(this.timing.hupGraceMs)
    let survivors: number[] = []
    try {
      // Recheck ALL evidence: the shell may have started or acquired children.
      survivors = await this.findCandidates(serverPid, hupPids)
    } catch {
      // Report the HUP and leave survivors for a later pass.
    }
    return { kind: 'reaped', hupPids, killedPids: this.sendAll(survivors, 'SIGKILL') }
  }

  private async findCandidates(serverPid: number | null, pids: number[]): Promise<number[]> {
    const { minAgeMs } = this.timing
    const rows = (await this.processInfo('process-info', pids)).filter((row) =>
      rowLooksStuck(row, serverPid, minAgeMs) || rowLooksStuck(row, 1, minAgeMs)
    )
    if (rows.length === 0) return []

    // An orphan cannot be a live tmux pane. Do not query tmux for orphan-only
    // runs: exhaustion may prevent any server from starting in the first place.
    let panePids = new Set<number>()
    if (rows.some((row) => row.ppid === serverPid)) {
      // Read after the child list so concurrently created panes stay protected.
      const panes = parsePaneList(
        (await this.query('panes', ['tmux', 'list-panes', '-a', '-F', '#{pid} #{pane_pid}'], [0])).stdout
      )
      if ([...panes.serverPids].some((pid) => pid !== serverPid)) {
        throw new Abandon('panes', 'server-changed')
      }
      panePids = panes.panePids
    }
    const notPanes = rows.filter((row) => !panePids.has(row.pid))
    if (notPanes.length === 0) return []
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
    const { stdout } = await this.query('fds',
      ['lsof', '-n', '-P', '-w', '-F', 'pfn', ...pidArgs('-p', candidatePids)], [0, 1])
    const fdsByPid = parseLsofFds(stdout)
    const marker = getThrowawayCwd()
    const markedOrphans = new Set([...parseLsofCwds(stdout)]
      .filter(([, cwd]) => cwd === marker).map(([pid]) => pid))

    return findStuckShells({
      rows: notPanes,
      markedOrphans,
      serverPid,
      panePids,
      parentsWithChildren,
      fdsByPid,
      minAgeMs,
    })
  }

  private sendAll(pids: readonly number[], signal: Signal): number[] {
    const sent: number[] = []
    if (this.disposed) return sent
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
