import fs from 'node:fs'
import path from 'node:path'
import { resolveProjectPath } from './paths'

const LOG_HEAD_BYTE_LIMIT = 64 * 1024

function getHomeDir(): string {
  return process.env.HOME || process.env.USERPROFILE || ''
}

function getClaudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || path.join(getHomeDir(), '.claude')
}

function getCodexHomeDir(): string {
  return process.env.CODEX_HOME || path.join(getHomeDir(), '.codex')
}

export function getLogSearchDirs(): string[] {
  return [
    path.join(getClaudeConfigDir(), 'projects'),
    path.join(getCodexHomeDir(), 'sessions'),
  ]
}

export function encodeProjectPath(projectPath: string): string {
  const resolved = resolveProjectPath(projectPath)
  if (!resolved) return ''
  return resolved.replace(/[\\/]/g, '-')
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
  const head = readLogHead(logPath)
  if (!head) return null

  for (const line of head.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const entry = safeParseJson(trimmed)
    if (!entry) continue
    const sessionId = getSessionIdFromEntry(entry)
    if (sessionId) return sessionId
  }

  return null
}

export function extractProjectPath(logPath: string): string | null {
  const head = readLogHead(logPath)
  if (!head) return null

  for (const line of head.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const entry = safeParseJson(trimmed)
    if (!entry) continue
    const projectPath = getProjectPathFromEntry(entry)
    if (projectPath) return projectPath
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
): { mtime: Date; birthtime: Date } | null {
  try {
    const stats = fs.statSync(logPath)
    return {
      mtime: stats.mtime,
      birthtime: stats.birthtime ?? stats.mtime,
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
