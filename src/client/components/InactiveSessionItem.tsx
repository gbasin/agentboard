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
    <div
      className="group relative cursor-pointer px-3 py-2 transition-colors hover:bg-hover"
      role="button"
      tabIndex={0}
      title="Click to resume"
      onClick={() => onResume(session.sessionId)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onResume(session.sessionId)
        }
      }}
    >
      {/* Play icon - absolutely positioned, appears on hover */}
      <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted opacity-0 transition-opacity duration-150 group-hover:opacity-100">
        ▶
      </span>
      {/* pl-2.5 matches active session content padding (clears status bar space) */}
      <div className="flex flex-col gap-0.5 pl-2.5 transition-[padding] duration-150 group-hover:pr-4">
        {/* Line 1: Icon + Name + Session ID + Time */}
        <div className="flex items-center gap-2">
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
        {/* Line 2: Directory */}
        {directoryLeaf && (
          <span
            className="truncate pl-[1.375rem] text-xs text-muted"
            title={session.projectPath}
          >
            {directoryLeaf}
          </span>
        )}
      </div>
    </div>
  )
}
