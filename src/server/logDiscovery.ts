import fs from 'node:fs'
import path from 'node:path'
import type { AgentType } from '../shared/types'
import { resolveProjectPath } from './paths'
import { getDevinLogOutDir } from './devinSync'

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

function getPiHomeDir(): string {
  const override = process.env.PI_HOME
  if (override && override.trim()) {
    const normalized = normalizeProjectPath(override)
    return normalized || override.trim()
  }
  return path.join(getHomeDir(), '.pi')
}

function getGrokHomeDir(): string {
  const override = process.env.GROK_HOME
  if (override && override.trim()) {
    const normalized = normalizeProjectPath(override)
    return normalized || override.trim()
  }
  return path.join(getHomeDir(), '.grok')
}

// oh-my-pi (omp) resolves its agent dir as:
//   PI_CODING_AGENT_DIR (absolute override)
//   else ~/<PI_CONFIG_DIR || ".omp">/agent
// Sessions live under <agentDir>/sessions, except on macOS/Linux when
// $XDG_DATA_HOME/omp exists — then they move to $XDG_DATA_HOME/omp/sessions
// (mirrors DirResolver in @oh-my-pi/pi-utils).
function getOmpAgentDir(): string {
  const agentOverride = process.env.PI_CODING_AGENT_DIR
  if (agentOverride && agentOverride.trim()) {
    const normalized = normalizeProjectPath(agentOverride)
    return normalized || agentOverride.trim()
  }
  const configDirName = (process.env.PI_CONFIG_DIR || '').trim() || '.omp'
  return path.join(getHomeDir(), configDirName, 'agent')
}

function getOmpSessionsDir(): string {
  // The XDG redirect only applies to the default agent dir, not overrides.
  if (!process.env.PI_CODING_AGENT_DIR?.trim()) {
    const xdgData = process.env.XDG_DATA_HOME?.trim()
    if (xdgData) {
      const xdgOmp = path.join(xdgData, 'omp')
      if (fs.existsSync(xdgOmp)) {
        return path.join(xdgOmp, 'sessions')
      }
    }
  }
  return path.join(getOmpAgentDir(), 'sessions')
}

export function getLogSearchDirs(): string[] {
  return [
    path.join(getClaudeConfigDir(), 'projects'),
    path.join(getCodexHomeDir(), 'sessions'),
    path.join(getPiHomeDir(), 'agent', 'sessions'),
    // Devin CLI sessions are mirrored from sessions.db into this directory
    // by devinSync (Devin stores history in SQLite, not JSONL files).
    getDevinLogOutDir(),
    path.join(getGrokHomeDir(), 'sessions'),
    getOmpSessionsDir(),
  ]
}

export function getLogWatchParentDirs(): string[] {
  return [
    getClaudeConfigDir(),
    getCodexHomeDir(),
    path.join(getPiHomeDir(), 'agent'),
    path.dirname(getDevinLogOutDir()),
    getGrokHomeDir(),
    path.dirname(getOmpSessionsDir()),
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
  const piRoot = path.join(getPiHomeDir(), 'agent', 'sessions')
  const devinRoot = getDevinLogOutDir()
  const grokRoot = path.join(getGrokHomeDir(), 'sessions')
  const ompRoot = getOmpSessionsDir()

  paths.push(...scanDirForJsonl(claudeRoot, 3))
  paths.push(...scanDirForJsonl(codexRoot, 4))
  paths.push(...scanDirForJsonl(piRoot, 4))
  paths.push(...scanDirForJsonl(devinRoot, 2))
  // Grok Build writes sessions/<encoded-cwd>/<session-id>/chat_history.jsonl
  // alongside sibling telemetry files (events.jsonl, updates.jsonl, ...) that
  // are not transcripts, so only the transcript file is collected.
  paths.push(...scanDirForJsonl(grokRoot, 3, 'chat_history.jsonl'))
  paths.push(...scanDirForJsonl(ompRoot, 4))

  return paths
}

/**
 * Grok transcripts live at sessions/<encoded-cwd>/<session-id>/chat_history.jsonl
 * and carry no session-id field, so both are derived from the path.
 */
function grokSessionIdFromPath(logPath: string): string | null {
  const sessionDir = path.basename(path.dirname(logPath))
  return sessionDir || null
}

function grokProjectPathFromPath(logPath: string): string | null {
  const encodedCwd = path.basename(path.dirname(path.dirname(logPath)))
  if (!encodedCwd) return null
  try {
    const decoded = decodeURIComponent(encodedCwd)
    return normalizeProjectPath(decoded) || null
  } catch {
    return null
  }
}

export function extractSessionId(logPath: string): string | null {
  if (inferAgentTypeFromPath(logPath) === 'grok') {
    return grokSessionIdFromPath(logPath)
  }

  const entries = parseLogHeadEntries(logPath)

  for (const entry of entries) {
    const sessionId = getSessionIdFromEntry(entry)
    if (sessionId) return sessionId
  }

  return null
}

export function extractSlug(logPath: string): string | null {
  const entries = parseLogHeadEntries(logPath)

  for (const entry of entries) {
    if (typeof entry.slug === 'string' && entry.slug.trim()) {
      return entry.slug.trim()
    }
  }

  return null
}

export function extractProjectPath(logPath: string): string | null {
  if (inferAgentTypeFromPath(logPath) === 'grok') {
    return grokProjectPathFromPath(logPath)
  }

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

export function inferAgentTypeFromPath(logPath: string): AgentType | null {
  const normalized = path.resolve(logPath)
  const claudeRoot = path.resolve(getClaudeConfigDir())
  const codexRoot = path.resolve(getCodexHomeDir())
  const piRoot = path.resolve(getPiHomeDir())
  const devinRoot = path.resolve(getDevinLogOutDir())
  const grokRoot = path.resolve(getGrokHomeDir())
  const ompRoot = path.resolve(getOmpAgentDir())
  const ompSessionsRoot = path.resolve(getOmpSessionsDir())

  // omp before pi: PI_CODING_AGENT_DIR may point anywhere, including under .pi
  // Check the sessions root too — the XDG redirect moves it outside the agent dir.
  if (
    normalized.startsWith(ompSessionsRoot + path.sep) ||
    normalized.startsWith(ompRoot + path.sep)
  ) {
    return 'omp'
  }
  if (normalized.startsWith(claudeRoot + path.sep)) return 'claude'
  if (normalized.startsWith(codexRoot + path.sep)) return 'codex'
  if (normalized.startsWith(piRoot + path.sep)) return 'pi'
  if (normalized.startsWith(devinRoot + path.sep)) return 'devin'
  if (normalized.startsWith(grokRoot + path.sep)) return 'grok'

  const fallback = logPath.replace(/\\/g, '/')
  if (fallback.includes('/.omp/')) return 'omp'
  if (fallback.includes('/.claude/')) return 'claude'
  if (fallback.includes('/.codex/')) return 'codex'
  if (fallback.includes('/.pi/')) return 'pi'
  if (fallback.includes('/devin-sessions/')) return 'devin'
  if (fallback.includes('/.grok/')) return 'grok'
  return null
}

function scanDirForJsonl(root: string, maxDepth: number, fileName?: string): string[] {
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

      if (
        entry.isFile() &&
        entry.name.endsWith('.jsonl') &&
        (!fileName || entry.name === fileName)
      ) {
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
  // Pi uses top-level "id" field with type: "session"
  if (entry.type === 'session' && typeof entry.id === 'string' && entry.id.trim()) {
    return entry.id.trim()
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
 * Extract the subagent linkage from a Codex rollout's session_meta first line.
 * Returns null unless payload.source is an object — forked/resumed sessions
 * carry forked_from_id too and must not be indexed as subagents.
 * ownId is payload.id (what sessions register under); parentId is the
 * spawning thread id (parent_thread_id / thread_spawn.parent_thread_id).
 */
export function extractCodexSubagentLink(
  logPath: string
): { ownId: string; parentId: string | null } | null {
  const head = readLogHead(logPath)
  if (!head) return null
  const firstLine = head.split('\n')[0]?.trim()
  if (!firstLine) return null
  const entry = safeParseJson(firstLine)
  if (!entry || entry.type !== 'session_meta') return null
  const payload = entry.payload as Record<string, unknown> | undefined
  if (!payload) return null
  if (typeof payload.source !== 'object' || payload.source === null) {
    return null
  }
  const ownId = typeof payload.id === 'string' ? payload.id : null
  if (!ownId) return null
  const source = payload.source as Record<string, unknown>
  const spawn =
    typeof source.subagent === 'object' && source.subagent !== null
      ? (source.subagent as Record<string, unknown>).thread_spawn
      : undefined
  const spawnParent =
    typeof spawn === 'object' && spawn !== null
      ? (spawn as Record<string, unknown>).parent_thread_id
      : undefined
  const parentId =
    (typeof payload.parent_thread_id === 'string'
      ? payload.parent_thread_id
      : undefined) ??
    (typeof spawnParent === 'string' ? spawnParent : undefined) ??
    (typeof payload.forked_from_id === 'string'
      ? payload.forked_from_id
      : undefined) ??
    null
  return { ownId, parentId }
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

/**
 * Check if a pi/omp log file is from a subagent (task) session.
 * Subagent sessions get a `session_init` entry (system prompt, task, tools)
 * appended by the task executor at session start; interactive and print-mode
 * sessions never write one.
 */
export function isPiSubagent(logPath: string): boolean {
  const entries = parseLogHeadEntries(logPath)
  return entries.some((entry) => entry.type === 'session_init')
}
