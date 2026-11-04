// Read-only transcript with one expandable entry per tool use. Calls and
// results are paired in the view; the interactive approval/question cards
// render separately, while each approval entry also renders as a row so a
// search snippet has a target to reveal (its anchor is the event id).
// Agent/Task calls render as worker rows instead (workers design D8) when a
// session context is given: the row joins the roster by workerId and falls
// back to the plain paired card without one.
// Layout (chat-transcript-layout D1): user, peer, and assistant messages are
// MessageRows with author and local time in a gutter (stacked when narrow) and
// one shared body alignment; every other row is an AsideRow in the body
// column. transcriptLayout decides turn and author breaks and day separators;
// nested worker transcripts reuse this component and reflow on their own width.
// Each message row carries its event's original string as `copyText`
// (copy-chat-message-markdown D1): user and assistant `text`, peer `body`.
import type { ChatEvent } from '@shared/chat'
import { workspaceContextLabel } from '@shared/planWorkspace'
import { snippetLabel } from '@shared/sessionSearch'
import type { SendClientMessage, Session } from '@shared/types'
import type { SessionDirectoryEntry } from '@shared/team'
import { Fragment, memo, useMemo, type ReactNode } from 'react'
import Markdown from '../Markdown'
import { AsideRow, DaySeparator, MessageRow, rowSpacing } from './ChatRow'
import ChatTaskRow from './ChatTaskRow'
import ChatWorkerRow from './ChatWorkerRow'
import ParticipantName from './ParticipantName'
import { toolCallDetail } from './toolCallLabel'
import { timeoutAnswerLabels } from './autoAnswerLabels'
import { isVisibleEntry, layoutRows, toolEntries } from './transcriptLayout'
import { chatDayKey } from '../../utils/chatTimeFormat'

type ToolResult = Extract<ChatEvent, { type: 'tool_result' }>

/**
 * `<summary>` whose optional parenthetical detail shrinks instead of wrapping.
 * The chevron and label share one line (see `.chat-summary`); only the detail
 * ellipsizes, with the full value on hover.
 */
function SummaryLabel({ label, detail, failed = false }: { label: string; detail: string | null; failed?: boolean }) {
  return <summary className="chat-summary">
    <span className="shrink-0">{label}</span>
    {detail !== null && <>
      <span className="shrink-0">{'('}</span>
      <span className="min-w-0 truncate" title={detail}>{detail}</span>
      <span className="shrink-0">)</span>
    </>}
    {failed && <span className="shrink-0 text-chat-danger" aria-label="Tool failed">✗</span>}
  </summary>
}

function ChatMessagesView({ events, projectPath, sessionId, sendMessage, connected, archived, historyHasOlder, historyLoading, onLoadEarlier, sessions, directory, onOpenParticipant, agentLabel = 'Claude' }: {
  events: ChatEvent[]; projectPath?: string
  /** The session's agent identity (from its agent kind, never the model string). */
  agentLabel?: string
  /** Present in the app (not in isolated tests): worker rows join the store. */
  sessionId?: string; sendMessage?: SendClientMessage; connected?: boolean
  /** Archived chats never offer a task's Stop control (background tasks D4). */
  archived?: boolean
  /**
   * The history window control (chat-history-window D4): present only for a
   * top-level transcript — nested worker transcripts never page. The button
   * disables while disconnected or loading; when nothing older remains it
   * gives way to the start-of-conversation marker.
   */
  historyHasOlder?: boolean; historyLoading?: boolean; onLoadEarlier?: () => void
  /** Live/archived sessions and the team directory, for naming senders. */
  sessions?: Session[]; directory?: SessionDirectoryEntry[]
  /** Open a participant's chat; omit to disable click-through. */
  onOpenParticipant?: (sessionId: string) => void
}) {
  const names = (id: string | null, senderKind?: 'agent' | 'human' | 'system') =>
    <ParticipantName sessionId={id} senderKind={senderKind} sessions={sessions} directory={directory}
      {...(onOpenParticipant ? { onOpen: onOpenParticipant } : {})} />

  // Layout sees every row (hidden turn triggers still open their turn's
  // spacing, transcriptLayout D1); only visible rows draw.
  const entries = useMemo(() => toolEntries(events), [events])
  const today = chatDayKey(new Date().toISOString())
  const layouts = useMemo(() => layoutRows(entries, { today }), [entries, today])
  // Spacing's "first row" is the first *visible* entry: hidden markers before
  // it must not give it top-of-transcript separation.
  const firstVisibleIndex = useMemo(() => entries.findIndex(entry => isVisibleEntry(entry)), [entries])
  const hasVisibleRows = useMemo(() => entries.some(isVisibleEntry), [entries])

  /** A message row's author, body, and body surface; null for aside rows. */
  const message = (event: ChatEvent): { author: ReactNode; role: 'user' | 'assistant' | 'peer'; body: ReactNode; bodyClassName?: string; copyText: string } | null => {
    switch (event.type) {
      case 'user_message':
        return { author: 'You', role: 'user', copyText: event.text, bodyClassName: 'border border-border bg-elevated px-3 py-2',
          body: <>
            {/* The attachment the server validated for this exact message
                (§6.3): the stored snapshot, never the current selection. */}
            {event.workspaceContext && <p className="mb-1 text-chat-meta text-secondary"
              data-testid="message-workspace-context">{workspaceContextLabel(event.workspaceContext)}</p>}
            <p className="whitespace-pre-wrap break-words text-chat-body">{event.text}</p>
          </> }
      case 'assistant_text':
        return { author: agentLabel, role: 'assistant', copyText: event.text, body: <Markdown content={event.text} /> }
      case 'peer_message':
        return { author: <>Peer · {names(event.senderSession, event.senderKind)}</>, role: 'peer', copyText: event.body,
          bodyClassName: 'border-l-2 border-primary bg-elevated px-3 py-2', body: <>
            <div className="mb-1 flex flex-wrap gap-2 text-chat-meta text-secondary">
              <span>{event.senderGroup ?? 'No group'}</span><span>{event.priority}</span>
              {[...new Set(event.tags)].map(tag => <span key={tag}>#{tag}</span>)}
            </div>
            <p className="break-all text-chat-meta text-secondary">{event.originPath}</p>
            {event.possibleDuplicate && <p role="status" className="text-chat-meta text-chat-danger">Possible duplicate — an already-seen message should be treated as a no-op.</p>}
            {/* A revision notice (task-revision-publication D9) names the revision it announces; the task header is the one delivered. */}
            {event.revisionNotice && <p role="status" className="my-1 text-chat-meta" data-testid="peer-revision-notice">
              Revision {event.revisionNotice.revision} published{event.revisionNotice.rationale ? `: ${event.revisionNotice.rationale}` : ''}
              {event.task && event.task.revision !== event.revisionNotice.revision ? ` · delivered under revision ${event.task.revision}` : ''}
            </p>}
            {event.task && <details className="my-2 border border-border p-2 text-chat-meta" data-testid="peer-task">
              <summary>Task: {event.task.title} · {event.task.status} · revision {event.task.revision}</summary>
              {event.task.worktree && <p className="break-all">Worktree: {event.task.worktree}</p>}
              {event.task.openspecChange && <p>Linked OpenSpec change {event.task.openspecChange} (authoritative)</p>}
              <p className="mt-1 whitespace-pre-wrap">{event.task.direction}</p>
              {event.task.acceptance && <p className="mt-1 whitespace-pre-wrap">Acceptance: {event.task.acceptance}</p>}
              {event.task.journal.map(entry => <p key={`${entry.createdAt}:${entry.author}`} className="mt-1 whitespace-pre-wrap text-secondary">{entry.author}: {entry.text}</p>)}
            </details>}
            <p className="whitespace-pre-wrap break-words text-chat-body">{event.body}</p>
            {event.thread && <details className="mt-2 text-chat-meta"><summary>Earlier messages in this thread</summary>
              {event.thread.map(message => <p key={message.messageId} className="whitespace-pre-wrap">{names(message.senderSession, message.senderKind)}: {message.body}</p>)}
            </details>}
          </> }
      default:
        return null
    }
  }

  /** Assistant entries share one message id per text block (D5): key by position within the message. */
  const blockIndex = new Map<string, number>()
  const keyOf = (event: ChatEvent): string => {
    if (event.type === 'tool_call') return `tool:${event.toolCallId}`
    if (event.type !== 'assistant_text') return event.id
    const message = `${event.turnId}:${event.messageId}`
    const index = blockIndex.get(message) ?? 0
    blockIndex.set(message, index + 1)
    return `assistant:${message}:${index}`
  }

  return <div className="chat-transcript" data-testid="chat-transcript">
    {onLoadEarlier !== undefined && (historyHasOlder === true || hasVisibleRows) && (
      <div className="flex justify-center py-1" data-testid="chat-history-top">
        {historyHasOlder === true
          ? <button type="button" data-testid="chat-load-earlier" className="btn btn-secondary text-chat-meta"
            disabled={connected === false || historyLoading === true} onClick={onLoadEarlier}>
            {historyLoading === true ? 'Loading…' : 'Load earlier messages'}
          </button>
          : <p className="py-1 text-chat-meta text-muted" data-testid="chat-history-start">Beginning of conversation</p>}
      </div>
    )}
    {entries.map(({ event, result }, index) => {
      if (!isVisibleEntry({ event })) return null
      const layout = layouts[index]!
      const spacing = rowSpacing(index === firstVisibleIndex, layout.turnStart, layout.authorStart)
      const key = keyOf(event)
      const day = layout.dayBreak && <DaySeparator label={layout.dayBreak} />
      const row = message(event)
      if (row) {
        return <Fragment key={key}>{day}
          <MessageRow author={row.author} showAuthor={layout.authorStart} at={event.at} spacing={day ? '' : spacing}
            role={row.role} anchorId={event.id} bodyClassName={row.bodyClassName} copyText={row.copyText}>{row.body}</MessageRow>
        </Fragment>
      }
      const node = aside(event, result)
      return node === null ? null : <AsideRow key={key} spacing={spacing}>{node}</AsideRow>
    })}
  </div>

  /** An aside row's content (tools, notices, turn lines); null draws nothing. */
  function aside(event: ChatEvent, result: ToolResult | undefined): ReactNode {
    switch (event.type) {
      case 'tool_call': {
        const detail = toolCallDetail(event.tool, event.input, projectPath)
        const card = <details key={`tool:${event.toolCallId}`} data-anchor-id={`tool:${event.toolCallId}`} className="border-l-2 border-border px-3 text-chat-meta text-secondary">
          <SummaryLabel label={event.tool} detail={detail} failed={result?.isError} />
          <pre className="mt-2 overflow-auto whitespace-pre-wrap">{JSON.stringify(event.input, null, 2)}</pre>
          {result && <pre className="mt-2 overflow-auto whitespace-pre-wrap">{result.output}</pre>}
        </details>
        if (sessionId === undefined || (event.tool !== 'Agent' && event.tool !== 'Task')) {
          // A backgrounded Bash or Monitor joins the task roster by its call
          // id (background tasks D2); everything else stays the plain card.
          if (sessionId !== undefined && (event.tool === 'Bash' || event.tool === 'Monitor')) {
            return <ChatTaskRow key={`tool:${event.toolCallId}`} sessionId={sessionId}
              toolCallId={event.toolCallId} tool={event.tool} fallback={card}
              sendMessage={sendMessage} connected={connected} archived={archived} />
          }
          return card
        }
        return <ChatWorkerRow key={`tool:${event.toolCallId}`} sessionId={sessionId}
          workerId={event.toolCallId} tool={event.tool} fallback={card}
          renderBody={body => <ChatMessages events={body} projectPath={projectPath} agentLabel={agentLabel}
            sessions={sessions} directory={directory} onOpenParticipant={onOpenParticipant} />}
          sendMessage={sendMessage} connected={connected} />
      }
      case 'tool_result': {
        return <details key={event.id} data-anchor-id={`tool:${event.toolCallId}`} className="px-3 text-chat-meta text-secondary">
          <SummaryLabel label="Tool result" detail={null} failed={event.isError} />
          <pre className="mt-2 overflow-auto whitespace-pre-wrap">{event.output}</pre>
        </details>
      }
      case 'approval_request':
        // The searchable approval entry (tool plus input, chat-session-search
        // D2) rendered so its event-id anchor exists for the reveal.
        return <details key={event.id} data-anchor-id={event.id} className="border-l-2 border-border px-3 text-chat-meta text-secondary">
          <SummaryLabel label={snippetLabel('approval', event.tool)} detail={toolCallDetail(event.tool, event.input, projectPath)} />
          <pre className="mt-2 overflow-auto whitespace-pre-wrap">{JSON.stringify(event.input, null, 2)}</pre>
        </details>
      case 'command_output':
        return <div key={event.id} data-anchor-id={event.id} data-testid="chat-command-output" data-chat-role="assistant"
          className="mx-3 border-l-2 border-border px-3 py-2 font-mono text-xs text-secondary">
          <div className="mb-1 text-xs">Command output</div>
          <Markdown content={event.text} />
        </div>
      case 'turn_started': {
        // Agent-started turn (background tasks D5): a muted trigger line in
        // place of the user bubble, naming the task summaries that woke the
        // agent. Unknown causes and empty task lists draw no line at all
        // (quiet unknown turns) — visibility filters them before this case.
        if (!event.trigger || event.trigger.kind !== 'task') return null
        const lines = event.trigger.tasks.map(task => `⟲ ${task.summary ?? `Task ${task.taskId} ${task.status}`}`)
        if (lines.length === 0) return null
        return <p key={event.id} data-testid="turn-trigger" className="text-chat-meta text-muted">
          {lines.map((line, index) => <span key={index} className="block">{line}</span>)}
        </p>
      }
      case 'notice': return <p key={event.id} data-anchor-id={event.id} className="text-chat-meta text-secondary">{event.text}</p>
      case 'error': return <p key={event.id} data-anchor-id={event.id} role="alert" className="text-chat-body text-chat-danger">{event.message}</p>
      case 'turn_interrupted': return <p key={event.id} className="text-chat-meta text-secondary">Turn stopped</p>
      case 'request_resolved': {
        // Who decided: policy grants, the auto-answer deadline, and the
        // user's own calls each render apart (question-auto-answer D6).
        if (event.decidedBy === 'policy') {
          return <p key={event.id} className="text-chat-meta text-secondary" data-testid="auto-approved">
            Auto-approved {event.tool ?? 'tool'}
          </p>
        }
        if (event.decidedBy === 'timeout') {
          return <p key={event.id} className="text-chat-meta text-secondary" data-testid="auto-answered">
            Answered automatically: {timeoutAnswerLabels(event.answers ?? {})}
          </p>
        }
        if (event.decidedBy === 'user' && (event.outcome === 'allowed' || event.outcome === 'denied')) {
          return <p key={event.id} className="text-chat-meta text-secondary">
            {event.outcome === 'allowed' ? 'Allowed' : 'Denied'} by user
          </p>
        }
        return <p key={event.id} className="text-chat-meta text-secondary">Request {event.outcome}</p>
      }
      case 'question_auto_answer_held':
        // Wait for me, or the form's first edit: the deadline is gone and
        // the question waits for the user (D4).
        return <p key={event.id} className="text-chat-meta text-secondary" data-testid="auto-answer-held">Auto-answer held</p>
      case 'turn_completed': return <p key={event.id} className="text-chat-meta text-muted">
        Turn complete · {event.subtype}<TurnCost estimate={event.totalCostUsd} provider={event.providerCostUsd} />
        {event.numTurns !== undefined ? ` · ${event.numTurns} turns` : ''}
      </p>
      default: return null
    }
  }
}

/**
 * A completed turn's cost: the provider-reported charge when the provider
 * streamed one (openrouter-provider D9), else the SDK's list-price estimate.
 */
function TurnCost({ estimate, provider }: { estimate?: number; provider?: number }) {
  if (provider !== undefined) {
    const title = 'Charged by the provider for this turn\'s streamed calls; calls Claude Code did not stream (such as session titles) are not included.'
      + (estimate !== undefined ? ` Claude Code's list-price estimate: $${estimate.toFixed(4)}.` : '')
    return <span title={title} data-testid="turn-provider-cost">{` · $${provider.toFixed(4)}`}</span>
  }
  return estimate !== undefined ? <>{` · $${estimate.toFixed(4)}`}</> : null
}

// Normal prop comparison retains updates to names, archive state, and paths.
const ChatMessages = memo(ChatMessagesView)
export default ChatMessages
