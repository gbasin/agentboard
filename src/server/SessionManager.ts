import fs from 'node:fs'
import { config } from './config'
import { generateSessionName } from './nameGenerator'
import { logger } from './logger'
import { resolveProjectPath } from './paths'
import {
  stripAnsi,
  TMUX_DECORATIVE_LINE_PATTERN,
  TMUX_METADATA_STATUS_PATTERNS,
  TMUX_TIMER_PATTERN,
  TMUX_UI_GLYPH_PATTERN,
} from './terminal/tmuxText'
import type { AgentType, Session, SessionStatus } from '../shared/types'

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

  constructor(
    sessionName = config.tmuxSession,
    {
      runTmux: runTmuxOverride,
      capturePaneContent: captureOverride,
      now,
    }: {
      runTmux?: TmuxRunner
      capturePaneContent?: CapturePane
      now?: NowFn
    } = {}
  ) {
    this.sessionName = sessionName
    this.runTmux = runTmuxOverride ?? runTmux
    this.capturePaneContent = captureOverride ?? capturePaneWithDimensions
    this.now = now ?? Date.now
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

  createWindow(projectPath: string, name?: string, command?: string): Session {
    this.ensureSession()

    const resolvedPath = resolveProjectPath(projectPath)
    if (!resolvedPath) {
      throw new Error('Project path is required')
    }

    if (!fs.existsSync(resolvedPath)) {
      throw new Error(`Project path does not exist: ${resolvedPath}`)
    }

    const existingNames = new Set(
      this.listWindowsForSession(this.sessionName, 'managed').map(
        (session) => session.name
      )
    )

    let baseName = name?.trim()
    if (baseName) {
      baseName = baseName.replace(/\s+/g, '-')
    } else {
      // Generate random name, retry if collision
      do {
        baseName = generateSessionName()
      } while (existingNames.has(baseName))
    }

    const finalCommand = command?.trim() || 'claude'
    const finalName = this.findAvailableName(baseName, existingNames)
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
        return {
          id: `${sessionName}:${window.id}`,
          name: displayName,
          tmuxWindow,
          projectPath: window.path,
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

  private findAvailableName(base: string, existing: Set<string>): string {
    if (!existing.has(base)) {
      return base
    }

    let suffix = 2
    while (existing.has(`${base}-${suffix}`)) {
      suffix += 1
    }

    return `${base}-${suffix}`
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

// Patterns that indicate the agent is actively working (thinking/processing)
const ACTIVE_WORKING_PATTERNS: RegExp[] = [
  // Codex: "(19s • esc to interrupt)" timer pattern
  /esc to interrupt/i,
  // Claude Code: "✳ Lollygagging… (ctrl+c to interrupt)" spinner pattern
  /ctrl\+c to interrupt/i,
]

// Detects if terminal content shows active working indicators
function detectsActiveWorking(content: string): boolean {
  const cleaned = stripAnsi(content)
  // Check entire content - status bars can be anywhere (top or bottom)
  return ACTIVE_WORKING_PATTERNS.some((pattern) => pattern.test(cleaned))
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

  // Check for active working indicators (timer with "esc to interrupt")
  // This catches cases where the only visible change is the timer incrementing
  const isActivelyWorking = detectsActiveWorking(content)

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

  // If content changed OR active working indicator detected, it's working
  return { status: contentChanged || isActivelyWorking ? 'working' : 'waiting', lastChanged }
}

function normalizeContent(content: string): string {
  const lines = stripAnsi(content).split('\n')
  return lines
    .slice(-20)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !TMUX_DECORATIVE_LINE_PATTERN.test(line))
    .filter(
      (line) =>
        !TMUX_METADATA_STATUS_PATTERNS.some((pattern) => pattern.test(line))
    )
    .map((line) => line.replace(TMUX_TIMER_PATTERN, '').trim())
    .map((line) => line.replace(TMUX_UI_GLYPH_PATTERN, ' ').trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function tokenizeNormalized(content: string): string[] {
  return content
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean)
}

function getTokenOverlapStats(left: string, right: string) {
  const leftTokens = tokenizeNormalized(left)
  const rightTokens = tokenizeNormalized(right)
  const leftSet = new Set(leftTokens)
  const rightSet = new Set(rightTokens)
  let overlap = 0
  for (const token of leftSet) {
    if (rightSet.has(token)) {
      overlap += 1
    }
  }
  const leftSize = leftSet.size
  const rightSize = rightSet.size
  const minSize = Math.min(leftSize, rightSize)
  const maxSize = Math.max(leftSize, rightSize)
  const ratioMin = minSize === 0 ? 1 : overlap / minSize
  const ratioMax = maxSize === 0 ? 1 : overlap / maxSize
  return { overlap, leftSize, rightSize, ratioMin, ratioMax }
}

function isMeaningfulResizeChange(oldNormalized: string, newNormalized: string) {
  if (oldNormalized === newNormalized) {
    return { changed: false, ...getTokenOverlapStats(oldNormalized, newNormalized) }
  }
  const stats = getTokenOverlapStats(oldNormalized, newNormalized)
  const maxSize = Math.max(stats.leftSize, stats.rightSize)
  if (maxSize < 8) {
    return { changed: true, ...stats }
  }
  const changed = stats.ratioMin < 0.9
  return { changed, ...stats }
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

function inferAgentType(command: string): AgentType | undefined {
  if (!command) {
    return undefined
  }

  // Extract the base command name, handling:
  // - Full paths: /usr/local/bin/claude -> claude
  // - Package runners: npx codex, bunx claude -> codex, claude
  // - Flags: claude --help, codex --search -> claude, codex
  // - Quoted commands: "codex --search" -> codex
  const normalized = command.toLowerCase().trim().replace(/^["']|["']$/g, '')
  const parts = normalized.split(/\s+/)

  for (const part of parts) {
    // Skip common package runners/prefixes
    if (['npx', 'bunx', 'pnpm', 'yarn', 'env'].includes(part)) {
      continue
    }
    // Skip environment variable assignments (KEY=value)
    if (part.includes('=')) {
      continue
    }
    // Skip flags
    if (part.startsWith('-')) {
      continue
    }

    // Extract base name from path
    const baseName = part.split('/').pop() || part

    if (baseName === 'claude') {
      return 'claude'
    }
    if (baseName === 'codex') {
      return 'codex'
    }

    // Found a non-skippable command that isn't a known agent
    break
  }

  return undefined
}

// Permission prompt patterns for Claude Code and Codex CLI
const PERMISSION_PATTERNS: RegExp[] = [
  // Claude Code: numbered options like "❯ 1. Yes" or "1. Yes"
  /[❯>]?\s*1\.\s*(Yes|Allow)/i,
  // Claude Code: "Do you want to proceed?" or similar
  /do you want to (proceed|continue|allow|run)\?/i,
  // Claude Code: "Yes, and don't ask again" style options
  /yes,?\s*(and\s+)?(don't|do not|never)\s+ask\s+again/i,
  // Claude Code: permission prompt with session option
  /yes,?\s*(for|during)\s+this\s+session/i,
  // Codex CLI: approve/reject inline prompts
  /\[(approve|accept)\].*\[(reject|deny)\]/i,
  // Codex CLI: "approve this" prompts
  /approve\s+this\s+(command|change|action)/i,
  // Generic: "allow" / "deny" choice pattern
  /\[allow\].*\[deny\]/i,
  // Generic: "y/n" or "[Y/n]" prompts at end of question
  /\?\s*\[?[yY](es)?\/[nN](o)?\]?\s*$/m,
]

// Detects if terminal content shows a permission prompt
export function detectsPermissionPrompt(content: string): boolean {
  const cleaned = stripAnsi(content)
  // Focus on the last ~30 lines where prompts typically appear
  // First strip trailing blank lines (terminal buffer often has many)
  const lines = cleaned.split('\n')
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') {
    lines.pop()
  }
  const recentContent = lines.slice(-30).join('\n')

  return PERMISSION_PATTERNS.some((pattern) => pattern.test(recentContent))
}
