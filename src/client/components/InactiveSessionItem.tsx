import type { AgentSession } from '@shared/types'
import { getPathLeaf } from '../utils/sessionLabel'
import { getSessionIdPrefix } from '../utils/sessionId'
import { formatRelativeTime } from '../utils/time'
import AgentIcon from './AgentIcon'

interface InactiveSessionItemProps {
  session: AgentSession
  showSessionIdPrefix: boolean
  onResume: (sessionId: string) => void
  onPreview: (session: AgentSession) => void
}

export default function InactiveSessionItem({
  session,
  showSessionIdPrefix,
  onResume,
  onPreview,
}: InactiveSessionItemProps) {
  const lastActivity = formatRelativeTime(session.lastActivityAt)
  const directoryLeaf = getPathLeaf(session.projectPath)
  const displayName =
    session.displayName || directoryLeaf || session.sessionId.slice(0, 8)
  const sessionIdPrefix = showSessionIdPrefix
    ? getSessionIdPrefix(session.sessionId)
    : ''

  return (
    <div
      className="group relative cursor-pointer px-3 py-2 transition-colors hover:bg-hover"
      role="button"
      tabIndex={0}
      title="Click to preview"
      onClick={() => onPreview(session)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onPreview(session)
        }
      }}
    >
      {/* Play icon for quick resume - absolutely positioned, appears on hover */}
      <button
        type="button"
        className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted opacity-0 transition-opacity duration-150 hover:text-primary group-hover:opacity-100"
        title="Resume directly"
        onClick={(e) => {
          e.stopPropagation()
          onResume(session.sessionId)
        }}
      >
        ▶
      </button>
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
          {sessionIdPrefix && (
            <span
              className="shrink-0 text-[11px] font-mono text-muted opacity-50"
              title={session.sessionId}
            >
              {sessionIdPrefix}
            </span>
          )}
          <span className="ml-1 w-8 shrink-0 text-right text-xs tabular-nums text-muted">
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
