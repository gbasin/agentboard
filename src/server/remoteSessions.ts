import { inferAgentType } from './agentDetection'
import { config } from './config'
import { logger } from './logger'
import {
  inferSessionStatus,
  type PaneCacheState,
  type PaneSnapshot,
} from './statusInference'
import { shellQuote } from './terminal/SshTerminalProxy'
import type { HostStatus, Session } from '../shared/types'

const DEFAULT_SSH_OPTIONS = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=3']
const TMUX_LIST_FORMAT =
  '#{session_name}\t#{window_index}\t#{window_id}\t#{window_name}\t#{pane_current_path}\t#{window_activity}\t#{window_creation_time}\t#{pane_start_command}'

const PANE_SEPARATOR = '__AGENTBOARD_PANE_SEP__'

// Cache of remote pane content for change detection (mirrors paneContentCache in SessionManager)
const remoteContentCache = new Map<string, PaneCacheState>()

interface RemoteHostSnapshot {
  host: string
  sessions: Session[]
  ok: boolean
  error?: string
  updatedAt: number
}

export interface RemoteSessionPollerOptions {
  hosts: string[]
  pollIntervalMs: number
  timeoutMs: number
  staleAfterMs: number
  sshOptions?: string
  tmuxSessionPrefix: string
  discoverPrefixes: string[]
  onUpdate?: (hosts: HostStatus[]) => void
}

export class RemoteSessionPoller {
  private readonly hosts: string[]
  private readonly pollIntervalMs: number
  private readonly timeoutMs: number
  private readonly staleAfterMs: number
  private readonly sshOptions: string[]
  private readonly tmuxSessionPrefix: string
  private readonly discoverPrefixes: string[]
  private readonly onUpdate?: (hosts: HostStatus[]) => void
  private timer: Timer | null = null
  private inFlight = false
  private lastStatusSnapshot = ''
  private snapshots = new Map<string, RemoteHostSnapshot>()
  // Optimistic sessions: sessions added/removed via create/kill that haven't
  // been picked up by the next poll cycle yet. Keyed by session ID.
  private optimisticAdds = new Map<string, { session: Session; host: string }>()
  private optimisticRemoves = new Set<string>()

  constructor(options: RemoteSessionPollerOptions) {
    this.hosts = options.hosts
    this.pollIntervalMs = options.pollIntervalMs
    this.timeoutMs = options.timeoutMs
    this.staleAfterMs = options.staleAfterMs
    this.sshOptions = [
      ...DEFAULT_SSH_OPTIONS,
      ...splitSshOptions(options.sshOptions ?? ''),
    ]
    this.tmuxSessionPrefix = options.tmuxSessionPrefix
    this.discoverPrefixes = options.discoverPrefixes
    this.onUpdate = options.onUpdate
  }

  start(): void {
    if (this.timer || this.hosts.length === 0) {
      return
    }
    void this.poll()
    this.timer = setInterval(() => {
      void this.poll()
    }, this.pollIntervalMs)
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  getSessions(): Session[] {
    const now = Date.now()
    const sessions: Session[] = []
    for (const snapshot of this.snapshots.values()) {
      if (!snapshot.ok) continue
      if (now - snapshot.updatedAt > this.staleAfterMs) continue
      sessions.push(...snapshot.sessions)
    }

    // Fast path: no optimistic entries pending
    if (this.optimisticAdds.size === 0 && this.optimisticRemoves.size === 0) {
      return sessions
    }

    // Apply optimistic removes
    const filtered = this.optimisticRemoves.size > 0
      ? sessions.filter((s) => !this.optimisticRemoves.has(s.id))
      : sessions

    // Apply optimistic adds (only if not already present from poll)
    if (this.optimisticAdds.size === 0) {
      return filtered
    }
    const existingIds = new Set(filtered.map((s) => s.id))
    const adds: Session[] = []
    for (const { session } of this.optimisticAdds.values()) {
      if (!existingIds.has(session.id)) {
        adds.push(session)
      }
    }

    return [...adds, ...filtered]
  }

  /** Register a session that was just created remotely. Cleared on next successful poll for its host. */
  addOptimisticSession(session: Session): void {
    if (!session.host) return
    this.optimisticAdds.set(session.id, { session, host: session.host })
    this.optimisticRemoves.delete(session.id)
  }

  /** Register a session that was just killed remotely. Cleared on next successful poll for its host. */
  removeOptimisticSession(sessionId: string, host: string): void {
    this.optimisticRemoves.add(sessionId)
    this.optimisticAdds.delete(sessionId)
    // Store host so we can clear on next poll
    this._removeHosts.set(sessionId, host)
  }

  private _removeHosts = new Map<string, string>()

  private clearOptimisticForHost(host: string): void {
    for (const [id, entry] of this.optimisticAdds) {
      if (entry.host === host) {
        this.optimisticAdds.delete(id)
      }
    }
    for (const id of this.optimisticRemoves) {
      if (this._removeHosts.get(id) === host) {
        this.optimisticRemoves.delete(id)
        this._removeHosts.delete(id)
      }
    }
  }

  getHostStatuses(): HostStatus[] {
    const now = Date.now()
    return this.hosts.map((host) => {
      const snapshot = this.snapshots.get(host)
      if (!snapshot) {
        return {
          host,
          ok: false,
          lastUpdated: new Date(0).toISOString(),
        }
      }
      const stale = now - snapshot.updatedAt > this.staleAfterMs
      const ok = snapshot.ok && !stale
      return {
        host,
        ok,
        lastUpdated: new Date(snapshot.updatedAt).toISOString(),
        error: ok ? undefined : snapshot.error ?? (stale ? 'stale' : undefined),
      }
    })
  }

  private async poll(): Promise<void> {
    if (this.inFlight) {
      return
    }
    this.inFlight = true
    try {
      const results = await Promise.allSettled(
        this.hosts.map((host) => pollHost(host, this.sshOptions, this.timeoutMs, this.tmuxSessionPrefix, this.discoverPrefixes))
      )

      results.forEach((result, index) => {
        const host = this.hosts[index]
        if (!host) return
        if (result.status === 'fulfilled') {
          this.snapshots.set(host, result.value)
          // Clear optimistic entries for this host — the poll has caught up
          this.clearOptimisticForHost(host)
        } else {
          this.snapshots.set(host, {
            host,
            sessions: [],
            ok: false,
            error: result.reason instanceof Error ? result.reason.message : String(result.reason),
            updatedAt: Date.now(),
          })
          // Also clear optimistic entries on failure to prevent unbounded growth
          this.clearOptimisticForHost(host)
        }
      })

      // Clean up stale remote content cache entries
      const allRemoteSessions: Session[] = []
      for (const snapshot of this.snapshots.values()) {
        allRemoteSessions.push(...snapshot.sessions)
      }
      cleanupRemoteContentCache(allRemoteSessions)

      const statuses = this.getHostStatuses()
      const nextSnapshot = JSON.stringify(statuses)
      if (nextSnapshot !== this.lastStatusSnapshot) {
        this.lastStatusSnapshot = nextSnapshot
        this.onUpdate?.(statuses)
      }
    } finally {
      this.inFlight = false
    }
  }
}

/**
 * Build a single shell command that captures pane dimensions + content
 * for all sessions, separated by a known marker.
 */
function buildBatchCaptureCommand(sessions: Session[]): string {
  if (sessions.length === 0) return ''
  return sessions
    .map((s) => {
      const target = shellQuote(s.tmuxWindow)
      // Group dims + capture; suppress stderr so failures produce empty segments
      return (
        `{ tmux display-message -t ${target} -p '#{pane_width} #{pane_height}'` +
        ` && tmux capture-pane -t ${target} -p -J; } 2>/dev/null; echo ${shellQuote(PANE_SEPARATOR)};`
      )
    })
    .join(' ')
}

/**
 * Parse the batched SSH capture output into per-session pane snapshots.
 * Each segment between separators contains: first line = "WIDTH HEIGHT", rest = pane content.
 */
function parseBatchCaptureOutput(
  output: string,
  sessions: Session[]
): Map<string, PaneSnapshot> {
  const result = new Map<string, PaneSnapshot>()
  const segments = output.split(PANE_SEPARATOR)

  for (let i = 0; i < sessions.length && i < segments.length; i++) {
    const segment = segments[i]!.trim()
    if (!segment) continue

    const lines = segment.split('\n')
    const dimsLine = lines[0]?.trim()
    if (!dimsLine) continue

    const dimsParts = dimsLine.split(' ')
    const width = Number.parseInt(dimsParts[0] ?? '', 10) || 80
    const height = Number.parseInt(dimsParts[1] ?? '', 10) || 24

    // Rest is pane content — strip trailing empty lines, take last 30 (matches local behavior)
    const contentLines = lines.slice(1)
    while (
      contentLines.length > 0 &&
      contentLines[contentLines.length - 1]!.trim() === ''
    ) {
      contentLines.pop()
    }
    const content = contentLines.slice(-30).join('\n')

    result.set(sessions[i]!.id, { content, width, height })
  }

  return result
}

/**
 * Enrich sessions with inferred status from captured pane content.
 * Maintains remoteContentCache for change detection across poll cycles.
 */
function enrichSessionsWithStatus(
  sessions: Session[],
  captures: Map<string, PaneSnapshot>,
  now: number,
  workingGracePeriodMs: number
): void {
  for (const session of sessions) {
    const pane = captures.get(session.id)
    if (!pane) continue

    const prev = remoteContentCache.get(session.id)
    const result = inferSessionStatus({
      prev,
      next: pane,
      now,
      workingGracePeriodMs,
    })

    session.status = result.status
    remoteContentCache.set(session.id, result.nextCache)
  }
}

/** Remove cache entries for sessions that no longer exist. */
function cleanupRemoteContentCache(activeSessions: Session[]): void {
  const activeIds = new Set(activeSessions.map((s) => s.id))
  for (const key of remoteContentCache.keys()) {
    if (!activeIds.has(key)) {
      remoteContentCache.delete(key)
    }
  }
}

/**
 * Capture pane content for all sessions on a host via a single batched SSH call,
 * then enrich each session's status via inferSessionStatus.
 */
async function captureRemotePaneStatus(
  sessions: Session[],
  host: string,
  sshOptions: string[],
  timeoutMs: number
): Promise<void> {
  const cmd = buildBatchCaptureCommand(sessions)
  if (!cmd) return

  const args = ['ssh', ...sshOptions, host, cmd]
  const proc = Bun.spawn(args, { stdout: 'pipe', stderr: 'pipe' })

  const timeout = setTimeout(() => {
    try {
      proc.kill()
    } catch {
      // ignore
    }
  }, timeoutMs)

  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])

  clearTimeout(timeout)

  // Don't fail the whole poll if capture fails — sessions keep 'unknown' status
  if (exitCode !== 0) {
    logger.warn('remote_pane_capture_failed', {
      host,
      exitCode,
      stderr: stderr.slice(0, 500),
    })
    return
  }

  const captures = parseBatchCaptureOutput(stdout, sessions)
  enrichSessionsWithStatus(
    sessions,
    captures,
    Date.now(),
    config.workingGracePeriodMs
  )
}

async function pollHost(
  host: string,
  sshOptions: string[],
  timeoutMs: number,
  tmuxSessionPrefix: string,
  discoverPrefixes: string[]
): Promise<RemoteHostSnapshot> {
  const args = ['ssh', ...sshOptions, host, `tmux list-windows -a -F '${TMUX_LIST_FORMAT}'`]
  const proc = Bun.spawn(args, { stdout: 'pipe', stderr: 'pipe' })

  const timeout = setTimeout(() => {
    try {
      proc.kill()
    } catch {
      // ignore
    }
  }, timeoutMs)

  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])

  clearTimeout(timeout)

  if (exitCode !== 0) {
    const message = stderr.trim() || `ssh exited with code ${exitCode}`
    logger.warn('remote_host_poll_failed', { host, message })
    return {
      host,
      sessions: [],
      ok: false,
      error: message,
      updatedAt: Date.now(),
    }
  }

  const sessions = parseTmuxWindows(host, stdout, tmuxSessionPrefix, discoverPrefixes)

  // Capture pane content and enrich with inferred status
  if (sessions.length > 0) {
    await captureRemotePaneStatus(sessions, host, sshOptions, timeoutMs)
  }

  return {
    host,
    sessions,
    ok: true,
    updatedAt: Date.now(),
  }
}

function parseTmuxWindows(
  host: string,
  output: string,
  tmuxSessionPrefix: string,
  discoverPrefixes: string[]
): Session[] {
  // Filter empty lines without trim() — trim() removes trailing tabs when
  // fields are empty (e.g., pane_start_command=''), losing the 8th field
  const lines = output.split('\n').filter((line) => /\S/.test(line))
  const now = Date.now()
  const sessions: Session[] = []
  const wsPrefix = `${tmuxSessionPrefix}-ws-`

  for (const line of lines) {
    const parts = line.split('\t')
    if (parts.length < 8) {
      continue
    }
    const [
      sessionName,
      windowIndex,
      windowId,
      windowName,
      cwd,
      activityRaw,
      createdRaw,
      command,
    ] = parts

    if (!sessionName || !windowIndex) {
      continue
    }

    // Skip internal proxy sessions (created by SshTerminalProxy)
    if (sessionName.startsWith(wsPrefix)) {
      continue
    }

    // Apply discover prefix filtering (same logic as SessionManager.listExternalWindows)
    if (sessionName !== tmuxSessionPrefix && discoverPrefixes.length > 0) {
      if (!discoverPrefixes.some((prefix) => sessionName.startsWith(prefix))) {
        continue
      }
    }

    const tmuxWindow = `${sessionName}:${windowIndex}`
    const createdAt = toIsoFromSeconds(createdRaw, now)
    const lastActivity = toIsoFromSeconds(activityRaw, now)
    const agentType = inferAgentType(command || '')
    const id = buildRemoteSessionId(host, sessionName, windowIndex, windowId)
    // For external sessions, use session name as display name (more meaningful
    // than window name which defaults to the running command, e.g. "bash").
    // Mirrors SessionManager.listWindowsForSession logic.
    const isManagedSession = sessionName === tmuxSessionPrefix
    const displayName = isManagedSession
      ? (windowName || tmuxWindow)
      : (sessionName || tmuxWindow)

    sessions.push({
      id,
      name: displayName,
      tmuxWindow,
      projectPath: (cwd || '').trim(),
      status: 'unknown',
      lastActivity,
      createdAt,
      agentType,
      source: 'external',
      host,
      remote: true,
      command: command || undefined,
    })
  }

  return sessions
}

function buildRemoteSessionId(
  host: string,
  sessionName: string,
  windowIndex: string,
  windowId?: string
): string {
  const suffix = windowId?.trim() ? windowId.trim() : windowIndex.trim()
  return `remote:${host}:${sessionName}:${suffix}`
}

function toIsoFromSeconds(value: string | undefined, fallbackMs: number): string {
  const parsed = Number.parseInt(value ?? '', 10)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return new Date(fallbackMs).toISOString()
  }
  return new Date(parsed * 1000).toISOString()
}

/**
 * Splits SSH options string, respecting quoted arguments.
 * Handles both single and double quotes.
 * Example: `-o "ProxyCommand ssh -W %h:%p bastion"` -> ['-o', 'ProxyCommand ssh -W %h:%p bastion']
 */
function splitSshOptions(value: string): string[] {
  if (!value.trim()) return []
  const result: string[] = []
  let current = ''
  let inQuote: '"' | "'" | null = null

  for (let i = 0; i < value.length; i++) {
    const char = value[i]!
    if (inQuote) {
      if (char === inQuote) {
        inQuote = null
      } else {
        current += char
      }
    } else if (char === '"' || char === "'") {
      inQuote = char
    } else if (/\s/.test(char)) {
      if (current) {
        result.push(current)
        current = ''
      }
    } else {
      current += char
    }
  }

  if (current) {
    result.push(current)
  }

  return result
}

// Export for testing
export {
  parseTmuxWindows,
  buildRemoteSessionId,
  toIsoFromSeconds,
  splitSshOptions,
  buildBatchCaptureCommand,
  parseBatchCaptureOutput,
  enrichSessionsWithStatus,
  cleanupRemoteContentCache,
  remoteContentCache,
  PANE_SEPARATOR,
}
