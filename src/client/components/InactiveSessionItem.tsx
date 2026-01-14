import type { AgentSession } from '@shared/types'
import { getPathLeaf } from '../utils/sessionLabel'
import { getSessionIdSuffix } from '../utils/sessionId'
import { formatRelativeTime } from '../utils/time'
import AgentIcon from './AgentIcon'

interface InactiveSessionItemProps {
  session: AgentSession
  showSessionIdSuffix: boolean
  onResume: (sessionId: string) => void
}

export default function InactiveSessionItem({
  session,
  showSessionIdSuffix,
  onResume,
}: InactiveSessionItemProps) {
  const lastActivity = formatRelativeTime(session.lastActivityAt)
  const directoryLeaf = getPathLeaf(session.projectPath)
  const displayName =
    session.displayName || directoryLeaf || session.sessionId.slice(0, 8)
  const sessionIdSuffix = showSessionIdSuffix
    ? getSessionIdSuffix(session.sessionId)
    : ''

  return (
    <div className="flex items-center justify-between gap-2 px-3 py-2">
      <div className="flex min-w-0 flex-col gap-0.5">
        <div className="flex items-center gap-2 min-w-0">
          <AgentIcon
            agentType={session.agentType}
            className="h-3.5 w-3.5 shrink-0 text-muted"
          />
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-primary">
            {displayName}
          </span>
          {sessionIdSuffix && (
            <span
              className="shrink-0 rounded bg-border px-1.5 py-0.5 text-[10px] font-mono text-muted"
              title={session.sessionId}
            >
              #{sessionIdSuffix}
            </span>
          )}
          <span className="shrink-0 text-xs tabular-nums text-muted">
            {lastActivity}
          </span>
        </div>
        {directoryLeaf && (
          <span
            className="truncate pl-[1.375rem] text-xs text-muted"
            title={session.projectPath}
          >
            {directoryLeaf}
          </span>
        )}
      </div>
      <button
        type="button"
        onClick={() => onResume(session.sessionId)}
        className="btn shrink-0 px-2 py-1 text-xs"
      >
        Resume
      </button>
    </div>
  )
}
