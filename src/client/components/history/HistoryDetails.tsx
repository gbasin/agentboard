/** Conversation content and lifecycle details for a saved session. */
import type {
  ArchiveInfo,
  SavedSession,
  SessionEvent,
} from '@shared/persistence'
import SessionPreviewContent from '../SessionPreviewContent'
import { historyButton } from './api'
import { useState } from 'react'
import type { AgentSession } from '@shared/types'
export interface HistoryDetail {
  session: SavedSession
  events: SessionEvent[]
  archive: ArchiveInfo | null
  terminalPreview?: string | null
  terminalPreviewAt?: string | null
  conversations?: AgentSession[]
}
export function HistoryDetails({
  detail,
  busy,
  onBack,
  onRestore,
}: {
  detail: HistoryDetail
  busy: boolean
  onBack: () => void
  onRestore: () => void
}) {
  const [conversationId, setConversationId] = useState(
    detail.session.providerId
  )
  const conversation = detail.conversations?.find(
    (c) => c.sessionId === conversationId
  )
  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-4">
      <button className={historyButton} onClick={onBack}>
        Back to sessions
      </button>
      <h3 className="mt-3 text-lg">{detail.session.name}</h3>
      {!!detail.conversations?.length && (
        <label className="my-3 block text-[12px]">
          Conversation log
          <select
            aria-label="Conversation log"
            className="input mt-1 w-full"
            value={conversationId || ''}
            onChange={(e) => setConversationId(e.target.value)}
          >
            {detail.conversations.map((c) => (
              <option key={c.sessionId} value={c.sessionId}>
                {c.agentType} · {new Date(c.createdAt).toLocaleString()} ·{' '}
                {c.sessionId}
              </option>
            ))}
          </select>
        </label>
      )}
      {detail.archive && (
        <div className="my-3 text-[12px] text-secondary">
          <p>
            Archived {new Date(detail.archive.updatedAt).toLocaleString()} ·{' '}
            {detail.archive.complete
              ? 'Complete log copy'
              : 'Partial log preview'}
            {detail.archive.sourceMissing ? ' · Original log missing' : ''}
          </p>
          <div className="mt-2 flex gap-2">
            <a
              className={historyButton}
              href={`/api/library/${detail.session.id}/archive`}
              download
            >
              Download conversation
            </a>
            {detail.archive.sourceMissing && detail.archive.complete && (
              <button
                className={historyButton}
                disabled={busy}
                onClick={() => onRestore()}
              >
                Restore log and reopen
              </button>
            )}
          </div>
          <p className="mt-2 text-muted">
            Log copies may not include attachments or other provider files.
          </p>
        </div>
      )}
      {detail.terminalPreview && (
        <details className="my-3 text-[12px]">
          <summary>
            Last saved terminal screen
            {detail.terminalPreviewAt
              ? ` · ${new Date(detail.terminalPreviewAt).toLocaleString()}`
              : ''}
          </summary>
          <pre className="mt-2 overflow-x-auto whitespace-pre-wrap border border-border p-2">
            {detail.terminalPreview}
          </pre>
        </details>
      )}
      <details className="my-3 text-[12px]">
        <summary>Session timeline</summary>
        <ul className="mt-2 space-y-1">
          {detail.events.map((e) => (
            <li key={e.id}>
              {new Date(e.createdAt).toLocaleString()} — {e.kind}
              {e.detail ? `: ${e.detail}` : ''}
            </li>
          ))}
        </ul>
      </details>
      {conversation ? (
        <div className="h-[48vh] border border-border">
          <SessionPreviewContent
            key={conversation.sessionId}
            session={conversation}
          />
        </div>
      ) : detail.session.providerId && detail.session.agentType ? (
        <div className="h-[48vh] border border-border">
          <SessionPreviewContent
            session={{
              sessionId: detail.session.providerId,
              displayName: detail.session.name,
              logFilePath: '',
              projectPath: detail.session.projectPath,
              agentType: detail.session.agentType,
              createdAt: detail.session.createdAt,
              lastActivityAt: detail.session.lastActivityAt,
              isActive: detail.session.state === 'running',
            }}
          />
        </div>
      ) : (
        <p className="whitespace-pre-wrap text-sm text-muted">
          {detail.session.preview ||
            'No conversation log yet. The session name and launch details are saved.'}
        </p>
      )}
    </div>
  )
}
