import fs from 'node:fs'
import path from 'node:path'
import { resolveProjectPath } from './paths'

const LOG_HEAD_BYTE_LIMIT = 64 * 1024
const LOG_HEAD_MAX_LIMIT = 1024 * 1024 // 1MB cap for progressive expansion
const WINDOWS_ABSOLUTE_PATH = /^[a-zA-Z]:[\\/]/

function isWindowsAbsolutePath(value: string): boolean {
  return (
    WINDOWS_ABSOLUTE_PATH.test(value) ||
    value.startsWith('\\\\') ||
    value.startsWith('//') ||
    value.startsWith('\\')
  )
}

function normalizeDriveLetter(value: string): string {
  if (/^[A-Z]:/.test(value)) {
    return value[0].toLowerCase() + value.slice(1)
  }
  return value
}

function stripTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, '')
}

function normalizeWindowsPath(value: string): string {
  const normalized = path.win32.normalize(value)
  const withSlashes = normalized.replace(/\\/g, '/')
  return stripTrailingSlashes(normalizeDriveLetter(withSlashes))
}

function normalizePosixPath(value: string): string {
  return stripTrailingSlashes(value.replace(/\\/g, '/'))
}

function getHomeDir(): string {
  return process.env.HOME || process.env.USERPROFILE || ''
}

function getClaudeConfigDir(): string {
  const override = process.env.CLAUDE_CONFIG_DIR
  if (override && override.trim()) {
    const normalized = normalizeProjectPath(override)
    return normalized || override.trim()
  }
  return path.join(getHomeDir(), '.claude')
}

function getCodexHomeDir(): string {
  const override = process.env.CODEX_HOME
  if (override && override.trim()) {
    const normalized = normalizeProjectPath(override)
    return normalized || override.trim()
  }
  return path.join(getHomeDir(), '.codex')
}

export function getLogSearchDirs(): string[] {
  return [
    path.join(getClaudeConfigDir(), 'projects'),
    path.join(getCodexHomeDir(), 'sessions'),
  ]
}

export function normalizeProjectPath(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return ''
  if (isWindowsAbsolutePath(trimmed)) {
    return normalizeWindowsPath(trimmed)
  }

  const resolved = resolveProjectPath(trimmed)
  if (!resolved) return ''
  if (isWindowsAbsolutePath(resolved)) {
    return normalizeWindowsPath(resolved)
  }
  return normalizePosixPath(resolved)
}

export function encodeProjectPath(projectPath: string): string {
  const normalized = normalizeProjectPath(projectPath)
  if (!normalized) return ''
  let encoded = normalized.replace(/[\\/]/g, '-')
  if (isWindowsAbsolutePath(normalized)) {
    encoded = encoded.replace(/:/g, '')
  }
  return encoded
}

export function scanAllLogDirs(): string[] {
  const paths: string[] = []
  const claudeRoot = path.join(getClaudeConfigDir(), 'projects')
  const codexRoot = path.join(getCodexHomeDir(), 'sessions')

  paths.push(...scanDirForJsonl(claudeRoot, 3))
  paths.push(...scanDirForJsonl(codexRoot, 4))

  return paths
}

export function extractSessionId(logPath: string): string | null {
  const entries = parseLogHeadEntries(logPath)

  for (const entry of entries) {
    const sessionId = getSessionIdFromEntry(entry)
    if (sessionId) return sessionId
  }

  return null
}

export function extractProjectPath(logPath: string): string | null {
  const entries = parseLogHeadEntries(logPath)

  for (const entry of entries) {
    const projectPath = getProjectPathFromEntry(entry)
    if (projectPath) {
      const normalized = normalizeProjectPath(projectPath)
      if (normalized) return normalized
    }
  }

  return null
}

export function getLogMtime(logPath: string): Date | null {
  const times = getLogTimes(logPath)
  return times?.mtime ?? null
}

export function getLogBirthtime(logPath: string): Date | null {
  const times = getLogTimes(logPath)
  return times?.birthtime ?? null
}

export function getLogTimes(
  logPath: string
): { mtime: Date; birthtime: Date; size: number } | null {
  try {
    const stats = fs.statSync(logPath)
    return {
      mtime: stats.mtime,
      birthtime: stats.birthtime ?? stats.mtime,
      size: stats.size,
    }
  } catch {
    return null
  }
}

export function inferAgentTypeFromPath(logPath: string): 'claude' | 'codex' | null {
  const normalized = path.resolve(logPath)
  const claudeRoot = path.resolve(getClaudeConfigDir())
  const codexRoot = path.resolve(getCodexHomeDir())

  if (normalized.startsWith(claudeRoot + path.sep)) return 'claude'
  if (normalized.startsWith(codexRoot + path.sep)) return 'codex'

  const fallback = logPath.replace(/\\/g, '/')
  if (fallback.includes('/.claude/')) return 'claude'
  if (fallback.includes('/.codex/')) return 'codex'
  return null
}

function scanDirForJsonl(root: string, maxDepth: number): string[] {
  if (!root) return []
  if (!fs.existsSync(root)) return []

  const results: string[] = []
  const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }]

  while (stack.length > 0) {
    const current = stack.pop()
    if (!current) continue
    const { dir, depth } = current

    if (depth > maxDepth) continue

    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }

    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue

      const fullPath = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === 'subagents') {
          continue
        }
        if (depth < maxDepth) {
          stack.push({ dir: fullPath, depth: depth + 1 })
        }
        continue
      }

      if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        results.push(fullPath)
      }
    }
  }

  return results
}

function readLogHead(logPath: string, byteLimit = LOG_HEAD_BYTE_LIMIT): string {
  try {
    const fd = fs.openSync(logPath, 'r')
    const buffer = Buffer.alloc(byteLimit)
    const bytes = fs.readSync(fd, buffer, 0, byteLimit, 0)
    fs.closeSync(fd)
    if (bytes <= 0) return ''
    return buffer.slice(0, bytes).toString('utf8')
  } catch {
    return ''
  }
}

function safeParseJson(line: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(line) as Record<string, unknown>
    if (!parsed || typeof parsed !== 'object') return null
    return parsed
  } catch {
    return null
  }
}

/**
 * Parse complete JSONL lines from head of log file with progressive expansion.
 * Starts with initial byte limit and expands up to max limit if lines are truncated.
 */
function parseLogHeadEntries(
  logPath: string,
  initialLimit = LOG_HEAD_BYTE_LIMIT,
  maxLimit = LOG_HEAD_MAX_LIMIT
): Array<Record<string, unknown>> {
  let byteLimit = initialLimit

  while (byteLimit <= maxLimit) {
    const head = readLogHead(logPath, byteLimit)
    if (!head) return []

    const lines = head.split('\n')
    const entries: Array<Record<string, unknown>> = []
    let hadTruncatedLine = false

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim()
      if (!line) continue

      const entry = safeParseJson(line)
      if (entry) {
        entries.push(entry)
      } else if (i === lines.length - 1 || (i === lines.length - 2 && !lines[lines.length - 1].trim())) {
        // Last non-empty line failed to parse - likely truncated
        hadTruncatedLine = true
      }
    }

    // If we found entries and no truncation issue, return what we have
    if (entries.length > 0 && !hadTruncatedLine) {
      return entries
    }

    // If we had a truncated line and haven't hit the cap, expand
    if (hadTruncatedLine && byteLimit < maxLimit) {
      byteLimit = Math.min(byteLimit * 4, maxLimit)
      continue
    }

    // Return whatever we have
    return entries
  }

  return []
}

function getSessionIdFromEntry(entry: Record<string, unknown>): string | null {
  if (typeof entry.sessionId === 'string' && entry.sessionId.trim()) {
    return entry.sessionId.trim()
  }
  if (typeof entry.session_id === 'string' && entry.session_id.trim()) {
    return entry.session_id.trim()
  }

  if (entry.payload && typeof entry.payload === 'object') {
    const payload = entry.payload as Record<string, unknown>
    const candidate =
      typeof payload.id === 'string'
        ? payload.id
        : typeof payload.sessionId === 'string'
          ? payload.sessionId
          : typeof payload.session_id === 'string'
            ? payload.session_id
            : null
    if (candidate && candidate.trim()) {
      return candidate.trim()
    }
  }

  return null
}

function getProjectPathFromEntry(entry: Record<string, unknown>): string | null {
  if (typeof entry.cwd === 'string' && entry.cwd.trim()) {
    return entry.cwd.trim()
  }

  if (entry.payload && typeof entry.payload === 'object') {
    const payload = entry.payload as Record<string, unknown>
    const candidate =
      typeof payload.cwd === 'string'
        ? payload.cwd
        : typeof payload.working_directory === 'string'
          ? payload.working_directory
          : null
    if (candidate && candidate.trim()) {
      return candidate.trim()
    }
  }

  return null
}

/**
 * Check if a Codex log file is from a subagent (not a main CLI session).
 * Subagents have payload.source as an object like { subagent: "review" },
 * while CLI sessions have payload.source as the string "cli".
 */
export function isCodexSubagent(logPath: string): boolean {
  const head = readLogHead(logPath)
  if (!head) return false

  // Check only the first line (session_meta)
  const firstLine = head.split('\n')[0]?.trim()
  if (!firstLine) return false

  const entry = safeParseJson(firstLine)
  if (!entry) return false

  // Only check session_meta entries
  if (entry.type !== 'session_meta') return false

  const payload = entry.payload as Record<string, unknown> | undefined
  if (!payload) return false

  // CLI sessions have source: "cli" (string)
  // Subagents have source: { subagent: "review" } (object)
  return typeof payload.source === 'object' && payload.source !== null
}

/**
 * Check if a Codex log file is from a headless exec session.
 * Exec sessions have payload.source === "exec", indicating they were
 * started via `codex exec` rather than the interactive CLI.
 */
export function isCodexExec(logPath: string): boolean {
  const head = readLogHead(logPath)
  if (!head) return false

  // Check only the first line (session_meta)
  const firstLine = head.split('\n')[0]?.trim()
  if (!firstLine) return false

  const entry = safeParseJson(firstLine)
  if (!entry) return false

  // Only check session_meta entries
  if (entry.type !== 'session_meta') return false

  const payload = entry.payload as Record<string, unknown> | undefined
  if (!payload) return false

  return payload.source === 'exec'
}
