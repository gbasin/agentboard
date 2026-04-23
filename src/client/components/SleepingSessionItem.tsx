import type { AgentSession } from '@shared/types'
import Pin02Icon from '@untitledui-icons/react/line/esm/Pin02Icon'
import { getPathLeaf } from '../utils/sessionLabel'
import { getSessionIdShort } from '../utils/sessionId'
import { formatRelativeTime } from '../utils/time'
import AgentIcon from './AgentIcon'
import ProjectBadge from './ProjectBadge'

interface SleepingSessionItemProps {
  session: AgentSession
  isSelected: boolean
  showSessionIdPrefix: boolean
  showProjectName: boolean
  showLastUserMessage: boolean
  onSelect: (sessionId: string) => void
}

export default function SleepingSessionItem({
  session,
  isSelected,
  showSessionIdPrefix,
  showProjectName,
  showLastUserMessage,
  onSelect,
}: SleepingSessionItemProps) {
  const lastActivity = formatRelativeTime(session.lastActivityAt)
  const directoryLeaf = getPathLeaf(session.projectPath)
  const displayName =
    session.displayName || directoryLeaf || session.sessionId.slice(0, 8)
  const showDirectory = showProjectName && Boolean(directoryLeaf)
  const showMessage = showLastUserMessage && Boolean(session.lastUserMessage)
  const sessionIdPrefix = showSessionIdPrefix
    ? getSessionIdShort(session.sessionId)
    : ''

  return (
    <div
      className={`group cursor-pointer px-3 py-2 hover:bg-hover ${isSelected ? 'bg-hover' : ''}`}
      role="button"
      tabIndex={0}
      data-testid="sleeping-session-card"
      onClick={() => onSelect(session.sessionId)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onSelect(session.sessionId)
        }
      }}
    >
      <div className="flex flex-col gap-0.5 pl-2.5">
        <div className="flex items-center gap-2">
          <AgentIcon
            agentType={session.agentType}
            className="h-3.5 w-3.5 shrink-0 text-muted"
          />
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-primary">
            {displayName}
          </span>
          <span className="rounded-full bg-blue-500/15 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-blue-400">
            Sleeping
          </span>
          {session.isPinned && (
            <Pin02Icon
              className="h-3 w-3 shrink-0 text-muted"
              aria-label="Pinned"
              title="Pinned"
            />
          )}
          {sessionIdPrefix && (
            <span
              className="shrink-0 text-[11px] font-mono text-muted"
              title={session.sessionId}
            >
              {sessionIdPrefix}
            </span>
          )}
          <span className="ml-1 w-8 shrink-0 text-right text-xs tabular-nums text-muted">
            {lastActivity}
          </span>
        </div>
        {(showDirectory || showMessage) && (
          <div className="flex flex-wrap items-center gap-1 pl-[1.375rem]">
            {showDirectory && (
              <ProjectBadge name={directoryLeaf!} fullPath={session.projectPath} />
            )}
            {showMessage && (
              <span className="line-clamp-2 text-xs italic text-muted">
                "{session.lastUserMessage!.length > 200
                  ? session.lastUserMessage!.slice(0, 200) + '...'
                  : session.lastUserMessage}"
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
