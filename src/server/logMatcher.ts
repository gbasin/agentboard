import fs from 'node:fs'
import type { Session } from '../shared/types'
import {
  cleanTmuxLine,
  isDecorativeLine,
  isMetadataLine,
  stripAnsi,
  TMUX_METADATA_MATCH_PATTERNS,
  TMUX_PROMPT_PREFIX,
  TMUX_UI_GLYPH_PATTERN,
} from './terminal/tmuxText'

export type LogTextMode = 'all' | 'assistant' | 'user' | 'assistant-user'
export type SimilarityMode = 'jaccard' | 'containment' | 'hybrid'
export type MatchScope = 'full' | 'last-exchange'

export interface LogReadOptions {
  lineLimit: number
  byteLimit: number
}

export interface LogTextOptionsInput {
  mode?: LogTextMode
  logRead?: Partial<LogReadOptions>
}

export interface MatchOptions {
  minScore: number
  minGap: number
  scrollbackLines: number
  logTextMode: LogTextMode
  similarityMode: SimilarityMode
  matchScope: MatchScope
  minTokens: number
  logRead: LogReadOptions
}

export type MatchOptionsInput = Partial<Omit<MatchOptions, 'logRead'>> & {
  logRead?: Partial<LogReadOptions>
}

const DEFAULT_LOG_READ_OPTIONS: LogReadOptions = {
  lineLimit: 2000,
  byteLimit: 200 * 1024,
}

export const DEFAULT_MATCH_OPTIONS: MatchOptions = {
  minScore: 0.7,
  minGap: 0.02,
  scrollbackLines: 2000,
  logTextMode: 'assistant-user',
  similarityMode: 'containment',
  matchScope: 'last-exchange',
  minTokens: 10,
  logRead: DEFAULT_LOG_READ_OPTIONS,
}

const SHORT_SESSION_TOKENS = 300
const SHORT_SESSION_MIN_SCORE = 0.3
const LAST_EXCHANGE_MIN_TOKENS = 5

export interface WindowScore {
  window: Session
  score: number
  leftTokens?: number
  rightTokens?: number
}

interface ScoreOptions {
  scrollbackLines: number
  similarityMode: SimilarityMode
  minTokens: number
}

export type MatchReason =
  | 'matched'
  | 'no_windows'
  | 'too_few_tokens'
  | 'low_score'
  | 'low_gap'

export interface MatchResult {
  match: Session | null
  bestScore: number
  secondScore: number
  scores: WindowScore[]
  reason: MatchReason
  minScore: number
  minGap: number
  minTokens: number
  bestLeftTokens?: number
  bestRightTokens?: number
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

function resolveLogReadOptions(
  overrides: Partial<LogReadOptions> = {}
): LogReadOptions {
  return {
    lineLimit: overrides.lineLimit ?? DEFAULT_LOG_READ_OPTIONS.lineLimit,
    byteLimit: overrides.byteLimit ?? DEFAULT_LOG_READ_OPTIONS.byteLimit,
  }
}

function resolveMatchOptions(
  overrides: MatchOptionsInput = {}
): MatchOptions {
  const logRead = resolveLogReadOptions(overrides.logRead)
  return {
    minScore: overrides.minScore ?? DEFAULT_MATCH_OPTIONS.minScore,
    minGap: overrides.minGap ?? DEFAULT_MATCH_OPTIONS.minGap,
    scrollbackLines:
      overrides.scrollbackLines ?? DEFAULT_MATCH_OPTIONS.scrollbackLines,
    logTextMode: overrides.logTextMode ?? DEFAULT_MATCH_OPTIONS.logTextMode,
    similarityMode:
      overrides.similarityMode ?? DEFAULT_MATCH_OPTIONS.similarityMode,
    matchScope: overrides.matchScope ?? DEFAULT_MATCH_OPTIONS.matchScope,
    minTokens: overrides.minTokens ?? DEFAULT_MATCH_OPTIONS.minTokens,
    logRead,
  }
}

export function getTerminalScrollback(
  tmuxWindow: string,
  lines = DEFAULT_MATCH_OPTIONS.scrollbackLines
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
  { mode = DEFAULT_MATCH_OPTIONS.logTextMode, logRead }: LogTextOptionsInput = {}
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
  { mode = DEFAULT_MATCH_OPTIONS.logTextMode, logRead }: LogTextOptionsInput = {}
): number {
  const content = extractLogText(logPath, { mode, logRead })
  return tokenizeForSimilarity(content).length
}

export function computeSimilarity(left: string, right: string): number {
  return computeSimilarityWithMode(left, right)
}

export function computeSimilarityWithMode(
  left: string,
  right: string,
  {
    mode = 'containment',
    minTokens = DEFAULT_MATCH_OPTIONS.minTokens,
  }: {
    mode?: SimilarityMode
    minTokens?: number
  } = {}
): number {
  const leftTokens = tokenizeForSimilarity(left)
  const rightTokens = tokenizeForSimilarity(right)
  return computeSimilarityFromTokens(leftTokens, rightTokens, mode, minTokens)
}

export function scoreLogAgainstWindows(
  logContent: string,
  windows: Session[],
  { scrollbackLines, similarityMode, minTokens }: ScoreOptions
): WindowScore[] {
  const logTokens = tokenizeForSimilarity(logContent)
  const logTokenCount = logTokens.length
  return windows
    .map((window) => {
      const scrollback = getTerminalScrollback(
        window.tmuxWindow,
        scrollbackLines
      )
      const rightTokens = tokenizeForSimilarity(scrollback)
      return {
        window,
        score: computeSimilarityFromTokens(
          logTokens,
          rightTokens,
          similarityMode,
          minTokens
        ),
        leftTokens: logTokenCount,
        rightTokens: rightTokens.length,
      }
    })
    .sort((a, b) => b.score - a.score)
}

export function findMatchingWindow(
  logPath: string,
  windows: Session[],
  overrides: MatchOptionsInput = {}
): MatchResult {
  const {
    minScore,
    minGap,
    scrollbackLines,
    logTextMode,
    similarityMode,
    matchScope,
    minTokens,
    logRead,
  } = resolveMatchOptions(overrides)
  const minTokensUsed =
    matchScope === 'last-exchange' &&
    minTokens === DEFAULT_MATCH_OPTIONS.minTokens
      ? LAST_EXCHANGE_MIN_TOKENS
      : minTokens
  if (windows.length === 0) {
    return {
      match: null,
      bestScore: 0,
      secondScore: 0,
      scores: [],
      reason: 'no_windows',
      minScore,
      minGap,
      minTokens: minTokensUsed,
    }
  }

  let scores: WindowScore[] = []
  if (matchScope === 'last-exchange') {
    const logPair = extractLastConversationFromLog(logPath, logRead)
    const logCombined = [logPair.user, logPair.assistant]
      .filter(Boolean)
      .join('\n')
    scores = windows
      .map((window) => {
        const tmuxContent = getTerminalScrollback(
          window.tmuxWindow,
          scrollbackLines
        )
        const tmuxPair = extractLastConversationFromTmux(tmuxContent)
        const tmuxCombined = [tmuxPair.user, tmuxPair.assistant]
          .filter(Boolean)
          .join('\n')
        const logAssistantOnly =
          !tmuxPair.user && tmuxPair.assistant && logPair.assistant
        const left = logAssistantOnly ? logPair.assistant : logCombined
        const right = logAssistantOnly ? tmuxPair.assistant : tmuxCombined
        const leftTokens = tokenizeForSimilarity(left)
        const rightTokens = tokenizeForSimilarity(right)
        return {
          window,
          score: computeSimilarityFromTokens(
            leftTokens,
            rightTokens,
            similarityMode,
            minTokensUsed
          ),
          leftTokens: leftTokens.length,
          rightTokens: rightTokens.length,
        }
      })
      .sort((a, b) => b.score - a.score)
  } else {
    const logContent = extractLogText(logPath, {
      mode: logTextMode,
      logRead,
    })
    scores = scoreLogAgainstWindows(
      logContent,
      windows,
      {
        scrollbackLines,
        similarityMode,
        minTokens: minTokensUsed,
      }
    )
  }
  const bestScore = scores[0]?.score ?? 0
  const secondScore = scores[1]?.score ?? 0
  const gap = bestScore - secondScore

  let match: Session | null = null
  let reason: MatchReason = 'matched'
  const bestLeftTokens = scores[0]?.leftTokens
  const bestRightTokens = scores[0]?.rightTokens
  const effectiveMinScore =
    bestLeftTokens !== undefined && bestLeftTokens < SHORT_SESSION_TOKENS
      ? Math.min(minScore, SHORT_SESSION_MIN_SCORE)
      : minScore

  if (
    (bestLeftTokens !== undefined && bestLeftTokens < minTokensUsed) ||
    (bestRightTokens !== undefined && bestRightTokens < minTokensUsed)
  ) {
    reason = 'too_few_tokens'
  } else if (bestScore < effectiveMinScore) {
    reason = 'low_score'
  } else if (gap < minGap) {
    reason = 'low_gap'
  } else {
    match = scores[0]?.window ?? null
  }

  return {
    match,
    bestScore,
    secondScore,
    scores,
    reason,
    minScore: effectiveMinScore,
    minGap,
    minTokens: minTokensUsed,
    bestLeftTokens,
    bestRightTokens,
  }
}

function tokenizeNormalized(text: string): string[] {
  return text.split(/\s+/).map((token) => token.trim()).filter(Boolean)
}

function tokenizeForSimilarity(text: string): string[] {
  const normalized = normalizeText(text)
  if (!normalized) return []
  return tokenizeNormalized(normalized)
}

function computeSimilarityFromTokens(
  leftTokens: string[],
  rightTokens: string[],
  mode: SimilarityMode,
  minTokens: number
): number {
  if (leftTokens.length < minTokens || rightTokens.length < minTokens) {
    return 0
  }

  const leftSet = new Set(leftTokens)
  const rightSet = new Set(rightTokens)
  let overlap = 0
  for (const token of leftSet) {
    if (rightSet.has(token)) {
      overlap += 1
    }
  }

  if (mode === 'containment') {
    const minSize = Math.min(leftSet.size, rightSet.size)
    return minSize === 0 ? 0 : overlap / minSize
  }

  const union = leftSet.size + rightSet.size - overlap
  const jaccard = union === 0 ? 0 : overlap / union
  if (mode === 'hybrid') {
    const minSize = Math.min(leftSet.size, rightSet.size)
    const containment = minSize === 0 ? 0 : overlap / minSize
    return (jaccard + containment) / 2
  }

  return jaccard
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
        if (text.trim()) {
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
      if (text.trim()) {
        chunks.push({ role, text })
      }
    }
  } else if (record.type === 'user' || record.type === 'assistant') {
    const role = record.type as string
    const direct = extractTextFromContent(record.content)
    for (const text of direct) {
      if (text.trim()) {
        chunks.push({ role, text })
      }
    }
    if (record.text && typeof record.text === 'string' && record.text.trim()) {
      chunks.push({ role, text: record.text })
    }
  }

  // Codex event_msg: user_message (fallback)
  if (record.type === 'event_msg') {
    const payload = record.payload as Record<string, unknown> | undefined
    if (payload && payload.type === 'user_message') {
      const text = payload.message
      if (typeof text === 'string' && text.trim()) {
        chunks.push({ role: 'user', text })
      }
    }
  }

  return chunks
}

function extractLastConversationFromLog(
  logPath: string,
  logRead: Partial<LogReadOptions> = {}
): ConversationPair {
  const resolvedRead = resolveLogReadOptions(logRead)
  const raw = readLogContent(logPath, resolvedRead)
  if (!raw) {
    return { user: '', assistant: '' }
  }
  const lines = raw.split('\n').map((line) => line.trim()).filter(Boolean)
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

function extractLastConversationFromTmux(content: string): ConversationPair {
  const rawLines = stripAnsi(content).split('\n')
  while (rawLines.length > 0 && rawLines[rawLines.length - 1]?.trim() === '') {
    rawLines.pop()
  }

  // Claude Code: ❯ for prompts, ⏺ for responses
  // Codex: › for prompts, • for responses
  const isClaudePromptLine = (line: string) => {
    const trimmed = line.trim()
    if (!trimmed) return false
    if (trimmed.includes('↵')) return true
    return /^[\s>*#$❯]+/.test(trimmed) && trimmed.includes('❯')
  }

  const isCodexPromptLine = (line: string) => {
    const trimmed = line.trim()
    if (!trimmed) return false
    // Codex prompt: › at start of line
    return trimmed.startsWith('›')
  }

  const isPromptLine = (line: string) => isClaudePromptLine(line) || isCodexPromptLine(line)

  // Claude: ⏺ for assistant response bullet
  const isClaudeBulletLine = (line: string) => /^\s*⏺/.test(line)

  // Codex: • for assistant response bullet
  const isCodexBulletLine = (line: string) => /^\s*•/.test(line)

  // Any assistant bullet (Claude or Codex)
  const isBulletLine = (line: string) => isClaudeBulletLine(line) || isCodexBulletLine(line)

  // Detect tool call bullets - these start with tool names like Write(, Bash(, Read(, etc.
  const isToolCallBullet = (line: string) => {
    const trimmed = line.trim()
    if (!isBulletLine(line)) return false
    // Remove the bullet and check for tool call patterns
    const afterBullet = trimmed.replace(/^[⏺•]\s*/, '')
    // Claude tool patterns
    if (/^(Write|Bash|Read|Glob|Grep|Edit|Task|WebFetch|WebSearch|TodoWrite)\s*\(/.test(afterBullet)) {
      return true
    }
    // Codex tool patterns: "Ran <command>", "Read <file>", etc.
    if (/^(Ran|Read|Wrote|Created|Updated|Deleted)\s+/.test(afterBullet)) {
      return true
    }
    return false
  }

  // Check if a bullet is a text response (not a tool call)
  const isTextBullet = (line: string) => isBulletLine(line) && !isToolCallBullet(line)

  const extractUserFromPrompt = (line: string) => {
    let cleaned = stripAnsi(line).trim()
    // Remove Claude prompt prefix (❯)
    cleaned = cleaned.replace(TMUX_PROMPT_PREFIX, '').trim()
    // Remove Codex prompt prefix (›)
    cleaned = cleaned.replace(/^›\s*/, '').trim()
    cleaned = cleaned.replace(/\s*↵\s*send\s*$/i, '').trim()
    cleaned = cleaned.replace(TMUX_UI_GLYPH_PATTERN, ' ')
    cleaned = cleaned.replace(/\s+/g, ' ').trim()
    return cleaned
  }

  // Find the two most recent prompts to bound the last exchange
  let currentPromptIdx = -1
  let prevPromptIdx = -1
  for (let i = rawLines.length - 1; i >= 0; i--) {
    if (isPromptLine(rawLines[i] ?? '')) {
      if (currentPromptIdx === -1) {
        currentPromptIdx = i
      } else {
        prevPromptIdx = i
        break
      }
    }
  }

  // No prompts found at all
  if (currentPromptIdx === -1) {
    return { user: '', assistant: '' }
  }

  const promptLine = rawLines[currentPromptIdx] ?? ''
  const pendingSend = promptLine.includes('↵')
  const user = pendingSend ? '' : extractUserFromPrompt(promptLine)

  // Single prompt case (new session): extract user input and any assistant content below
  if (prevPromptIdx === -1) {
    // Look for assistant content below the prompt
    let assistant = ''
    const assistantLines: string[] = []
    for (let i = currentPromptIdx + 1; i < rawLines.length; i++) {
      const line = rawLines[i] ?? ''
      const trimmed = line.trim()
      if (!trimmed) continue
      if (isPromptLine(line)) break // Stop if we hit another prompt
      if (
        isDecorativeLine(trimmed) ||
        isMetadataLine(trimmed, TMUX_METADATA_MATCH_PATTERNS)
      ) {
        continue
      }
      if (isToolCallBullet(line)) continue // Skip tool calls
      assistantLines.push(cleanTmuxLine(line))
      if (assistantLines.length >= 60) break
    }
    assistant = assistantLines.join('\n')
    return { user, assistant }
  }

  // Two prompts case: extract exchange between prev and current prompt
  // Find text bullets between prev prompt and current prompt (skip tool call bullets)
  let firstTextBulletIdx = -1
  for (let i = prevPromptIdx + 1; i < currentPromptIdx; i++) {
    if (isTextBullet(rawLines[i] ?? '')) {
      firstTextBulletIdx = i
      break
    }
  }

  // Extract assistant text starting from the first text bullet
  let assistant = ''
  if (firstTextBulletIdx !== -1) {
    const assistantLines: string[] = []
    for (let i = firstTextBulletIdx; i < currentPromptIdx; i++) {
      const line = rawLines[i] ?? ''
      const trimmed = line.trim()
      // Stop if we hit a tool call bullet
      if (i > firstTextBulletIdx && isToolCallBullet(line)) break
      // Stop if we hit another text bullet (next response)
      if (i > firstTextBulletIdx && isTextBullet(line)) break
      if (!trimmed) continue
      if (
        isDecorativeLine(trimmed) ||
        isMetadataLine(trimmed, TMUX_METADATA_MATCH_PATTERNS)
      ) {
        continue
      }
      assistantLines.push(cleanTmuxLine(line))
      if (assistantLines.length >= 60) break
    }
    assistant = assistantLines.join('\n')
  }

  return { user, assistant }
}
