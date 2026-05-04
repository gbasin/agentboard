import fs from 'node:fs'
import { inferAgentType, normalizePaneStartCommand } from './agentDetection'
import { config } from './config'
import { resolveExternalDisplayName } from './displayName'
import { normalizeProjectPath } from './logDiscovery'
import { generateSessionName } from './nameGenerator'
import { logger } from './logger'
import { resolveProjectPath } from './paths'
import { TmuxTimeoutError } from './tmuxTimeout'
import {
  BOOTSTRAP_WINDOW_COMMAND,
  BOOTSTRAP_WINDOW_NAME,
  buildTmuxFormat,
  splitTmuxFields,
  splitTmuxLines,
  withTmuxUtf8Flag,
} from './tmuxFormat'
import {
  inferCachedSessionStatus,
  detectsPermissionPrompt,
  inferSessionStatus,
  type PaneCacheState,
} from './statusInference'
import type { Session, SessionStatus } from '../shared/types'

interface WindowInfo {
  id: string
  name: string
  path: string
  activity: number
  creation: number
  command: string
}

type TmuxRunner = (args: string[]) => string
type NowFn = () => number
type GroupLookupResult =
  | { reliable: true; sessionName: string | null }
  | { reliable: false; sessionName: null }

interface EnsureSessionResult {
  canPruneWsSessions: boolean
}

interface PaneCapture {
  content: string
  width: number
  height: number
}

type CapturePane = (tmuxWindow: string) => PaneCapture | null

// Cache of pane content, dimensions, and last-changed timestamp for change detection
const paneContentCache = new Map<string, PaneCacheState>()
const WINDOW_LIST_FORMAT = buildTmuxFormat([
  '#{window_id}',
  '#{window_name}',
  '#{pane_current_path}',
  '#{window_activity}',
  '#{window_creation_time}',
  '#{pane_start_command}',
])
const WINDOW_LIST_FORMAT_FALLBACK = buildTmuxFormat([
  '#{window_id}',
  '#{window_name}',
  '#{pane_current_path}',
  '#{window_activity}',
  '#{window_activity}',
  '#{pane_current_command}',
])
const WINDOW_INFO_FORMAT = buildTmuxFormat([
  '#{window_name}',
  '#{pane_current_path}',
])
const SESSION_GROUP_FORMAT = buildTmuxFormat([
  '#{session_name}',
  '#{session_group}',
])
const PANE_DIMENSIONS_FORMAT = buildTmuxFormat([
  '#{pane_width}',
  '#{pane_height}',
])
const TMUX_MUTATION_COMMANDS = new Set([
  'new-session',
  'new-window',
  'kill-window',
  'rename-window',
  'set-option',
])

export class SessionManager {
  private sessionName: string
  private runTmux: TmuxRunner
  private capturePaneContent: CapturePane
  private now: NowFn
  private displayNameExists: (name: string, excludeSessionId?: string) => boolean
  private mouseMode: boolean

  constructor(
    sessionName = config.tmuxSession,
    {
      runTmux: runTmuxOverride,
      capturePaneContent: captureOverride,
      now,
      displayNameExists,
      mouseMode = true,
    }: {
      runTmux?: TmuxRunner
      capturePaneContent?: CapturePane
      now?: NowFn
      displayNameExists?: (name: string, excludeSessionId?: string) => boolean
      mouseMode?: boolean
    } = {}
  ) {
    this.sessionName = sessionName
    this.runTmux = runTmuxOverride ?? runTmux
    this.capturePaneContent = captureOverride ?? capturePaneWithDimensions
    this.now = now ?? Date.now
    this.displayNameExists = displayNameExists ?? (() => false)
    this.mouseMode = mouseMode
  }

  ensureSession(): EnsureSessionResult {
    let canPruneWsSessions = true
    try {
      // Use exact-match (`=` prefix) so a session group with the same name
      // (e.g. created by per-connection `agentboard-ws-*` sessions joined via
      // `new-session -t agentboard`) does NOT satisfy this check. Without
      // exact match, `has-session -t agentboard` returns success whenever any
      // session is in the `agentboard` group, the base session never gets
      // created, and listings filter out every `-ws-` session they see →
      // empty windowSet → live windows get orphaned.
      this.runTmux(['has-session', '-t', `=${this.sessionName}`])
    } catch (error) {
      if (error instanceof TmuxTimeoutError) {
        throw error
      }
      const groupLookup = this.findSessionInGroup()
      if (groupLookup.sessionName) {
        this.runTmux([
          'new-session', '-d',
          '-s', this.sessionName,
          '-t', `=${groupLookup.sessionName}`,
        ])
      } else {
        canPruneWsSessions = groupLookup.reliable
        // Create the base session with a placeholder window. Tmux requires every
        // session to have at least one window, so we use a known-named window
        // running `tail -f /dev/null`. Listings filter this window out so it's
        // invisible to users.
        this.runTmux([
          'new-session', '-d',
          '-s', this.sessionName,
          '-n', BOOTSTRAP_WINDOW_NAME,
          BOOTSTRAP_WINDOW_COMMAND,
        ])
      }
    }
    this.configureSession()
    return { canPruneWsSessions }
  }

  private findSessionInGroup(): GroupLookupResult {
    try {
      const output = this.runParsedTmux(['list-sessions', '-F', SESSION_GROUP_FORMAT])
      for (const line of splitTmuxLines(output)) {
        const fields = splitTmuxFields(line, 2)
        if (!fields) {
          continue
        }
        const [sessionName, sessionGroup] = fields
        if (sessionGroup === this.sessionName && sessionName) {
          return { reliable: true, sessionName }
        }
      }
      return { reliable: true, sessionName: null }
    } catch (error) {
      if (error instanceof TmuxTimeoutError) {
        throw error
      }
      if (isTmuxSessionAbsentError(error)) {
        return { reliable: true, sessionName: null }
      }
      if (isTmuxFormatError(error)) {
        return { reliable: false, sessionName: null }
      }
      throw error
    }
  }

  private sessionExists(): boolean {
    try {
      this.runTmux(['has-session', '-t', `=${this.sessionName}`])
      return true
    } catch (error) {
      if (error instanceof TmuxTimeoutError) {
        throw error
      }
      if (isTmuxSessionAbsentError(error)) {
        return false
      }
      throw error
    }
  }

  private configureSession(): void {
    // Set mouse mode for scroll wheel support (SGR mouse sequences).
    // Scoped to this session only (-t) rather than global (-g).
    // Note: PtyTerminalProxy copies this setting onto grouped client sessions.
    const mouseValue = this.mouseMode ? 'on' : 'off'
    this.applyMouseMode(this.sessionName, mouseValue)
  }

  setMouseMode(enabled: boolean): void {
    const mouseValue = enabled ? 'on' : 'off'
    const previousMouseValue = this.mouseMode ? 'on' : 'off'
    let baseSessionUpdated = false
    const groupedSessionsUpdated: string[] = []

    try {
      // Apply directly so the longer mutation timeout covers the full update
      // path; absent sessions will be configured on the next ensureSession.
      try {
        this.applyMouseMode(this.sessionName, mouseValue)
        baseSessionUpdated = true
      } catch (error) {
        if (error instanceof TmuxTimeoutError) {
          throw error
        }
        if (!isTmuxSessionAbsentError(error)) {
          throw error
        }
        // Session doesn't exist yet, will be applied on next ensureSession.
      }

      // Keep existing grouped websocket client sessions in sync with the
      // base session mouse mode toggle.
      const wsPrefix = `${this.sessionName}-ws-`
      let groupedSessions: string[] = []
      try {
        groupedSessions = this.listSessions().filter((name) =>
          name.startsWith(wsPrefix)
        )
      } catch (error) {
        if (isTmuxSessionAbsentError(error)) {
          groupedSessions = []
        } else {
          logger.warn('tmux_mouse_mode_group_discovery_failed', {
            message: error instanceof Error ? error.message : String(error),
            timedOut: error instanceof TmuxTimeoutError,
          })
          throw error
        }
      }

      for (const groupedSession of groupedSessions) {
        try {
          this.applyMouseMode(groupedSession, mouseValue)
          groupedSessionsUpdated.push(groupedSession)
        } catch (error) {
          if (isTmuxSessionAbsentError(error)) {
            // Session may have exited between list-sessions and set-option.
            continue
          }
          logger.warn('tmux_mouse_mode_group_sync_failed', {
            groupedSession,
            message: error instanceof Error ? error.message : String(error),
            timedOut: error instanceof TmuxTimeoutError,
          })
          throw error
        }
      }

      this.mouseMode = enabled
    } catch (error) {
      this.rollbackMouseMode(previousMouseValue, groupedSessionsUpdated, baseSessionUpdated)
      throw error
    }
  }

  private applyMouseMode(target: string, mouseValue: string): void {
    this.runTmux(['set-option', '-t', target, 'mouse', mouseValue])
  }

  private rollbackMouseMode(
    mouseValue: string,
    groupedSessions: string[],
    baseSessionUpdated: boolean
  ): void {
    for (const groupedSession of [...groupedSessions].reverse()) {
      try {
        this.applyMouseMode(groupedSession, mouseValue)
      } catch (error) {
        if (isTmuxSessionAbsentError(error)) {
          continue
        }
        logger.warn('tmux_mouse_mode_rollback_failed', {
          target: groupedSession,
          message: error instanceof Error ? error.message : String(error),
          timedOut: error instanceof TmuxTimeoutError,
        })
      }
    }

    if (!baseSessionUpdated) {
      return
    }

    try {
      this.applyMouseMode(this.sessionName, mouseValue)
    } catch (error) {
      if (isTmuxSessionAbsentError(error)) {
        return
      }
      logger.warn('tmux_mouse_mode_rollback_failed', {
        target: this.sessionName,
        message: error instanceof Error ? error.message : String(error),
        timedOut: error instanceof TmuxTimeoutError,
      })
    }
  }

  listWindows(): Session[] {
    // Don't create the session just to list windows — that would leave an
    // orphan shell window (e.g. "zsh") visible in the UI.  Only configure
    // mouse mode when the session already exists.
    const exists = this.sessionExists()
    if (exists) {
      this.configureSession()
    }

    const managed = exists
      ? this.listWindowsForSession(this.sessionName, 'managed')
      : []
    const externals = this.listExternalWindows()
    const allSessions = [...managed, ...externals]

    // Clean up cache entries for windows that no longer exist
    const currentWindows = new Set(allSessions.map((s) => s.tmuxWindow))
    for (const key of paneContentCache.keys()) {
      if (!currentWindows.has(key)) {
        paneContentCache.delete(key)
      }
    }

    return allSessions
  }

  createWindow(
    projectPath: string,
    name?: string,
    command?: string,
    options?: { excludeSessionId?: string }
  ): Session {
    const sessionExisted = this.sessionExists()

    const resolvedPath = resolveProjectPath(projectPath)
    if (!resolvedPath) {
      throw new Error('Project path is required')
    }

    if (!fs.existsSync(resolvedPath)) {
      throw new Error(`Project path does not exist: ${resolvedPath}`)
    }

    const existingSessions = sessionExisted
      ? this.listWindowsForSession(this.sessionName, 'managed')
      : []
    const existingWindowNames = new Set(
      existingSessions.map((session) => session.name)
    )
    const existingWindowIds = new Set(
      existingSessions.map((session) => session.tmuxWindow)
    )

    // Check both tmux windows and DB for name collisions
    const excludeSessionId = options?.excludeSessionId
    const nameExists = (n: string) =>
      existingWindowNames.has(n) || this.displayNameExists(n, excludeSessionId)

    let baseName = name?.trim()
    if (baseName) {
      baseName = baseName.replace(/\s+/g, '-')
    } else {
      // Generate random name, retry if collision with tmux windows or DB
      do {
        baseName = generateSessionName()
      } while (nameExists(baseName))
    }
    this.assertNotReservedWindowName(baseName)

    const finalCommand = command?.trim() || 'claude'
    const finalName = this.findAvailableName(baseName, existingWindowNames, nameExists)

    if (!sessionExisted) {
      // Create session + window in one step to avoid orphan shell window
      this.runTmux([
        'new-session', '-d',
        '-s', this.sessionName,
        '-n', finalName,
        '-c', resolvedPath,
        finalCommand,
      ])
      this.configureSession()
    } else {
      const nextIndex = this.findNextAvailableWindowIndex()
      this.runTmux([
        'new-window',
        '-t', `${this.sessionName}:${nextIndex}`,
        '-n', finalName,
        '-c', resolvedPath,
        finalCommand,
      ])
    }

    // Retry finding the created window - tmux may have slight delay making it visible
    const maxRetries = 5
    const retryDelayMs = 50
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      const sessions = this.listWindowsForSession(this.sessionName, 'managed')
      let created = sessions.find((session) => session.name === finalName)

      if (!created) {
        // Fallback: identify the new window by diffing IDs (handles auto-rename)
        const newWindows = sessions.filter(
          (session) => !existingWindowIds.has(session.tmuxWindow)
        )
        if (newWindows.length === 1) {
          created = newWindows[0]
        } else if (newWindows.length > 1) {
          const normalizedPath = normalizeProjectPath(resolvedPath)
          const commandToken = finalCommand.split(/\s+/)[0] || ''
          created =
            newWindows.find(
              (session) =>
                session.projectPath === normalizedPath &&
                (commandToken ? session.command?.includes(commandToken) : true)
            ) ??
            newWindows.find(
              (session) => session.projectPath === normalizedPath
            ) ??
            newWindows.find(
              (session) =>
                commandToken ? session.command?.includes(commandToken) : false
            ) ??
            newWindows[0]
        }
      }

      if (created) {
        return created
      }

      // Window not visible yet - wait and retry (except on last attempt)
      if (attempt < maxRetries) {
        Bun.sleepSync(retryDelayMs)
      }
    }

    throw new Error('Failed to create tmux window')
  }

  setWindowOption(tmuxWindow: string, option: string, value: string): void {
    this.runTmux(['set-option', '-w', '-t', tmuxWindow, option, value])
  }

  killWindow(tmuxWindow: string): void {
    // Log window info before killing
    try {
      const info = this.runParsedTmux([
        'display-message',
        '-t',
        tmuxWindow,
        '-p',
        WINDOW_INFO_FORMAT,
      ])
      const parts = splitTmuxFields(info.trim(), 2)
      const name = parts?.[0]
      const path = parts?.[1]
      logger.info('window_killed', { tmuxWindow, name, path })
    } catch {
      // Window may already be gone, log what we know
      logger.info('window_killed', { tmuxWindow })
    }
    this.runTmux(['kill-window', '-t', tmuxWindow])
    paneContentCache.delete(tmuxWindow)
  }

  renameWindow(tmuxWindow: string, newName: string): void {
    const trimmed = newName.trim()
    if (!trimmed) {
      throw new Error('Name cannot be empty')
    }

    // Validate: alphanumeric, hyphens, underscores only
    if (!/^[\w-]+$/.test(trimmed)) {
      throw new Error(
        'Name can only contain letters, numbers, hyphens, and underscores'
      )
    }
    this.assertNotReservedWindowName(trimmed)

    const sessionName = this.resolveSessionName(tmuxWindow)
    const targetWindowId = this.extractWindowId(tmuxWindow)
    const existingNames = new Set(
      this.listWindowsForSession(sessionName, 'managed')
        .filter((s) => this.extractWindowId(s.tmuxWindow) !== targetWindowId)
        .map((s) => s.name)
    )

    if (existingNames.has(trimmed)) {
      throw new Error(`A session named "${trimmed}" already exists`)
    }

    this.runTmux(['rename-window', '-t', tmuxWindow, trimmed])
  }

  private listExternalWindows(): Session[] {
    const wsPrefix = `${this.sessionName}-ws-`
    const allSessions = this.listSessions().filter(
      (sessionName) => !sessionName.startsWith(wsPrefix)
    )
    const sessions =
      config.discoverPrefixes.length === 0
        ? allSessions.filter((sessionName) => sessionName !== this.sessionName)
        : allSessions.filter((sessionName) =>
            config.discoverPrefixes.some((prefix) =>
              sessionName.startsWith(prefix)
            )
          )

    return sessions.flatMap((sessionName) =>
      this.listWindowsForSession(sessionName, 'external')
    )
  }

  private listSessions(): string[] {
    try {
      const output = this.runParsedTmux(['list-sessions', '-F', '#{session_name}'])
      return splitTmuxLines(output)
    } catch (error) {
      if (error instanceof TmuxTimeoutError) {
        throw error
      }
      if (isTmuxSessionAbsentError(error)) {
        return []
      }
      throw error
    }
  }

  private listWindowsForSession(
    sessionName: string,
    source: Session['source']
  ): Session[] {
    const output = this.listWindowOutput(sessionName)

    return splitTmuxLines(output)
      .flatMap((line) => {
        const window = parseWindow(line)
        return window ? [window] : []
      })
      // Hide the placeholder window that keeps the base session alive.
      .filter((window) => !this.isBootstrapWindow(sessionName, window))
      .map((window) => {
        const tmuxWindow = `${sessionName}:${window.id}`
        const creationTimestamp = window.creation
          ? window.creation * 1000
          : this.now()
        const { status, lastChanged } = inferStatus(
          tmuxWindow,
          this.capturePaneContent,
          this.now
        )
        // For external sessions, use session name as display name (more meaningful than window name).
        // With AGENTBOARD_PREFER_WINDOW_NAME=true, use window name when distinct from session name.
        const displayName = source === 'external'
          ? resolveExternalDisplayName(sessionName, window.name, config.preferWindowName)
          : window.name
        const normalizedPath = normalizeProjectPath(window.path)
        return {
          id: `${sessionName}:${window.id}`,
          name: displayName,
          tmuxWindow,
          projectPath: normalizedPath || window.path,
          status,
          lastActivity: new Date(lastChanged).toISOString(),
          createdAt: new Date(creationTimestamp).toISOString(),
          agentType: inferAgentType(window.command),
          source,
          command: window.command || undefined,
        }
      })
  }

  private listWindowOutput(sessionName: string): string {
    const args = ['list-windows', '-t', sessionName, '-F']

    try {
      return this.runParsedTmux([...args, WINDOW_LIST_FORMAT])
    } catch (error) {
      if (!isTmuxFormatError(error)) {
        throw error
      }
    }

    return this.runParsedTmux([...args, WINDOW_LIST_FORMAT_FALLBACK])
  }

  private findAvailableName(
    base: string,
    existing: Set<string>,
    nameExists?: (name: string) => boolean
  ): string {
    const checkExists = nameExists ?? ((n: string) => existing.has(n))

    if (!checkExists(base)) {
      return base
    }

    // If base already ends with -N, strip it and increment from there
    const suffixMatch = base.match(/^(.+)-(\d+)$/)
    const baseName = suffixMatch ? suffixMatch[1] : base
    let suffix = suffixMatch ? Number.parseInt(suffixMatch[2], 10) + 1 : 2

    while (checkExists(`${baseName}-${suffix}`)) {
      suffix += 1
    }

    return `${baseName}-${suffix}`
  }

  private assertNotReservedWindowName(name: string): void {
    if (name === BOOTSTRAP_WINDOW_NAME) {
      throw new Error(`"${BOOTSTRAP_WINDOW_NAME}" is reserved`)
    }
  }

  private isBootstrapWindow(sessionName: string, window: WindowInfo): boolean {
    return (
      sessionName === this.sessionName &&
      window.name === BOOTSTRAP_WINDOW_NAME
    )
  }

  private findNextAvailableWindowIndex(): number {
    const baseIndex = this.getTmuxBaseIndex()
    const usedIndices = this.getWindowIndices()

    if (usedIndices.length === 0) {
      return baseIndex
    }

    // Find the first gap, or use max + 1
    const maxIndex = Math.max(...usedIndices)
    for (let i = baseIndex; i <= maxIndex; i++) {
      if (!usedIndices.includes(i)) {
        return i
      }
    }

    return maxIndex + 1
  }

  private getTmuxBaseIndex(): number {
    try {
      const output = this.runParsedTmux(['show-options', '-gv', 'base-index'])
      return Number.parseInt(output.trim(), 10) || 0
    } catch {
      return 0
    }
  }

  private getWindowIndices(): number[] {
    try {
      const output = this.runParsedTmux([
        'list-windows',
        '-t',
        this.sessionName,
        '-F',
        '#{window_index}',
      ])
      return splitTmuxLines(output)
        .map((line) => Number.parseInt(line, 10))
        .filter((n) => !Number.isNaN(n))
    } catch {
      return []
    }
  }

  private resolveSessionName(tmuxWindow: string): string {
    const colonIndex = tmuxWindow.indexOf(':')
    if (colonIndex > 0) {
      return tmuxWindow.slice(0, colonIndex)
    }

    const resolved = this.runParsedTmux([
      'display-message',
      '-p',
      '-t',
      tmuxWindow,
      '#{session_name}',
    ]).trim()

    if (!resolved) {
      throw new Error('Unable to resolve session for window')
    }

    return resolved
  }

  private extractWindowId(tmuxWindow: string): string {
    const parts = tmuxWindow.split(':')
    const windowTarget = parts[parts.length - 1] || tmuxWindow
    const paneSplit = windowTarget.split('.')
    return paneSplit[0] || windowTarget
  }

  private runParsedTmux(args: string[]): string {
    return this.runTmux(withTmuxUtf8Flag(args))
  }
}

function parseWindow(line: string): WindowInfo | null {
  const parts = splitTmuxFields(line, 6)
  if (!parts) {
    return null
  }

  const [id, name, panePath, activityRaw, creationRaw, command] = parts
  const activity = Number.parseInt(activityRaw || '0', 10)
  const creation = Number.parseInt(creationRaw || '0', 10)

  return {
    id: id || '',
    name: name || 'unknown',
    path: panePath || '',
    activity: Number.isNaN(activity) ? 0 : activity,
    creation: Number.isNaN(creation) ? 0 : creation,
    command: normalizePaneStartCommand(command || ''),
  }
}

function runTmux(args: string[]): string {
  const command = getTmuxCommand(args)
  const timeout = TMUX_MUTATION_COMMANDS.has(command)
    ? config.tmuxMutationTimeoutMs
    : config.tmuxTimeoutMs
  const result = Bun.spawnSync(['tmux', ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    timeout,
  })
  if (result.signalCode === 'SIGTERM' || result.exitCode === null) {
    throw new TmuxTimeoutError(command, timeout)
  }

  if (result.exitCode !== 0) {
    const error = result.stderr.toString() || 'tmux command failed'
    throw new Error(error)
  }

  return result.stdout.toString()
}

function getTmuxCommand(args: string[]): string {
  return args[0] === '-u' ? args[1] ?? 'command' : args[0] ?? 'command'
}

function isTmuxSessionAbsentError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false
  }

  const message = error.message.toLowerCase()
  return (
    message.includes("can't find session") ||
    message.includes('session not found') ||
    message.includes('failed to connect to server') ||
    message.includes('no server running') ||
    (
      message.includes('error connecting to ') &&
      (
        message.includes('no such file or directory') ||
        message.includes('connection refused')
      )
    )
  )
}

function isTmuxFormatError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false
  }

  const message = error.message.toLowerCase()
  return (
    message.includes('unknown format') ||
    message.includes('invalid format') ||
    message.includes('unknown variable')
  )
}

interface StatusResult {
  status: SessionStatus
  lastChanged: number
}

function inferStatus(
  tmuxWindow: string,
  capture: CapturePane = capturePaneWithDimensions,
  now: NowFn = Date.now
): StatusResult {
  const currentTime = now()
  const cached = paneContentCache.get(tmuxWindow)
  const pane = capture(tmuxWindow)
  if (pane === null) {
    const fallback = inferCachedSessionStatus({
      prev: cached,
      now: currentTime,
      workingGracePeriodMs: config.workingGracePeriodMs,
    })
    if (!fallback) {
      return { status: 'unknown', lastChanged: currentTime }
    }
    paneContentCache.set(tmuxWindow, fallback.nextCache)
    return { status: fallback.status, lastChanged: fallback.lastChanged }
  }

  const result = inferSessionStatus({
    prev: cached,
    next: pane,
    now: currentTime,
    workingGracePeriodMs: config.workingGracePeriodMs,
  })

  paneContentCache.set(tmuxWindow, result.nextCache)

  return { status: result.status, lastChanged: result.lastChanged }
}

function capturePaneWithDimensions(tmuxWindow: string): PaneCapture | null {
  try {
    const dimsResult = Bun.spawnSync(
      ['tmux',
        ...withTmuxUtf8Flag([
        'display-message',
        '-t',
        tmuxWindow,
        '-p',
        PANE_DIMENSIONS_FORMAT,
      ])],
      {
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: config.tmuxTimeoutMs,
      }
    )
    if (dimsResult.signalCode === 'SIGTERM' || dimsResult.exitCode === null) {
      return null
    }
    if (dimsResult.exitCode !== 0) {
      return null
    }

    const parts = splitTmuxFields(
      dimsResult.stdout
      .toString()
      .trim(),
      2
    )
    if (!parts) {
      return null
    }
    const [widthText, heightText] = parts
    const width = Number.parseInt(widthText ?? '', 10) || 80
    const height = Number.parseInt(heightText ?? '', 10) || 24

    // Use -J to unwrap lines and only capture visible content (no scrollback)
    // This prevents false positives from scrollback buffer changes on window focus
    const result = Bun.spawnSync(
      ['tmux', 'capture-pane', '-t', tmuxWindow, '-p', '-J'],
      {
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: config.tmuxTimeoutMs,
      }
    )
    if (result.signalCode === 'SIGTERM' || result.exitCode === null) {
      return null
    }
    if (result.exitCode !== 0) {
      return null
    }
    // Only compare last 30 lines to avoid scrollback noise
    // First strip trailing empty lines so the "last 30" are actual content
    const lines = result.stdout.toString().split('\n')
    while (lines.length > 0 && lines[lines.length - 1].trim() === '') {
      lines.pop()
    }
    const content = lines.slice(-30).join('\n')
    return { content, width, height }
  } catch {
    return null
  }
}

// Re-export for external use
export { detectsPermissionPrompt } from './statusInference'
