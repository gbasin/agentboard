import fs from 'node:fs'
import { inferAgentType } from './agentDetection'
import { config } from './config'
import { normalizeProjectPath } from './logDiscovery'
import { generateSessionName } from './nameGenerator'
import { logger } from './logger'
import { resolveProjectPath } from './paths'
import {
  detectsPermissionPrompt,
  isMeaningfulResizeChange,
  normalizeContent,
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

interface PaneCapture {
  content: string
  width: number
  height: number
}

type CapturePane = (tmuxWindow: string) => PaneCapture | null

// Cache of pane content, dimensions, and last-changed timestamp for change detection
interface PaneCache {
  content: string
  lastChanged: number
  width: number
  height: number
}
const paneContentCache = new Map<string, PaneCache>()
const WINDOW_LIST_FORMAT =
  '#{window_id}\t#{window_name}\t#{pane_current_path}\t#{window_activity}\t#{window_creation_time}\t#{pane_start_command}'
const WINDOW_LIST_FORMAT_FALLBACK =
  '#{window_id}\t#{window_name}\t#{pane_current_path}\t#{window_activity}\t#{window_activity}\t#{pane_current_command}'

export class SessionManager {
  private sessionName: string
  private runTmux: TmuxRunner
  private capturePaneContent: CapturePane
  private now: NowFn
  private displayNameExists: (name: string, excludeSessionId?: string) => boolean

  constructor(
    sessionName = config.tmuxSession,
    {
      runTmux: runTmuxOverride,
      capturePaneContent: captureOverride,
      now,
      displayNameExists,
    }: {
      runTmux?: TmuxRunner
      capturePaneContent?: CapturePane
      now?: NowFn
      displayNameExists?: (name: string, excludeSessionId?: string) => boolean
    } = {}
  ) {
    this.sessionName = sessionName
    this.runTmux = runTmuxOverride ?? runTmux
    this.capturePaneContent = captureOverride ?? capturePaneWithDimensions
    this.now = now ?? Date.now
    this.displayNameExists = displayNameExists ?? (() => false)
  }

  ensureSession(): void {
    try {
      this.runTmux(['has-session', '-t', this.sessionName])
    } catch {
      this.runTmux(['new-session', '-d', '-s', this.sessionName])
    }
  }

  listWindows(): Session[] {
    this.ensureSession()

    const managed = this.listWindowsForSession(this.sessionName, 'managed')
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
    this.ensureSession()

    const resolvedPath = resolveProjectPath(projectPath)
    if (!resolvedPath) {
      throw new Error('Project path is required')
    }

    if (!fs.existsSync(resolvedPath)) {
      throw new Error(`Project path does not exist: ${resolvedPath}`)
    }

    const existingWindowNames = new Set(
      this.listWindowsForSession(this.sessionName, 'managed').map(
        (session) => session.name
      )
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

    const finalCommand = command?.trim() || 'claude'
    const finalName = this.findAvailableName(baseName, existingWindowNames, nameExists)
    const nextIndex = this.findNextAvailableWindowIndex()

    const tmuxArgs = [
      'new-window',
      '-t',
      `${this.sessionName}:${nextIndex}`,
      '-n',
      finalName,
      '-c',
      resolvedPath,
      finalCommand,
    ]
    this.runTmux(tmuxArgs)

    const sessions = this.listWindowsForSession(this.sessionName, 'managed')
    const created = sessions.find((session) => session.name === finalName)

    if (!created) {
      throw new Error('Failed to create tmux window')
    }

    return created
  }

  killWindow(tmuxWindow: string): void {
    // Log window info before killing
    try {
      const info = this.runTmux([
        'display-message',
        '-t',
        tmuxWindow,
        '-p',
        '#{window_name}\t#{pane_current_path}',
      ])
      const [name, path] = info.trim().split('\t')
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
      const output = this.runTmux(['list-sessions', '-F', '#{session_name}'])
      return output
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
    } catch {
      return []
    }
  }

  private listWindowsForSession(
    sessionName: string,
    source: Session['source']
  ): Session[] {
    const output = this.listWindowOutput(sessionName)

    return output
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => parseWindow(line))
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
        // For external sessions, use session name as display name (more meaningful than window name)
        const displayName = source === 'external' ? sessionName : window.name
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
      return this.runTmux([...args, WINDOW_LIST_FORMAT])
    } catch (error) {
      if (!isTmuxFormatError(error)) {
        throw error
      }
    }

    return this.runTmux([...args, WINDOW_LIST_FORMAT_FALLBACK])
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
      const output = this.runTmux(['show-options', '-gv', 'base-index'])
      return Number.parseInt(output.trim(), 10) || 0
    } catch {
      return 0
    }
  }

  private getWindowIndices(): number[] {
    try {
      const output = this.runTmux([
        'list-windows',
        '-t',
        this.sessionName,
        '-F',
        '#{window_index}',
      ])
      return output
        .split('\n')
        .map((line) => Number.parseInt(line.trim(), 10))
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

    const resolved = this.runTmux([
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
}

function parseWindow(line: string): WindowInfo {
  const [id, name, panePath, activityRaw, creationRaw, command] =
    line.split('\t')
  const activity = Number.parseInt(activityRaw || '0', 10)
  const creation = Number.parseInt(creationRaw || '0', 10)

  return {
    id: id || '',
    name: name || 'unknown',
    path: panePath || '',
    activity: Number.isNaN(activity) ? 0 : activity,
    creation: Number.isNaN(creation) ? 0 : creation,
    command: command || '',
  }
}

function runTmux(args: string[]): string {
  const result = Bun.spawnSync(['tmux', ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
  })

  if (result.exitCode !== 0) {
    const error = result.stderr.toString() || 'tmux command failed'
    throw new Error(error)
  }

  return result.stdout.toString()
}

function isTmuxFormatError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false
  }

  const message = error.message.toLowerCase()
  return message.includes('unknown format') || message.includes('invalid format')
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
  const pane = capture(tmuxWindow)
  if (pane === null) {
    return { status: 'unknown', lastChanged: now() }
  }

  const { content, width, height } = pane

  // Check for permission prompts first (takes priority over working/waiting)
  if (detectsPermissionPrompt(content)) {
    const cached = paneContentCache.get(tmuxWindow)
    return { status: 'permission', lastChanged: cached?.lastChanged ?? now() }
  }

  const cached = paneContentCache.get(tmuxWindow)
  let contentChanged = false
  if (cached !== undefined) {
    const dimensionsChanged =
      cached.width !== width || cached.height !== height
    if (dimensionsChanged) {
      const oldNormalized = normalizeContent(cached.content)
      const newNormalized = normalizeContent(content)
      const resizeStats = isMeaningfulResizeChange(
        oldNormalized,
        newNormalized
      )
      contentChanged = resizeStats.changed
    } else {
      contentChanged = cached.content !== content
    }
  }
  const lastChanged = contentChanged ? now() : (cached?.lastChanged ?? now())

  paneContentCache.set(tmuxWindow, { content, width, height, lastChanged })

  // If no previous content, assume waiting (just started monitoring)
  if (cached === undefined) {
    return { status: 'waiting', lastChanged }
  }

  // If content changed, it's working; otherwise waiting
  return { status: contentChanged ? 'working' : 'waiting', lastChanged }
}

function capturePaneWithDimensions(tmuxWindow: string): PaneCapture | null {
  try {
    const dimsResult = Bun.spawnSync(
      [
        'tmux',
        'display-message',
        '-t',
        tmuxWindow,
        '-p',
        '#{pane_width}\t#{pane_height}',
      ],
      { stdout: 'pipe', stderr: 'pipe' }
    )
    if (dimsResult.exitCode !== 0) {
      return null
    }

    const [widthText, heightText] = dimsResult.stdout
      .toString()
      .trim()
      .split('\t')
    const width = Number.parseInt(widthText ?? '', 10) || 80
    const height = Number.parseInt(heightText ?? '', 10) || 24

    // Use -J to unwrap lines and only capture visible content (no scrollback)
    // This prevents false positives from scrollback buffer changes on window focus
    const result = Bun.spawnSync(
      ['tmux', 'capture-pane', '-t', tmuxWindow, '-p', '-J'],
      { stdout: 'pipe', stderr: 'pipe' }
    )
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
