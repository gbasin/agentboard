import fs from 'node:fs'
import type { Session } from '../shared/types'

const DEFAULT_LOG_LINE_LIMIT = 2000
const DEFAULT_LOG_BYTE_LIMIT = 200 * 1024
const DEFAULT_SCROLLBACK_LINES = 2000
const MIN_TOKEN_COUNT = 50
const LAST_EXCHANGE_MIN_TOKENS = 5

const TMUX_DECORATIVE_LINE_PATTERN =
  /^[\s─━│┃┄┅┆┇┈┉┊┋┌┐└┘├┤┬┴┼╔╗╚╝╠╣╦╩╬═╭╮╯╰▔▁]+$/
const TMUX_METADATA_PATTERNS: RegExp[] = [
  /context left/i,
  /background terminal running/i,
  /for shortcuts/i,
  /todos?\b/i,
  /accept edits/i,
  /baked for/i,
  /opus .* on /i,
  /^\s*[☐☑■□]/,
]
const TMUX_TIMER_PATTERN = /\(\d+s[^)]*\)/g
const TMUX_UI_GLYPH_PATTERN = /[•❯⏵⏺↵]/g
const TMUX_PROMPT_PREFIX = /^[\s>*#$❯]+/

export interface WindowScore {
  window: Session
  score: number
  leftTokens?: number
  rightTokens?: number
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

export type LogTextMode = 'all' | 'assistant' | 'user' | 'assistant-user'
export type SimilarityMode = 'jaccard' | 'containment' | 'hybrid'
export type MatchScope = 'full' | 'last-exchange'

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
  lineLimit = DEFAULT_LOG_LINE_LIMIT,
  byteLimit = DEFAULT_LOG_BYTE_LIMIT
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
  {
    mode = 'assistant-user',
    lineLimit = DEFAULT_LOG_LINE_LIMIT,
    byteLimit = DEFAULT_LOG_BYTE_LIMIT,
  }: {
    mode?: LogTextMode
    lineLimit?: number
    byteLimit?: number
  } = {}
): string {
  const raw = readLogContent(logPath, lineLimit, byteLimit)
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

export function computeSimilarity(left: string, right: string): number {
  return computeSimilarityWithMode(left, right)
}

export function computeSimilarityWithMode(
  left: string,
  right: string,
  {
    mode = 'jaccard',
    minTokens = MIN_TOKEN_COUNT,
  }: {
    mode?: SimilarityMode
    minTokens?: number
  } = {}
): number {
  const leftTokens = tokenizeNormalized(normalizeText(left))
  const rightTokens = tokenizeNormalized(normalizeText(right))
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

export function scoreLogAgainstWindows(
  logContent: string,
  windows: Session[],
  scrollbackLines = DEFAULT_SCROLLBACK_LINES,
  similarityMode: SimilarityMode = 'jaccard',
  minTokens = MIN_TOKEN_COUNT
): WindowScore[] {
  return windows
    .map((window) => ({
      window,
      score: computeSimilarityWithMode(
        logContent,
        getTerminalScrollback(window.tmuxWindow, scrollbackLines),
        { mode: similarityMode, minTokens }
      ),
    }))
    .sort((a, b) => b.score - a.score)
}

export function findMatchingWindow(
  logPath: string,
  windows: Session[],
  {
    minScore = 0.9,
    minGap = 0.02,
    scrollbackLines = DEFAULT_SCROLLBACK_LINES,
    logLineLimit = DEFAULT_LOG_LINE_LIMIT,
    logByteLimit = DEFAULT_LOG_BYTE_LIMIT,
    logTextMode = 'assistant-user',
    similarityMode = 'jaccard',
    matchScope = 'full',
    minTokens = MIN_TOKEN_COUNT,
  }: {
    minScore?: number
    minGap?: number
    scrollbackLines?: number
    logLineLimit?: number
    logByteLimit?: number
    logTextMode?: LogTextMode
    similarityMode?: SimilarityMode
    matchScope?: MatchScope
    minTokens?: number
  } = {}
): MatchResult {
  if (windows.length === 0) {
    return {
      match: null,
      bestScore: 0,
      secondScore: 0,
      scores: [],
      reason: 'no_windows',
      minScore,
      minGap,
      minTokens,
    }
  }

  let scores: WindowScore[] = []
  if (matchScope === 'last-exchange') {
    const logPair = extractLastConversationFromLog(logPath, {
      lineLimit: logLineLimit,
      byteLimit: logByteLimit,
    })
    const logCombined = [logPair.user, logPair.assistant]
      .filter(Boolean)
      .join('\n')
    const effectiveMinTokens =
      minTokens === MIN_TOKEN_COUNT ? LAST_EXCHANGE_MIN_TOKENS : minTokens
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
        return {
          window,
          score: computeSimilarityWithMode(left, right, {
            mode: similarityMode,
            minTokens: effectiveMinTokens,
          }),
        }
      })
      .sort((a, b) => b.score - a.score)
  } else {
    const logContent = extractLogText(logPath, {
      mode: logTextMode,
      lineLimit: logLineLimit,
      byteLimit: logByteLimit,
    })
    scores = scoreLogAgainstWindows(
      logContent,
      windows,
      scrollbackLines,
      similarityMode,
      minTokens
    )
  }
  const bestScore = scores[0]?.score ?? 0
  const secondScore = scores[1]?.score ?? 0
  const gap = bestScore - secondScore

  let match: Session | null = null
  let reason: MatchReason = 'matched'

  if (bestScore < minScore) {
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
    minScore,
    minGap,
    minTokens,
    bestLeftTokens: scores[0]?.leftTokens,
    bestRightTokens: scores[0]?.rightTokens,
  }
}

function tokenizeNormalized(text: string): string[] {
  return text.split(/\s+/).map((token) => token.trim()).filter(Boolean)
}

function stripAnsi(text: string): string {
  return text.replace(
    // eslint-disable-next-line no-control-regex -- need to match ANSI escapes
    /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g,
    ''
  )
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
  {
    lineLimit = DEFAULT_LOG_LINE_LIMIT,
    byteLimit = DEFAULT_LOG_BYTE_LIMIT,
  }: {
    lineLimit?: number
    byteLimit?: number
  } = {}
): ConversationPair {
  const raw = readLogContent(logPath, lineLimit, byteLimit)
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

  const isPromptLine = (line: string) => {
    const trimmed = line.trim()
    if (!trimmed) {
      return false
    }
    if (trimmed.includes('↵')) {
      return true
    }
    return TMUX_PROMPT_PREFIX.test(trimmed)
  }

  const isDecorativeLine = (line: string) =>
    TMUX_DECORATIVE_LINE_PATTERN.test(line)

  const isMetadataLine = (line: string) =>
    TMUX_METADATA_PATTERNS.some((pattern) => pattern.test(line))

  const cleanLine = (line: string) =>
    stripAnsi(line)
      .replace(TMUX_TIMER_PATTERN, '')
      .replace(TMUX_UI_GLYPH_PATTERN, ' ')
      .replace(/\s+/g, ' ')
      .trim()

  const extractUserFromPrompt = (line: string) => {
    let cleaned = stripAnsi(line).trim()
    cleaned = cleaned.replace(TMUX_PROMPT_PREFIX, '').trim()
    cleaned = cleaned.replace(/\s*↵\s*send\s*$/i, '').trim()
    cleaned = cleaned.replace(TMUX_UI_GLYPH_PATTERN, ' ')
    cleaned = cleaned.replace(/\s+/g, ' ').trim()
    return cleaned
  }

  let promptIndex = -1
  for (let i = rawLines.length - 1; i >= 0; i -= 1) {
    if (isPromptLine(rawLines[i] ?? '')) {
      promptIndex = i
      break
    }
  }

  let user = ''
  let assistant = ''
  if (promptIndex >= 0) {
    const promptLine = rawLines[promptIndex] ?? ''
    const pendingSend = promptLine.includes('↵')
    user = pendingSend ? '' : extractUserFromPrompt(promptLine)
    const assistantLines: string[] = []
    let blankStreak = 0
    for (let i = promptIndex - 1; i >= 0; i -= 1) {
      const line = rawLines[i] ?? ''
      const trimmed = line.trim()
      if (!trimmed) {
        if (assistantLines.length > 0) {
          blankStreak += 1
          if (blankStreak > 2) {
            break
          }
        }
        continue
      }
      blankStreak = 0
      if (isPromptLine(line)) {
        break
      }
      if (isDecorativeLine(trimmed) || isMetadataLine(trimmed)) {
        continue
      }
      assistantLines.push(cleanLine(line))
      if (assistantLines.length >= 60) {
        break
      }
    }
    assistant = assistantLines.reverse().join('\n')
  } else {
    const assistantLines: string[] = []
    let blankStreak = 0
    for (let i = rawLines.length - 1; i >= 0; i -= 1) {
      const line = rawLines[i] ?? ''
      const trimmed = line.trim()
      if (!trimmed) {
        if (assistantLines.length > 0) {
          blankStreak += 1
          if (blankStreak > 2) {
            break
          }
        }
        continue
      }
      blankStreak = 0
      if (isDecorativeLine(trimmed) || isMetadataLine(trimmed)) {
        continue
      }
      assistantLines.push(cleanLine(line))
      if (assistantLines.length >= 60) {
        break
      }
    }
    assistant = assistantLines.reverse().join('\n')
  }

  return { user, assistant }
}
