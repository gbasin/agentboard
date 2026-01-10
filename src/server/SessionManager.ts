import path from 'node:path'
import fs from 'node:fs'
import { config } from './config'
import type { Session } from '../shared/types'

interface WindowInfo {
  id: string
  name: string
  path: string
  activity: number
  command: string
}

export class SessionManager {
  private sessionName: string

  constructor(sessionName = config.tmuxSession) {
    this.sessionName = sessionName
  }

  ensureSession(): void {
    try {
      runTmux(['has-session', '-t', this.sessionName])
    } catch {
      runTmux(['new-session', '-d', '-s', this.sessionName])
    }
  }

  listWindows(): Session[] {
    this.ensureSession()

    const managed = this.listWindowsForSession(this.sessionName, 'managed')
    const externals = this.listExternalWindows()

    return [...managed, ...externals]
  }

  createWindow(projectPath: string, name?: string): Session {
    this.ensureSession()

    if (!fs.existsSync(projectPath)) {
      throw new Error(`Project path does not exist: ${projectPath}`)
    }

    const baseName = (name || path.basename(projectPath)).trim()
    if (!baseName) {
      throw new Error('Session name is required')
    }

    const safeBase = baseName.replace(/\s+/g, '-')
    const existingNames = new Set(
      this.listWindowsForSession(this.sessionName, 'managed').map(
        (session) => session.name
      )
    )

    const finalName = this.findAvailableName(safeBase, existingNames)
    runTmux([
      'new-window',
      '-t',
      this.sessionName,
      '-n',
      finalName,
      '-c',
      projectPath,
      'claude',
    ])

    const sessions = this.listWindowsForSession(this.sessionName, 'managed')
    const created = sessions.find((session) => session.name === finalName)

    if (!created) {
      throw new Error('Failed to create tmux window')
    }

    return created
  }

  killWindow(tmuxWindow: string): void {
    runTmux(['kill-window', '-t', tmuxWindow])
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

    runTmux(['rename-window', '-t', tmuxWindow, trimmed])
  }

  private listExternalWindows(): Session[] {
    if (config.discoverPrefixes.length === 0) {
      return []
    }

    const sessions = this.listSessions().filter((sessionName) =>
      config.discoverPrefixes.some((prefix) => sessionName.startsWith(prefix))
    )

    return sessions.flatMap((sessionName) =>
      this.listWindowsForSession(sessionName, 'external')
    )
  }

  private listSessions(): string[] {
    try {
      const output = runTmux(['list-sessions', '-F', '#{session_name}'])
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
    const output = runTmux([
      'list-windows',
      '-t',
      sessionName,
      '-F',
      '#{window_id}\t#{window_name}\t#{pane_current_path}\t#{window_activity}\t#{pane_current_command}',
    ])

    return output
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => parseWindow(line))
      .map((window) => ({
        id: `${sessionName}:${window.id}`,
        name: window.name,
        tmuxWindow: `${sessionName}:${window.id}`,
        projectPath: window.path,
        status: 'unknown',
        lastActivity: new Date(
          window.activity ? window.activity * 1000 : Date.now()
        ).toISOString(),
        source,
        command: window.command || undefined,
      }))
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

  private resolveSessionName(tmuxWindow: string): string {
    const colonIndex = tmuxWindow.indexOf(':')
    if (colonIndex > 0) {
      return tmuxWindow.slice(0, colonIndex)
    }

    const resolved = runTmux([
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
  const [id, name, panePath, activityRaw, command] = line.split('\t')
  const activity = Number.parseInt(activityRaw || '0', 10)

  return {
    id: id || '',
    name: name || 'unknown',
    path: panePath || '',
    activity: Number.isNaN(activity) ? 0 : activity,
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
