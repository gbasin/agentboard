import { inferAgentType } from './agentDetection'
import { logger } from './logger'
import type { HostStatus, Session } from '../shared/types'

const DEFAULT_SSH_OPTIONS = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=3']
const TMUX_LIST_FORMAT =
  '#{session_name}\\t#{window_index}\\t#{window_id}\\t#{window_name}\\t#{pane_current_path}\\t#{window_activity}\\t#{window_creation_time}\\t#{pane_start_command}'

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
  onUpdate?: (hosts: HostStatus[]) => void
}

export class RemoteSessionPoller {
  private readonly hosts: string[]
  private readonly pollIntervalMs: number
  private readonly timeoutMs: number
  private readonly staleAfterMs: number
  private readonly sshOptions: string[]
  private readonly onUpdate?: (hosts: HostStatus[]) => void
  private timer: Timer | null = null
  private inFlight = false
  private lastStatusSnapshot = ''
  private snapshots = new Map<string, RemoteHostSnapshot>()

  constructor(options: RemoteSessionPollerOptions) {
    this.hosts = options.hosts
    this.pollIntervalMs = options.pollIntervalMs
    this.timeoutMs = options.timeoutMs
    this.staleAfterMs = options.staleAfterMs
    this.sshOptions = [
      ...DEFAULT_SSH_OPTIONS,
      ...splitSshOptions(options.sshOptions ?? ''),
    ]
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
    return sessions
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
        this.hosts.map((host) => pollHost(host, this.sshOptions, this.timeoutMs))
      )

      results.forEach((result, index) => {
        const host = this.hosts[index]
        if (!host) return
        if (result.status === 'fulfilled') {
          this.snapshots.set(host, result.value)
        } else {
          this.snapshots.set(host, {
            host,
            sessions: [],
            ok: false,
            error: result.reason instanceof Error ? result.reason.message : String(result.reason),
            updatedAt: Date.now(),
          })
        }
      })

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

async function pollHost(
  host: string,
  sshOptions: string[],
  timeoutMs: number
): Promise<RemoteHostSnapshot> {
  const startedAt = Date.now()
  const args = ['ssh', ...sshOptions, host, 'tmux', 'list-windows', '-a', '-F', TMUX_LIST_FORMAT]
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

  const sessions = parseTmuxWindows(host, stdout)
  return {
    host,
    sessions,
    ok: true,
    updatedAt: Date.now(),
  }
}

function parseTmuxWindows(host: string, output: string): Session[] {
  const lines = output.split('\n').map((line) => line.trim()).filter(Boolean)
  const now = Date.now()
  const sessions: Session[] = []

  for (const line of lines) {
    const parts = line.split('\\t')
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

    const tmuxWindow = `${sessionName}:${windowIndex}`
    const createdAt = toIsoFromSeconds(createdRaw, now)
    const lastActivity = toIsoFromSeconds(activityRaw, now)
    const agentType = inferAgentType(command || '')
    const id = buildRemoteSessionId(host, sessionName, windowIndex, windowId)

    sessions.push({
      id,
      name: windowName || tmuxWindow,
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

function splitSshOptions(value: string): string[] {
  if (!value.trim()) return []
  return value.split(/\s+/).map((part) => part.trim()).filter(Boolean)
}
