/// <reference lib="webworker" />
/**
 * Worker for async session refresh.
 * Batches tmux calls and runs status inference off the main thread.
 */
import { inferAgentType } from './agentDetection'
import { normalizeProjectPath } from './logDiscovery'
import {
  extractRecentUserMessagesFromTmux,
  getTerminalScrollback,
} from './logMatcher'
import {
  detectsPermissionPrompt,
  isMeaningfulResizeChange,
  normalizeContent,
} from './statusInference'
import type { Session, SessionStatus, SessionSource } from '../shared/types'

// Format string for batched window listing
const BATCH_WINDOW_FORMAT =
  '#{session_name}\t#{window_id}\t#{window_name}\t#{pane_current_path}\t#{window_activity}\t#{window_creation_time}\t#{pane_start_command}\t#{pane_width}\t#{pane_height}'
const BATCH_WINDOW_FORMAT_FALLBACK =
  '#{session_name}\t#{window_id}\t#{window_name}\t#{pane_current_path}\t#{window_activity}\t#{window_activity}\t#{pane_current_command}\t#{pane_width}\t#{pane_height}'

const LAST_USER_MESSAGE_SCROLLBACK_LINES = 200

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

export type RefreshWorkerRequest =
  | {
      id: string
      kind: 'refresh'
      managedSession: string
      discoverPrefixes: string[]
    }
  | {
      id: string
      kind: 'last-user-message'
      tmuxWindow: string
      scrollbackLines?: number
    }

export type RefreshWorkerResponse =
  | {
      id: string
      kind: 'refresh'
      type: 'result'
      sessions: Session[]
    }
  | {
      id: string
      kind: 'last-user-message'
      type: 'result'
      message: string | null
    }
  | {
      id: string
      kind: 'error'
      type: 'error'
      error: string
    }

const ctx = self as DedicatedWorkerGlobalScope

ctx.onmessage = (event: MessageEvent<RefreshWorkerRequest>) => {
  const payload = event.data
  if (!payload || !payload.id) {
    return
  }

  try {
    if (payload.kind === 'last-user-message') {
      const scrollback = getTerminalScrollback(
        payload.tmuxWindow,
        payload.scrollbackLines ?? LAST_USER_MESSAGE_SCROLLBACK_LINES
      )
      const message = extractRecentUserMessagesFromTmux(scrollback, 1)[0] ?? null
      const response: RefreshWorkerResponse = {
        id: payload.id,
        kind: 'last-user-message',
        type: 'result',
        message,
      }
      ctx.postMessage(response)
      return
    }

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
      kind: 'refresh',
      type: 'result',
      sessions,
    }
    ctx.postMessage(response)
  } catch (error) {
    const response: RefreshWorkerResponse = {
      id: payload.id,
      kind: 'error',
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
      agentType: inferAgentType(window.command),
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

  // If content changed, it's working; otherwise waiting
  return { status: contentChanged ? 'working' : 'waiting', lastChanged }
}
