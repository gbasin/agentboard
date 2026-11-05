// Replay of a Codex chat's history from its rollout file (codex-chat-sessions
// D8 as amended by PR D decision 2, M3): the rollout is the one replay
// source. `thread/read` is not used — its `includeTurns` flag is deprecated
// on the pinned 0.163.0 baseline, and a second source would add a second
// row-id scheme (R2).
//
// Row kinds follow the spike's recorded shapes (design, "Replay shapes"):
// `session_meta`, `response_item` messages (user and assistant), function and
// custom tool calls with their outputs, `reasoning`, and `event_msg` turn
// markers (`task_started`, `task_complete`, `turn_aborted`, `error`). Every
// turn emits turn_started … turn_completed (or turn_interrupted) — the
// boundaries a live turn emits, `turn_completed` included. Unknown row kinds
// are skipped.
//
// Ids are `codex-r<line index>-<first 8 hex of sha256(line)>`: stable while
// the file only grows, and a row rewritten under the same path gets a new
// id, so a client's older `beforeId` reads stale instead of paging from the
// wrong place.
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import type { ChatEvent } from '../../../shared/chat'
import { parseEnvelope } from '../../team/envelope'
import { historyUnavailable, type TranscriptReplay } from '../transcriptReplay'
import { readLines } from '../lineReader'
import type { CodexEventDraft } from './codexEvents'

type Row = Record<string, unknown>

/** User rows Codex injects as context, never typed by anyone. */
const INJECTED_PREFIXES = ['<environment_context>', '<user_instructions>', '# AGENTS.md instructions', '<skill>']

const record = (value: unknown): Row | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Row) : null
const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined)

function blockTexts(content: unknown, types: string[]): string[] {
  if (typeof content === 'string') return [content]
  return (Array.isArray(content) ? content : [])
    .map(block => record(block))
    .filter((block): block is Row => !!block && types.includes(String(block.type)) && typeof block.text === 'string')
    .map(block => block.text as string)
}

function parseArguments(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try { return record(JSON.parse(value)) ?? { input: value } } catch { return { input: value } }
  }
  return record(value) ?? {}
}

function outputText(value: unknown): { output: string; isError: boolean } {
  if (typeof value === 'string') return { output: value, isError: false }
  const row = record(value)
  if (row) {
    const content = str(row.content) ?? blockTexts(row.content, ['input_text', 'output_text', 'text', 'inputText']).join('\n')
    return { output: content, isError: row.success === false }
  }
  return { output: '', isError: false }
}

/**
 * Whether a retryable Codex notice memo may be dropped for a retry now (D8,
 * M3): only while no live turn has begun — a re-read once live events exist
 * would replay those turns as duplicated history. Pure, so the memo rule is
 * table-tested; the manager only decides when to ask it.
 */
export const canRetryCodexMemo = (retryable: boolean, liveEvents: number): boolean =>
  retryable && liveEvents === 0

/** A rollout parser fed one line at a time with its index; `finish` returns the events. */
export interface RolloutParser {
  line(line: string, index: number): void
  finish(): ChatEvent[]
}

/**
 * The stateful line consumer behind `parseCodexRollout` (bounded-history-capture
 * D2). Row ids derive from the line's index among `content.split('\n')`, blank
 * pieces counted, so a reader must pass that index for ids to stay stable.
 */
export function createRolloutParser(): RolloutParser {
  const events: ChatEvent[] = []
  let turnId: string | null = null
  let turnFailed = false
  const take = (line: string, index: number): void => {
    if (!line.trim()) return
    let row: Row | null
    try { row = record(JSON.parse(line)) } catch { return }
    const payload = record(row?.payload)
    if (!row || !payload) return
    const rowId = `codex-r${index}-${createHash('sha256').update(line).digest('hex').slice(0, 8)}`
    const at = str(row.timestamp) ?? ''
    let part = 0
    const push = (draft: CodexEventDraft) => {
      events.push({ ...draft, id: part === 0 ? rowId : `${rowId}:${part}`, sequence: 0, at } as ChatEvent)
      part += 1
    }
    const open = () => {
      turnId = `codex-turn-${rowId}`
      turnFailed = false
      push({ type: 'turn_started', turnId })
      return turnId
    }
    const kind = String(payload.type)
    if (row.type === 'event_msg') {
      if (kind === 'task_started') open()
      else if (kind === 'task_complete' && turnId) {
        const finalText = str(payload.last_agent_message)
        push({
          type: 'turn_completed', turnId,
          subtype: turnFailed ? 'error_during_execution' : 'success',
          ...(turnFailed ? { isError: true } : finalText ? { finalText } : {}),
        })
        turnId = null
      } else if (kind === 'turn_aborted' && turnId) {
        push({ type: 'turn_interrupted', turnId })
        turnId = null
      } else if (kind === 'error') {
        turnFailed = true
        push({ type: 'error', message: str(payload.message) ?? 'The Codex turn failed' })
      }
      return
    }
    if (row.type !== 'response_item') return
    if (kind === 'message' && payload.role === 'user') {
      const text = blockTexts(payload.content, ['input_text', 'text']).join('\n')
      if (!text.trim() || INJECTED_PREFIXES.some(prefix => text.trimStart().startsWith(prefix))) return
      const turn = turnId ?? open()
      const peer = parseEnvelope(text)
      push(peer ? { type: 'peer_message', turnId: turn, ...peer } : { type: 'user_message', turnId: turn, text })
    } else if (kind === 'message' && payload.role === 'assistant') {
      const text = blockTexts(payload.content, ['output_text', 'text']).join('\n')
      if (text && turnId) push({ type: 'assistant_text', turnId, messageId: str(payload.id) ?? rowId, text })
    } else if ((kind === 'function_call' || kind === 'custom_tool_call') && turnId) {
      const toolCallId = str(payload.call_id) ?? rowId
      const input = kind === 'function_call' ? parseArguments(payload.arguments) : parseArguments(payload.input)
      push({ type: 'tool_call', turnId, toolCallId, tool: str(payload.name) ?? 'tool', input })
    } else if ((kind === 'function_call_output' || kind === 'custom_tool_call_output') && turnId) {
      const result = outputText(payload.output)
      push({ type: 'tool_result', turnId, toolCallId: str(payload.call_id) ?? rowId, output: result.output, ...(result.isError ? { isError: true } : {}) })
    }
  }
  return { line: take, finish: () => events }
}

export function parseCodexRollout(content: string): ChatEvent[] {
  const parser = createRolloutParser()
  content.split('\n').forEach((line, index) => parser.line(line, index))
  return parser.finish()
}

/**
 * A Codex chat's history from its rollout. A missing or unreadable file is
 * the "history unavailable" notice; the manager memoizes that result marked
 * retryable and retries it on a later load while no live turn could be
 * duplicated (D8, M3). Codex's cwd is fixed at thread start, so the replay
 * never reports one.
 */
export function replayCodexRollout(file: string | null | undefined): TranscriptReplay {
  if (!file) return historyUnavailable('missing')
  let content: string
  try { content = fs.readFileSync(file, 'utf8') } catch (error) {
    return historyUnavailable((error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unparseable')
  }
  return { status: 'ok', events: parseCodexRollout(content), cwd: null }
}

/** The async replay streams the rollout through `readLines` (D2): no whole-file string. */
export async function replayCodexRolloutAsync(file: string | null | undefined): Promise<TranscriptReplay> {
  if (!file) return historyUnavailable('missing')
  const parser = createRolloutParser()
  try { await readLines(file, parser.line) } catch (error) {
    return historyUnavailable((error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unparseable')
  }
  return { status: 'ok', events: parser.finish(), cwd: null }
}
