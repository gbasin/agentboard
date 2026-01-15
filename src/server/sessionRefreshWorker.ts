/// <reference lib="webworker" />
/**
 * Worker for async session refresh.
 * Batches tmux calls and runs status inference off the main thread.
 */
import { normalizeProjectPath } from './logDiscovery'
import {
  stripAnsi,
  TMUX_DECORATIVE_LINE_PATTERN,
  TMUX_METADATA_STATUS_PATTERNS,
  TMUX_TIMER_PATTERN,
  TMUX_UI_GLYPH_PATTERN,
} from './terminal/tmuxText'
import type { Session, SessionStatus, SessionSource } from '../shared/types'

// Format string for batched window listing
const BATCH_WINDOW_FORMAT =
  '#{session_name}\t#{window_id}\t#{window_name}\t#{pane_current_path}\t#{window_activity}\t#{window_creation_time}\t#{pane_start_command}\t#{pane_width}\t#{pane_height}'
const BATCH_WINDOW_FORMAT_FALLBACK =
  '#{session_name}\t#{window_id}\t#{window_name}\t#{pane_current_path}\t#{window_activity}\t#{window_activity}\t#{pane_current_command}\t#{pane_width}\t#{pane_height}'

interface WindowData {
  sessionName: string
  windowId: string
  windowName: string
  path: string
  activity: number
  creation: number
  command: string
  width: number
  height: number
}

interface PaneCache {
  content: string
  lastChanged: number
  width: number
  height: number
}

// Cache persists across worker invocations
const paneContentCache = new Map<string, PaneCache>()

export interface RefreshWorkerRequest {
  id: string
  managedSession: string
  discoverPrefixes: string[]
}

export interface RefreshWorkerResponse {
  id: string
  type: 'result' | 'error'
  sessions?: Session[]
  error?: string
}

const ctx = self as DedicatedWorkerGlobalScope

ctx.onmessage = (event: MessageEvent<RefreshWorkerRequest>) => {
  const payload = event.data
  if (!payload || !payload.id) {
    return
  }

  try {
    const sessions = listAllWindows(payload.managedSession, payload.discoverPrefixes)

    // Clean up cache entries for windows that no longer exist
    const currentWindows = new Set(sessions.map((s) => s.tmuxWindow))
    for (const key of paneContentCache.keys()) {
      if (!currentWindows.has(key)) {
        paneContentCache.delete(key)
      }
    }

    const response: RefreshWorkerResponse = {
      id: payload.id,
      type: 'result',
      sessions,
    }
    ctx.postMessage(response)
  } catch (error) {
    const response: RefreshWorkerResponse = {
      id: payload.id,
      type: 'error',
      error: error instanceof Error ? error.message : String(error),
    }
    ctx.postMessage(response)
  }
}

function runTmux(args: string[]): string {
  const result = Bun.spawnSync(['tmux', ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (result.exitCode !== 0) {
    throw new Error(`tmux ${args[0]} failed: ${result.stderr.toString()}`)
  }
  return result.stdout.toString()
}

function isTmuxFormatError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const msg = error.message.toLowerCase()
  return msg.includes('format') || msg.includes('unknown variable')
}

function listAllWindowData(): WindowData[] {
  let output: string
  try {
    output = runTmux(['list-windows', '-a', '-F', BATCH_WINDOW_FORMAT])
  } catch (error) {
    if (!isTmuxFormatError(error)) {
      throw error
    }
    output = runTmux(['list-windows', '-a', '-F', BATCH_WINDOW_FORMAT_FALLBACK])
  }

  return output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split('\t')
      return {
        sessionName: parts[0] ?? '',
        windowId: parts[1] ?? '',
        windowName: parts[2] ?? '',
        path: parts[3] ?? '',
        activity: Number.parseInt(parts[4] ?? '0', 10) || 0,
        creation: Number.parseInt(parts[5] ?? '0', 10) || 0,
        command: parts[6] ?? '',
        width: Number.parseInt(parts[7] ?? '80', 10) || 80,
        height: Number.parseInt(parts[8] ?? '24', 10) || 24,
      }
    })
}

function capturePane(tmuxWindow: string): string | null {
  try {
    const result = Bun.spawnSync(
      ['tmux', 'capture-pane', '-t', tmuxWindow, '-p', '-J'],
      { stdout: 'pipe', stderr: 'pipe' }
    )
    if (result.exitCode !== 0) {
      return null
    }
    const lines = result.stdout.toString().split('\n')
    while (lines.length > 0 && lines[lines.length - 1]?.trim() === '') {
      lines.pop()
    }
    return lines.slice(-30).join('\n')
  } catch {
    return null
  }
}

function listAllWindows(managedSession: string, discoverPrefixes: string[]): Session[] {
  const allWindows = listAllWindowData()
  const now = Date.now()
  const wsPrefix = `${managedSession}-ws-`

  const sessions: Session[] = []

  for (const window of allWindows) {
    const { sessionName } = window

    // Skip websocket proxy sessions
    if (sessionName.startsWith(wsPrefix)) {
      continue
    }

    // Determine source
    let source: SessionSource
    if (sessionName === managedSession) {
      source = 'managed'
    } else if (discoverPrefixes.length === 0) {
      source = 'external'
    } else if (discoverPrefixes.some((prefix) => sessionName.startsWith(prefix))) {
      source = 'external'
    } else {
      continue // Skip sessions that don't match any prefix
    }

    const tmuxWindow = `${sessionName}:${window.windowId}`
    const content = capturePane(tmuxWindow)
    const { status, lastChanged } = inferStatus(
      tmuxWindow,
      content,
      window.width,
      window.height,
      now
    )

    const creationTimestamp = window.creation ? window.creation * 1000 : now
    const displayName = source === 'external' ? sessionName : window.windowName
    const normalizedPath = normalizeProjectPath(window.path)

    sessions.push({
      id: tmuxWindow,
      name: displayName,
      tmuxWindow,
      projectPath: normalizedPath || window.path,
      status,
      lastActivity: new Date(lastChanged).toISOString(),
      createdAt: new Date(creationTimestamp).toISOString(),
      source,
      command: window.command || undefined,
    })
  }

  return sessions
}

interface StatusResult {
  status: SessionStatus
  lastChanged: number
}

// Status inference logic (copied from SessionManager to avoid import issues in worker)
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

const ACTIVE_WORKING_PATTERNS: RegExp[] = [
  /esc to interrupt/i,
  /ctrl\+c to interrupt/i,
]

function detectsPermissionPrompt(content: string): boolean {
  const cleaned = stripAnsi(content)
  // Focus on the last ~30 lines where prompts typically appear
  // First strip trailing blank lines (terminal buffer often has many)
  const lines = cleaned.split('\n')
  while (lines.length > 0 && lines[lines.length - 1]?.trim() === '') {
    lines.pop()
  }
  const recentContent = lines.slice(-30).join('\n')
  return PERMISSION_PATTERNS.some((pattern) => pattern.test(recentContent))
}

function detectsActiveWorking(content: string): boolean {
  const cleaned = stripAnsi(content)
  return ACTIVE_WORKING_PATTERNS.some((pattern) => pattern.test(cleaned))
}

// Normalize content for comparison (matches SessionManager exactly)
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

// Matches SessionManager.inferStatus exactly
function inferStatus(
  tmuxWindow: string,
  content: string | null,
  width: number,
  height: number,
  now: number
): StatusResult {
  if (content === null) {
    return { status: 'unknown', lastChanged: now }
  }

  // Check for permission prompts first (takes priority over working/waiting)
  if (detectsPermissionPrompt(content)) {
    const cached = paneContentCache.get(tmuxWindow)
    return { status: 'permission', lastChanged: cached?.lastChanged ?? now }
  }

  // Check for active working indicators (timer with "esc to interrupt")
  // This catches cases where the only visible change is the timer incrementing
  const isActivelyWorking = detectsActiveWorking(content)

  const cached = paneContentCache.get(tmuxWindow)
  let contentChanged = false
  if (cached !== undefined) {
    const dimensionsChanged = cached.width !== width || cached.height !== height
    if (dimensionsChanged) {
      const oldNormalized = normalizeContent(cached.content)
      const newNormalized = normalizeContent(content)
      const resizeStats = isMeaningfulResizeChange(oldNormalized, newNormalized)
      contentChanged = resizeStats.changed
    } else {
      contentChanged = cached.content !== content
    }
  }
  const lastChanged = contentChanged ? now : (cached?.lastChanged ?? now)

  paneContentCache.set(tmuxWindow, { content, width, height, lastChanged })

  // If no previous content, assume waiting (just started monitoring)
  if (cached === undefined) {
    return { status: 'waiting', lastChanged }
  }

  // If content changed OR active working indicator detected, it's working
  return { status: contentChanged || isActivelyWorking ? 'working' : 'waiting', lastChanged }
}
