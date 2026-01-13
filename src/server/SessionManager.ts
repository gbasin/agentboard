import path from 'node:path'
import fs from 'node:fs'
import { config } from './config'
import { generateSessionName } from './nameGenerator'
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
type CapturePane = (tmuxWindow: string) => string | null
type NowFn = () => number

// Cache of pane content and last-changed timestamp for change detection
interface PaneCache {
  content: string
  lastChanged: number
}
const paneContentCache = new Map<string, PaneCache>()

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
    this.capturePaneContent = captureOverride ?? capturePaneContent
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

    this.runTmux([
      'new-window',
      '-t',
      `${this.sessionName}:${nextIndex}`,
      '-n',
      finalName,
      '-c',
      resolvedPath,
      finalCommand,
    ])

    const sessions = this.listWindowsForSession(this.sessionName, 'managed')
    const created = sessions.find((session) => session.name === finalName)

    if (!created) {
      throw new Error('Failed to create tmux window')
    }

    return created
  }

  killWindow(tmuxWindow: string): void {
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
    const allSessions = this.listSessions()

    // If no prefixes configured, discover all sessions except the managed one
    const sessions = config.discoverPrefixes.length === 0
      ? allSessions.filter((sessionName) => sessionName !== this.sessionName)
      : allSessions.filter((sessionName) =>
          config.discoverPrefixes.some((prefix) => sessionName.startsWith(prefix))
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
    const output = this.runTmux([
      'list-windows',
      '-t',
      sessionName,
      '-F',
      '#{window_id}\t#{window_name}\t#{pane_current_path}\t#{window_activity}\t#{window_creation_time}\t#{pane_start_command}',
    ])

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
        return {
          id: `${sessionName}:${window.id}`,
          name: window.name,
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

const homeDir = process.env.HOME || process.env.USERPROFILE || ''

function resolveProjectPath(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) {
    return ''
  }

  if (
    homeDir &&
    (trimmed === '~' || trimmed.startsWith('~/') || trimmed.startsWith('~\\'))
  ) {
    const remainder = trimmed === '~' ? '' : trimmed.slice(2)
    return path.resolve(path.join(homeDir, remainder))
  }

  return path.resolve(trimmed)
}

interface StatusResult {
  status: SessionStatus
  lastChanged: number
}

function inferStatus(
  tmuxWindow: string,
  capture: CapturePane = capturePaneContent,
  now: NowFn = Date.now
): StatusResult {
  const content = capture(tmuxWindow)
  if (content === null) {
    return { status: 'unknown', lastChanged: now() }
  }

  // Check for permission prompts first (takes priority over working/waiting)
  if (detectsPermissionPrompt(content)) {
    const cached = paneContentCache.get(tmuxWindow)
    return { status: 'permission', lastChanged: cached?.lastChanged ?? now() }
  }

  const cached = paneContentCache.get(tmuxWindow)
  const contentChanged = cached === undefined || cached.content !== content
  const lastChanged = contentChanged ? now() : (cached?.lastChanged ?? now())

  paneContentCache.set(tmuxWindow, { content, lastChanged })

  // If no previous content, assume waiting (just started monitoring)
  if (cached === undefined) {
    return { status: 'waiting', lastChanged }
  }

  // If content changed, it's working
  return { status: contentChanged ? 'working' : 'waiting', lastChanged }
}

function capturePaneContent(tmuxWindow: string): string | null {
  try {
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
    const lines = result.stdout.toString().split('\n')
    return lines.slice(-30).join('\n')
  } catch {
    return null
  }
}

function inferAgentType(command: string): AgentType | undefined {
  if (!command) {
    return undefined
  }

  const normalized = command.toLowerCase()

  if (normalized === 'claude' || normalized.startsWith('claude ')) {
    return 'claude'
  }

  if (normalized === 'codex' || normalized.startsWith('codex ')) {
    return 'codex'
  }

  return undefined
}

// Strip ANSI escape codes from terminal output
function stripAnsi(text: string): string {
  // Matches ANSI escape sequences: CSI sequences, OSC sequences, and simple escapes
  return text.replace(
    // eslint-disable-next-line no-control-regex -- need to match ANSI escapes
    /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g,
    ''
  )
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
