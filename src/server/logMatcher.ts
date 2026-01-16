import fs from 'node:fs'
import { performance } from 'node:perf_hooks'
import type { AgentType, Session } from '../shared/types'
import {
  extractProjectPath,
  inferAgentTypeFromPath,
  isCodexSubagent,
  normalizeProjectPath,
} from './logDiscovery'
import {
  cleanTmuxLine,
  isMetadataLine,
  stripAnsi,
  TMUX_METADATA_STATUS_PATTERNS,
  TMUX_PROMPT_PREFIX,
  TMUX_UI_GLYPH_PATTERN,
} from './terminal/tmuxText'

export type LogTextMode = 'all' | 'assistant' | 'user' | 'assistant-user'

export interface LogReadOptions {
  lineLimit: number
  byteLimit: number
  maxByteLimit?: number
}

export interface LogTextOptionsInput {
  mode?: LogTextMode
  logRead?: Partial<LogReadOptions>
}

export interface ExactMatchProfiler {
  windowMatchRuns: number
  windowMatchMs: number
  tmuxCaptures: number
  tmuxCaptureMs: number
  messageExtractRuns: number
  messageExtractMs: number
  tailReads: number
  tailReadMs: number
  rgListRuns: number
  rgListMs: number
  rgJsonRuns: number
  rgJsonMs: number
  tailScoreRuns: number
  tailScoreMs: number
  rgScoreRuns: number
  rgScoreMs: number
  tieBreakRgRuns: number
  tieBreakRgMs: number
}

export function createExactMatchProfiler(): ExactMatchProfiler {
  return {
    windowMatchRuns: 0,
    windowMatchMs: 0,
    tmuxCaptures: 0,
    tmuxCaptureMs: 0,
    messageExtractRuns: 0,
    messageExtractMs: 0,
    tailReads: 0,
    tailReadMs: 0,
    rgListRuns: 0,
    rgListMs: 0,
    rgJsonRuns: 0,
    rgJsonMs: 0,
    tailScoreRuns: 0,
    tailScoreMs: 0,
    rgScoreRuns: 0,
    rgScoreMs: 0,
    tieBreakRgRuns: 0,
    tieBreakRgMs: 0,
  }
}

const DEFAULT_LOG_READ_OPTIONS: LogReadOptions = {
  lineLimit: 2000,
  byteLimit: 200 * 1024,
}

export const DEFAULT_SCROLLBACK_LINES = 10000
const DEFAULT_LOG_TEXT_MODE: LogTextMode = 'assistant-user'
const DEFAULT_LOG_TAIL_BYTES = 96 * 1024
const MIN_TAIL_MATCH_COUNT = 2
const MAX_RECENT_USER_MESSAGES = 25
const MAX_RECENT_TRACE_LINES = 12

// Minimum length for exact match search
const MIN_EXACT_MATCH_LENGTH = 5
const TRACE_EXCLUDE_PREFIXES = [
  /^explored\b/i,
  /^ran\b/i,
  /^search\b/i,
  /^read\b/i,
  /^use\b/i,
] as const
const TRACE_STATUS_TRAILER = /\s*\(([^)]*)\)\s*$/
const TRACE_STATUS_HINTS = [
  /esc to interrupt/i,
  /context left/i,
  /for shortcuts/i,
  /background terminal running/i,
  /\b\d+\s*(?:ms|s|m|h|d)\b/i,
] as const

/**
 * Escape special regex characters in a string.
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Convert a user message to a regex pattern that matches with flexible whitespace.
 * This handles cases where tmux and log files have different whitespace representations.
 * Also handles JSON-escaped quotes since logs store text in JSON format where " becomes \".
 */
function messageToFlexiblePattern(message: string): string {
  // Normalize to single spaces first
  const normalized = message.replace(/\s+/g, ' ').trim()
  // Escape regex special chars, then replace spaces with \s+ for flexible matching
  // Replace quotes with pattern matching: nothing, ", or \" (JSON-escaped)
  return escapeRegex(normalized)
    .replace(/ /g, '\\s+')
    .replace(/"/g, '(?:\\\\?")?')
}

/**
 * Search for logs containing an exact user message using ripgrep.
 * Searches both Claude and Codex log directories.
 * Uses flexible whitespace matching to handle differences between tmux and log content.
 * Returns list of matching log file paths.
 */
export interface ExactMatchSearchOptions {
  logPaths?: string[]
  tailBytes?: number
  rgThreads?: number
  profile?: ExactMatchProfiler
}

export interface ExactMessageSearchOptions extends ExactMatchSearchOptions {
  minLength?: number
}

const TOOL_NOTIFICATION_MARKERS = [
  '<task-notification>',
  '<task-id>',
  '<output-file>',
  '<status>',
  '<summary>',
  'read the output file to retrieve the result',
  // Codex system messages
  '<instructions>',
  '# agents.md instructions',
  '<environment_context>',
] as const

export function isToolNotificationText(text: string): boolean {
  const normalized = text.trim().toLowerCase()
  if (!normalized) return false
  if (normalized.startsWith('<task-notification>')) {
    return true
  }
  return TOOL_NOTIFICATION_MARKERS.some((marker) => normalized.includes(marker))
}

/**
 * Extract the action name from a <user_action> XML block.
 * Returns the action (e.g., "review") or null if not a user_action block.
 */
export function extractActionFromUserAction(text: string): string | null {
  const trimmed = text.trim()
  if (!trimmed.toLowerCase().startsWith('<user_action>')) {
    return null
  }
  const actionMatch = trimmed.match(/<action>\s*([^<]+)\s*<\/action>/i)
  if (actionMatch?.[1]) {
    return actionMatch[1].trim()
  }
  return null
}

function readLogTail(logPath: string, byteLimit = DEFAULT_LOG_TAIL_BYTES): string {
  if (byteLimit <= 0) return ''
  try {
    const stats = fs.statSync(logPath)
    const size = stats.size
    if (size <= 0) return ''
    const start = Math.max(0, size - byteLimit)
    if (start === 0) {
      return fs.readFileSync(logPath, 'utf8')
    }

    const fd = fs.openSync(logPath, 'r')
    try {
      const length = size - start
      const buffer = Buffer.alloc(length)
      fs.readSync(fd, buffer, 0, length, start)
      let text = buffer.toString('utf8')
      const firstNewline = text.indexOf('\n')
      if (firstNewline >= 0) {
        text = text.slice(firstNewline + 1)
      }
      return text
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return ''
  }
}

export function findLogsWithExactMessage(
  userMessage: string,
  logDirs: string | string[],
  {
    minLength = MIN_EXACT_MATCH_LENGTH,
    logPaths,
    tailBytes,
    rgThreads,
    profile,
  }: ExactMessageSearchOptions = {}
): string[] {
  if (!userMessage || userMessage.length < minLength) {
    return []
  }

  const candidatePaths = (logPaths ?? []).filter(Boolean)
  if (candidatePaths.length > 0) {
    return findLogsWithExactMessageInPaths(userMessage, candidatePaths, {
      minLength,
      tailBytes,
      rgThreads,
      profile,
    })
  }

  const dirs = Array.isArray(logDirs) ? logDirs : [logDirs]
  const allMatches: string[] = []

  // Convert to regex pattern with flexible whitespace
  const pattern = messageToFlexiblePattern(userMessage)

  for (const logDir of dirs) {
    // Use **/*.jsonl to search nested directories (Codex uses YYYY/MM/DD structure)
    // Use -e for regex pattern instead of --fixed-strings
    const args = ['rg', '-l', '-e', pattern]
    if (rgThreads && rgThreads > 0) {
      args.push('--threads', String(rgThreads))
    }
    args.push('--glob', '**/*.jsonl', logDir)
    const start = performance.now()
    const result = Bun.spawnSync(args, { stdout: 'pipe', stderr: 'pipe' })
    if (profile) {
      profile.rgListRuns += 1
      profile.rgListMs += performance.now() - start
    }

    if (result.exitCode === 0) {
      const matches = result.stdout
        .toString()
        .trim()
        .split('\n')
        .filter(Boolean)
      allMatches.push(...matches)
    }
  }

  return Array.from(new Set(allMatches))
}

function findLogsWithExactMessageInPaths(
  userMessage: string,
  logPaths: string[],
  {
    minLength = MIN_EXACT_MATCH_LENGTH,
    tailBytes = DEFAULT_LOG_TAIL_BYTES,
    rgThreads,
    profile,
  }: ExactMessageSearchOptions = {}
): string[] {
  if (!userMessage || userMessage.length < minLength) {
    return []
  }
  const uniquePaths = Array.from(new Set(logPaths)).filter(Boolean)
  if (uniquePaths.length === 0) return []

  const pattern = messageToFlexiblePattern(userMessage)
  const regex = new RegExp(pattern, 'm')

  const tailMatches: string[] = []
  if (tailBytes > 0) {
    for (const logPath of uniquePaths) {
      const start = performance.now()
      const tail = readLogTail(logPath, tailBytes)
      if (profile) {
        profile.tailReads += 1
        profile.tailReadMs += performance.now() - start
      }
      if (!tail) continue
      if (regex.test(tail)) {
        tailMatches.push(logPath)
      }
    }
  }

  if (tailMatches.length === 1) {
    return tailMatches
  }

  const args = ['rg', '-l', '-e', pattern]
  if (rgThreads && rgThreads > 0) {
    args.push('--threads', String(rgThreads))
  }
  args.push(...uniquePaths)
  const start = performance.now()
  const result = Bun.spawnSync(args, { stdout: 'pipe', stderr: 'pipe' })
  if (profile) {
    profile.rgListRuns += 1
    profile.rgListMs += performance.now() - start
  }
  if (result.exitCode !== 0) {
    return tailMatches.length > 0 ? tailMatches : []
  }
  const matches = result.stdout
    .toString()
    .trim()
    .split('\n')
    .filter(Boolean)
  return matches.length > 0 ? matches : tailMatches
}

interface ConversationPair {
  user: string
  assistant: string
}

export function normalizeText(text: string): string {
  const cleaned = stripAnsi(text)
    // eslint-disable-next-line no-control-regex -- strip control characters
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .toLowerCase()
  return cleaned.replace(/\s+/g, ' ').trim()
}

function normalizePath(value: string): string {
  if (!value) return ''
  return normalizeProjectPath(value)
}

function isSameOrChildPath(left: string, right: string): boolean {
  if (!left || !right) return false
  if (left === right) return true
  return left.startsWith(`${right}/`) || right.startsWith(`${left}/`)
}

function intersectCandidates(base: string[], next: string[]): string[] {
  if (base.length === 0) return next
  const nextSet = new Set(next)
  return base.filter((item) => nextSet.has(item))
}

interface OrderedMatchScore {
  matchedCount: number
  matchedLength: number
  source?: 'tail' | 'rg'
}

function getRgMatchLines(
  pattern: string,
  logPath: string,
  search: ExactMatchSearchOptions = {}
): number[] {
  const args = ['rg', '--json', '-e', pattern]
  if (search.rgThreads && search.rgThreads > 0) {
    args.push('--threads', String(search.rgThreads))
  }
  args.push(logPath)
  const start = performance.now()
  const result = Bun.spawnSync(args, { stdout: 'pipe', stderr: 'pipe' })
  if (search.profile) {
    search.profile.rgJsonRuns += 1
    search.profile.rgJsonMs += performance.now() - start
  }
  if (result.exitCode !== 0 && result.exitCode !== 1) {
    return []
  }

  const lines: number[] = []
  const output = result.stdout.toString()
  for (const line of output.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let entry: unknown
    try {
      entry = JSON.parse(trimmed)
    } catch {
      continue
    }
    const record = entry as { type?: string; data?: { line_number?: number } }
    if (record.type !== 'match') continue
    const lineNumber = record.data?.line_number
    if (typeof lineNumber === 'number') {
      lines.push(lineNumber)
    }
  }

  return lines.sort((a, b) => a - b)
}

function scoreOrderedMessageMatchesInText(
  text: string,
  messages: string[]
): OrderedMatchScore {
  let matchedCount = 0
  let matchedLength = 0
  let cursor = 0

  for (const message of messages) {
    if (!message) continue
    const pattern = messageToFlexiblePattern(message)
    const regex = new RegExp(pattern, 'g')
    regex.lastIndex = cursor
    const match = regex.exec(text)
    if (!match) {
      continue
    }
    matchedCount += 1
    matchedLength += message.length
    cursor = match.index + match[0].length
  }

  return { matchedCount, matchedLength }
}

function scoreOrderedMessageMatchesWithRg(
  logPath: string,
  messages: string[],
  search: ExactMatchSearchOptions = {}
): OrderedMatchScore {
  let matchedCount = 0
  let matchedLength = 0
  let lastLine = 0

  for (const message of messages) {
    if (!message) continue
    const pattern = messageToFlexiblePattern(message)
    const matchLines = getRgMatchLines(pattern, logPath, search)
    if (matchLines.length === 0) {
      continue
    }
    const nextLine = matchLines.find((line) => line > lastLine)
    if (nextLine === undefined) {
      continue
    }
    matchedCount += 1
    matchedLength += message.length
    lastLine = nextLine
  }

  return { matchedCount, matchedLength }
}

function scoreOrderedMessageMatches(
  logPath: string,
  messages: string[],
  search: ExactMatchSearchOptions = {}
): OrderedMatchScore {
  const { tailBytes = DEFAULT_LOG_TAIL_BYTES, profile } = search
  if (messages.length === 0) {
    return { matchedCount: 0, matchedLength: 0, source: 'rg' }
  }

  if (tailBytes > 0) {
    const tailStart = performance.now()
    const tail = readLogTail(logPath, tailBytes)
    if (profile) {
      profile.tailReads += 1
      profile.tailReadMs += performance.now() - tailStart
    }
    if (tail) {
      const start = performance.now()
      const tailScore = scoreOrderedMessageMatchesInText(tail, messages)
      if (profile) {
        profile.tailScoreRuns += 1
        profile.tailScoreMs += performance.now() - start
      }
      const minTailMatches = Math.min(messages.length, MIN_TAIL_MATCH_COUNT)
      if (tailScore.matchedCount >= minTailMatches) {
        return { ...tailScore, source: 'tail' }
      }
    }
  }

  const rgStart = performance.now()
  const fullScore = scoreOrderedMessageMatchesWithRg(logPath, messages, search)
  if (profile) {
    profile.rgScoreRuns += 1
    profile.rgScoreMs += performance.now() - rgStart
  }
  return { ...fullScore, source: 'rg' }
}

function compareOrderedScores(a: OrderedMatchScore, b: OrderedMatchScore): number {
  if (a.matchedCount !== b.matchedCount) {
    return b.matchedCount - a.matchedCount
  }
  return b.matchedLength - a.matchedLength
}

const TMUX_PROMPT_DETECT_PREFIX = /^[\s>*#$]+/

function stripPromptPrefixForDetection(line: string): string {
  return stripAnsi(line).trim().replace(TMUX_PROMPT_DETECT_PREFIX, '')
}

function isClaudePromptLine(line: string): boolean {
  const cleaned = stripPromptPrefixForDetection(line)
  if (!cleaned) return false
  return cleaned.startsWith('❯')
}

function isCodexPromptLine(line: string): boolean {
  const cleaned = stripPromptPrefixForDetection(line)
  if (!cleaned) return false
  return cleaned.startsWith('›')
}

function isPromptLine(line: string): boolean {
  return isClaudePromptLine(line) || isCodexPromptLine(line)
}

function extractUserFromPrompt(line: string): string {
  let cleaned = stripAnsi(line).trim()
  cleaned = cleaned.replace(TMUX_PROMPT_PREFIX, '').trim()
  cleaned = cleaned.replace(/^›\s*/, '').trim()
  cleaned = cleaned.replace(/\s*↵\s*send\s*$/i, '').trim()
  cleaned = cleaned.replace(TMUX_UI_GLYPH_PATTERN, ' ')
  cleaned = cleaned.replace(/\s+/g, ' ').trim()
  return cleaned
}

function isCurrentInputField(rawLines: string[], promptIdx: number): boolean {
  for (let i = promptIdx + 1; i < Math.min(promptIdx + 4, rawLines.length); i++) {
    const line = rawLines[i]?.trim() ?? ''
    if (/\d+%\s*context\s*left/i.test(line)) return true
    if (/\[\d+%\]/.test(line)) return true
    if (/\?\s*for\s*shortcuts/i.test(line)) return true
  }
  return false
}

export function extractRecentUserMessagesFromTmux(
  content: string,
  maxMessages = MAX_RECENT_USER_MESSAGES
): string[] {
  const rawLines = stripAnsi(content).split('\n')
  while (rawLines.length > 0 && rawLines[rawLines.length - 1]?.trim() === '') {
    rawLines.pop()
  }

  const messages: string[] = []
  for (let i = rawLines.length - 1; i >= 0 && messages.length < maxMessages; i--) {
    const line = rawLines[i] ?? ''
    if (!isPromptLine(line)) continue
    if (isCurrentInputField(rawLines, i)) continue
    if (line.includes('↵')) continue
    const message = extractUserFromPrompt(line)
    if (!message) continue
    if (!messages.includes(message)) {
      messages.push(message)
    }
  }

  return messages
}

function stripTraceStatusSuffix(line: string): string {
  const match = line.match(TRACE_STATUS_TRAILER)
  if (!match) return line
  const inner = match[1] ?? ''
  if (!TRACE_STATUS_HINTS.some((pattern) => pattern.test(inner))) {
    return line
  }
  return line.slice(0, match.index).trim()
}

export function extractRecentTraceLinesFromTmux(
  content: string,
  maxLines = MAX_RECENT_TRACE_LINES
): string[] {
  const rawLines = stripAnsi(content).split('\n')
  while (rawLines.length > 0 && rawLines[rawLines.length - 1]?.trim() === '') {
    rawLines.pop()
  }

  const traces: string[] = []
  for (let i = rawLines.length - 1; i >= 0 && traces.length < maxLines; i--) {
    const raw = rawLines[i] ?? ''
    const trimmed = raw.trim()
    if (!trimmed.startsWith('•')) continue
    let cleaned = cleanTmuxLine(raw)
    if (!cleaned) continue
    cleaned = stripTraceStatusSuffix(cleaned)
    if (!cleaned) continue
    if (TRACE_EXCLUDE_PREFIXES.some((prefix) => prefix.test(cleaned))) continue
    if (isMetadataLine(cleaned, TMUX_METADATA_STATUS_PATTERNS)) continue
    if (cleaned.length < MIN_EXACT_MATCH_LENGTH) continue
    if (!traces.includes(cleaned)) {
      traces.push(cleaned)
    }
  }

  return traces
}

function resolveLogReadOptions(
  overrides: Partial<LogReadOptions> = {}
): LogReadOptions {
  return {
    lineLimit: overrides.lineLimit ?? DEFAULT_LOG_READ_OPTIONS.lineLimit,
    byteLimit: overrides.byteLimit ?? DEFAULT_LOG_READ_OPTIONS.byteLimit,
  }
}

export function getTerminalScrollback(
  tmuxWindow: string,
  lines = DEFAULT_SCROLLBACK_LINES
): string {
  const safeLines = Math.max(1, lines)
  const result = Bun.spawnSync(
    ['tmux', 'capture-pane', '-t', tmuxWindow, '-p', '-J', '-S', `-${safeLines}`],
    { stdout: 'pipe', stderr: 'pipe' }
  )
  if (result.exitCode !== 0) {
    return ''
  }
  return result.stdout.toString()
}

export function readLogContent(
  logPath: string,
  { lineLimit, byteLimit }: LogReadOptions = DEFAULT_LOG_READ_OPTIONS
): string {
  try {
    const buffer = fs.readFileSync(logPath)
    let content = buffer.toString('utf8')

    if (byteLimit > 0 && content.length > byteLimit) {
      content = content.slice(-byteLimit)
    }

    if (lineLimit > 0) {
      const lines = content.split('\n')
      if (lines.length > lineLimit) {
        content = lines.slice(-lineLimit).join('\n')
      }
    }

    return content
  } catch {
    return ''
  }
}

export function extractLogText(
  logPath: string,
  { mode = DEFAULT_LOG_TEXT_MODE, logRead }: LogTextOptionsInput = {}
): string {
  const resolvedRead = resolveLogReadOptions(logRead)
  const raw = readLogContent(logPath, resolvedRead)
  if (!raw || mode === 'all') {
    return raw
  }

  const chunks: string[] = []
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) {
      continue
    }
    let entry: unknown
    try {
      entry = JSON.parse(trimmed)
    } catch {
      continue
    }
    const extracted = extractTextFromEntry(entry, mode)
    if (extracted.length > 0) {
      chunks.push(...extracted)
    }
  }

  return chunks.join('\n')
}

export function getLogTokenCount(
  logPath: string,
  { mode = DEFAULT_LOG_TEXT_MODE, logRead }: LogTextOptionsInput = {}
): number {
  const content = extractLogText(logPath, { mode, logRead })
  return countTokens(content)
}
function countTokens(text: string): number {
  const normalized = normalizeText(text)
  if (!normalized) return 0
  return normalized.split(/\s+/).filter(Boolean).length
}

function extractTextFromEntry(entry: unknown, mode: LogTextMode): string[] {
  const roleText = extractRoleTextFromEntry(entry)
  return roleText
    .filter(({ role }) => shouldIncludeRole(role, mode))
    .map(({ text }) => text)
    .filter((chunk) => chunk.trim().length > 0)
}

function extractTextFromContent(content: unknown): string[] {
  if (!content) {
    return []
  }
  if (typeof content === 'string') {
    return [content]
  }
  if (!Array.isArray(content)) {
    return []
  }

  const chunks: string[] = []
  for (const item of content) {
    if (!item) {
      continue
    }
    if (typeof item === 'string') {
      chunks.push(item)
      continue
    }
    if (typeof item === 'object') {
      const entry = item as Record<string, unknown>
      const type = typeof entry.type === 'string' ? entry.type : ''
      if (type && !['text', 'input_text', 'output_text'].includes(type)) {
        continue
      }
      if (typeof entry.text === 'string') {
        chunks.push(entry.text)
      }
    }
  }
  return chunks
}

function shouldIncludeRole(role: string, mode: LogTextMode): boolean {
  if (mode === 'all') {
    return true
  }
  if (!role) {
    return false
  }
  if (mode === 'assistant-user') {
    return role === 'assistant' || role === 'user'
  }
  return role === mode
}

/**
 * Process user message text - filters tool notifications and extracts actions from user_action blocks.
 * Returns the processed text or null if it should be skipped.
 */
function processUserMessageText(text: string): string | null {
  if (!text.trim()) return null
  if (isToolNotificationText(text)) return null
  const action = extractActionFromUserAction(text)
  if (action) return action
  return text
}

function extractRoleTextFromEntry(
  entry: unknown
): Array<{ role: string; text: string }> {
  if (!entry || typeof entry !== 'object') {
    return []
  }

  const record = entry as Record<string, unknown>
  const chunks: Array<{ role: string; text: string }> = []

  // Codex: response_item -> payload message
  if (record.type === 'response_item') {
    const payload = record.payload as Record<string, unknown> | undefined
    if (payload && payload.type === 'message') {
      const role = (payload.role as string | undefined) ?? ''
      const texts = extractTextFromContent(payload.content)
      for (const text of texts) {
        if (role === 'user') {
          const processed = processUserMessageText(text)
          if (processed) chunks.push({ role, text: processed })
        } else if (text.trim()) {
          chunks.push({ role, text })
        }
      }
    }
  }

  // Claude: top-level message field
  if (record.message && typeof record.message === 'object') {
    const message = record.message as Record<string, unknown>
    const role =
      (message.role as string | undefined) ?? (record.type as string | undefined) ?? ''
    const texts = extractTextFromContent(message.content)
    for (const text of texts) {
      if (role === 'user') {
        const processed = processUserMessageText(text)
        if (processed) chunks.push({ role, text: processed })
      } else if (text.trim()) {
        chunks.push({ role, text })
      }
    }
  } else if (record.type === 'user' || record.type === 'assistant') {
    const role = record.type as string
    const direct = extractTextFromContent(record.content)
    for (const text of direct) {
      if (role === 'user') {
        const processed = processUserMessageText(text)
        if (processed) chunks.push({ role, text: processed })
      } else if (text.trim()) {
        chunks.push({ role, text })
      }
    }
    if (record.text && typeof record.text === 'string') {
      if (role === 'user') {
        const processed = processUserMessageText(record.text)
        if (processed) chunks.push({ role, text: processed })
      } else if (record.text.trim()) {
        chunks.push({ role, text: record.text })
      }
    }
  }

  // Codex event_msg: user_message (fallback)
  if (record.type === 'event_msg') {
    const payload = record.payload as Record<string, unknown> | undefined
    if (payload && payload.type === 'user_message') {
      const text = payload.message
      if (typeof text === 'string') {
        const processed = processUserMessageText(text)
        if (processed) chunks.push({ role: 'user', text: processed })
      }
    }
  }

  return chunks
}

function extractLastConversationFromLines(lines: string[]): ConversationPair {
  let lastUser = ''
  let lastAssistant = ''
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    let entry: unknown
    try {
      entry = JSON.parse(lines[i])
    } catch {
      continue
    }
    const roleText = extractRoleTextFromEntry(entry)
    for (const { role, text } of roleText) {
      if (!lastAssistant && role === 'assistant' && text.trim()) {
        lastAssistant = text.trim()
      }
      if (!lastUser && role === 'user' && text.trim()) {
        lastUser = text.trim()
      }
    }
    if (lastUser && lastAssistant) {
      break
    }
  }
  return { user: lastUser, assistant: lastAssistant }
}

function extractLastConversationFromLog(
  logPath: string,
  logRead: Partial<LogReadOptions> = {}
): ConversationPair {
  const resolvedRead = resolveLogReadOptions(logRead)
  const initialByteLimit = Math.max(0, resolvedRead.byteLimit)
  const maxByteLimit = Math.max(
    initialByteLimit,
    typeof logRead.maxByteLimit === 'number' ? logRead.maxByteLimit : initialByteLimit
  )
  const useProgressive = maxByteLimit > initialByteLimit
  const lineLimit = useProgressive ? 0 : resolvedRead.lineLimit

  if (initialByteLimit <= 0) {
    return { user: '', assistant: '' }
  }

  let byteLimit = initialByteLimit
  let lastPair: ConversationPair = { user: '', assistant: '' }

  while (byteLimit <= maxByteLimit) {
    const raw = readLogTail(logPath, byteLimit)
    if (!raw) {
      return { user: '', assistant: '' }
    }
    let lines = raw.split('\n').map((line) => line.trim()).filter(Boolean)
    if (lineLimit > 0 && lines.length > lineLimit) {
      lines = lines.slice(-lineLimit)
    }
    const pair = extractLastConversationFromLines(lines)
    lastPair = pair
    if (pair.user) {
      return pair
    }
    if (byteLimit >= maxByteLimit) {
      break
    }
    byteLimit = Math.min(byteLimit * 4, maxByteLimit)
  }

  return lastPair
}

export function extractLastUserMessageFromLog(
  logPath: string,
  logRead: Partial<LogReadOptions> = {}
): string | null {
  const { user } = extractLastConversationFromLog(logPath, logRead)
  return user && user.trim() ? user.trim() : null
}

export interface ExactMatchContext {
  agentType?: AgentType
  projectPath?: string
}

export interface ExactMatchResult {
  logPath: string
  userMessage: string
  matchedCount: number
  matchedLength: number
}

/**
 * Try to find a log file that matches a window's content.
 * Strategy:
 * 1. Extract recent user messages from tmux
 * 2. rg search for the longest messages → get candidate logs
 * 3. Narrow down with agent type/project path if available
 * 4. Break ties by ordered user-message matches in the log
 */
export function tryExactMatchWindowToLog(
  tmuxWindow: string,
  logDirs: string | string[],
  scrollbackLines = DEFAULT_SCROLLBACK_LINES,
  context: ExactMatchContext = {},
  search: ExactMatchSearchOptions = {}
): ExactMatchResult | null {
  const profile = search.profile
  const tmuxStart = performance.now()
  const scrollback = getTerminalScrollback(tmuxWindow, scrollbackLines)
  if (profile) {
    profile.tmuxCaptures += 1
    profile.tmuxCaptureMs += performance.now() - tmuxStart
  }
  const extractStart = performance.now()
  const userMessages = extractRecentUserMessagesFromTmux(scrollback)
  if (profile) {
    profile.messageExtractRuns += 1
    profile.messageExtractMs += performance.now() - extractStart
  }

  let messages = userMessages
  let usingTraceFallback = false
  if (messages.length === 0) {
    const traces = extractRecentTraceLinesFromTmux(scrollback)
    if (traces.length === 0) return null
    messages = traces
    usingTraceFallback = true
  }

  const hasDisambiguators = Boolean(context.agentType || context.projectPath)
  const longMessages = messages.filter(
    (message) => message.length >= MIN_EXACT_MATCH_LENGTH
  )
  const allowShortMessages = hasDisambiguators || usingTraceFallback
  const messagesToSearch =
    longMessages.length > 0 ? longMessages : allowShortMessages ? messages : []
  if (messagesToSearch.length === 0) return null

  const sortedMessages = [...messagesToSearch].sort((a, b) => b.length - a.length)
  let candidates: string[] = []

  for (const message of sortedMessages) {
    const minLength = message.length >= MIN_EXACT_MATCH_LENGTH ? MIN_EXACT_MATCH_LENGTH : 1
    const matches = findLogsWithExactMessage(message, logDirs, {
      minLength,
      logPaths: search.logPaths,
      tailBytes: search.tailBytes,
      rgThreads: search.rgThreads,
      profile: search.profile,
    })
    if (matches.length === 0) continue
    candidates = intersectCandidates(candidates, matches)
    if (candidates.length <= 1) break
  }

  if (candidates.length === 0) {
    return null
  }

  if (usingTraceFallback) {
    const filtered = candidates.filter((candidate) => !isCodexSubagent(candidate))
    if (filtered.length === 0) {
      return null
    }
    candidates = filtered
  }

  if (context.agentType) {
    const filtered = candidates.filter(
      (candidate) => inferAgentTypeFromPath(candidate) === context.agentType
    )
    if (filtered.length > 0) {
      candidates = filtered
    }
  }

  if (context.projectPath) {
    const target = normalizePath(context.projectPath)
    const filtered = candidates.filter((candidate) => {
      const projectPath = extractProjectPath(candidate)
      if (!projectPath) return false
      const normalized = normalizePath(projectPath)
      return isSameOrChildPath(normalized, target)
    })
    if (filtered.length > 0) {
      candidates = filtered
    }
  }

  const orderedMessages = messages
    .filter((message: string) => message.length >= MIN_EXACT_MATCH_LENGTH)
    .slice()
    .reverse()

  if (orderedMessages.length === 0) {
    return null
  }

  if (candidates.length === 1) {
    const score = scoreOrderedMessageMatches(candidates[0], orderedMessages, search)
    if (score.matchedCount === 0) {
      return null
    }
    return {
      logPath: candidates[0],
      userMessage: messages[0] ?? '',
      matchedCount: score.matchedCount,
      matchedLength: score.matchedLength,
    }
  }

  let scored = candidates.map((logPath) => ({
    logPath,
    score: scoreOrderedMessageMatches(logPath, orderedMessages, search),
  }))

  scored.sort((left, right) => compareOrderedScores(left.score, right.score))
  let best = scored[0]
  let second = scored[1]

  if (!best || best.score.matchedCount === 0) {
    return null
  }

  if (second) {
    const isTied =
      best.score.matchedCount === second.score.matchedCount &&
      best.score.matchedLength === second.score.matchedLength
    if (isTied) {
      const tied = scored.filter(
        (entry) => compareOrderedScores(entry.score, best.score) === 0
      )
      const needsFull = tied.some((entry) => entry.score.source === 'tail')
      if (needsFull) {
        const tieStart = performance.now()
        const updatedScores = new Map(
          tied.map((entry) => [
            entry.logPath,
            {
              ...scoreOrderedMessageMatchesWithRg(
                entry.logPath,
                orderedMessages,
                search
              ),
              source: 'rg' as const,
            },
          ])
        )
        if (profile) {
          profile.tieBreakRgRuns += tied.length
          profile.tieBreakRgMs += performance.now() - tieStart
        }
        scored = scored.map((entry) => {
          const updated = updatedScores.get(entry.logPath)
          if (!updated) return entry
          return { ...entry, score: updated }
        })
        scored.sort((left, right) => compareOrderedScores(left.score, right.score))
        best = scored[0]
        second = scored[1]
      }
    }
  }

  if (
    second &&
    best.score.matchedCount === second.score.matchedCount &&
    best.score.matchedLength === second.score.matchedLength
  ) {
    return null
  }

  return {
    logPath: best.logPath,
    userMessage: messages[0] ?? '',
    matchedCount: best.score.matchedCount,
    matchedLength: best.score.matchedLength,
  }
}

export function matchWindowsToLogsByExactRg(
  windows: Session[],
  logDirs: string | string[],
  scrollbackLines = DEFAULT_SCROLLBACK_LINES,
  search: ExactMatchSearchOptions = {}
): Map<string, Session> {
  const matches = new Map<
    string,
    { window: Session; score: OrderedMatchScore }
  >()
  const blocked = new Set<string>()
  const profile = search.profile

  for (const window of windows) {
    const start = performance.now()
    const result = tryExactMatchWindowToLog(
      window.tmuxWindow,
      logDirs,
      scrollbackLines,
      { agentType: window.agentType, projectPath: window.projectPath },
      search
    )
    if (profile) {
      profile.windowMatchRuns += 1
      profile.windowMatchMs += performance.now() - start
    }
    if (!result) continue

    const score = {
      matchedCount: result.matchedCount,
      matchedLength: result.matchedLength,
    }
    const existing = matches.get(result.logPath)

    if (blocked.has(result.logPath)) {
      continue
    }
    if (!existing) {
      matches.set(result.logPath, { window, score })
      continue
    }

    const comparison = compareOrderedScores(score, existing.score)
    if (comparison === 0) {
      matches.delete(result.logPath)
      blocked.add(result.logPath)
      continue
    }
    if (comparison < 0) {
      matches.set(result.logPath, { window, score })
    }
  }

  const resolved = new Map<string, Session>()
  for (const [logPath, entry] of matches) {
    resolved.set(logPath, entry.window)
  }

  return resolved
}

/**
 * Verify that a window's terminal content matches a specific log file.
 * Used on startup to validate stored currentWindow associations before trusting them.
 * Returns true if the window content matches the log, false otherwise.
 */
export function verifyWindowLogAssociation(
  tmuxWindow: string,
  logPath: string,
  logDirs: string[],
  context: ExactMatchContext = {},
  scrollbackLines = DEFAULT_SCROLLBACK_LINES
): boolean {
  const result = tryExactMatchWindowToLog(
    tmuxWindow,
    logDirs,
    scrollbackLines,
    context,
    { logPaths: [logPath] }
  )
  return result !== null && result.logPath === logPath
}
