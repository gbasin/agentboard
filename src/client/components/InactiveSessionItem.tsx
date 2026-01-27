import { memo, useEffect, useRef, useState } from 'react'
import AlertTriangleIcon from '@untitledui-icons/react/line/esm/AlertTriangleIcon'
import File06Icon from '@untitledui-icons/react/line/esm/File06Icon'
import Pin02Icon from '@untitledui-icons/react/line/esm/Pin02Icon'
import type { AgentSession } from '@shared/types'
import { getPathLeaf } from '../utils/sessionLabel'
import { getSessionIdShort } from '../utils/sessionId'
import { formatRelativeTime } from '../utils/time'
import AgentIcon from './AgentIcon'
import ProjectBadge from './ProjectBadge'

interface InactiveSessionItemProps {
  session: AgentSession
  showSessionIdPrefix: boolean
  showProjectName: boolean
  showLastUserMessage: boolean
  onResume: (sessionId: string) => void
  onPreview: (session: AgentSession) => void
  onSetPinned?: (sessionId: string, isPinned: boolean) => void
}

export default memo(function InactiveSessionItem({
  session,
  showSessionIdPrefix,
  showProjectName,
  showLastUserMessage,
  onResume,
  onPreview,
  onSetPinned,
}: InactiveSessionItemProps) {
  const lastActivity = formatRelativeTime(session.lastActivityAt)
  const directoryLeaf = getPathLeaf(session.projectPath)
  const displayName =
    session.displayName || directoryLeaf || session.sessionId.slice(0, 8)
  const showDirectory = showProjectName && Boolean(directoryLeaf)
  const showMessage = showLastUserMessage && Boolean(session.lastUserMessage)
  const sessionIdPrefix = showSessionIdPrefix
    ? getSessionIdShort(session.sessionId)
    : ''

  const contextMenuRef = useRef<HTMLDivElement>(null)
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null)

  // Close context menu on click outside or escape
  useEffect(() => {
    if (!contextMenu) return

    const handleClickOutside = (e: MouseEvent | TouchEvent) => {
      if (contextMenuRef.current && !contextMenuRef.current.contains(e.target as Node)) {
        setContextMenu(null)
      }
    }

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setContextMenu(null)
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    document.addEventListener('touchstart', handleClickOutside)
    document.addEventListener('keydown', handleEscape)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
      document.removeEventListener('touchstart', handleClickOutside)
      document.removeEventListener('keydown', handleEscape)
    }
  }, [contextMenu])

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setContextMenu({ x: e.clientX, y: e.clientY })
  }

  return (
    <div
      className="group relative cursor-pointer px-3 py-2 hover:bg-hover"
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
      onContextMenu={handleContextMenu}
    >
      {/* Play icon for quick resume - absolutely positioned, appears on hover */}
      <button
        type="button"
        className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted opacity-0 hover:text-primary group-hover:opacity-100"
        title="Resume directly"
        onClick={(e) => {
          e.stopPropagation()
          onResume(session.sessionId)
        }}
      >
        ▶
      </button>
      {/* pl-2.5 matches active session content padding (clears status bar space) */}
      <div className="flex flex-col gap-0.5 pl-2.5 group-hover:pr-4">
        {/* Line 1: Icon + Name + Session ID + Time */}
        <div className="flex items-center gap-2">
          <AgentIcon
            agentType={session.agentType}
            className="h-3.5 w-3.5 shrink-0 text-muted"
          />
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-primary">
            {displayName}
          </span>
          {session.lastResumeError && (
            <AlertTriangleIcon
              className="h-3 w-3 shrink-0 text-amber-500"
              aria-label="Resume failed"
              title={`Last resume failed: ${session.lastResumeError}`}
            />
          )}
          {session.isPinned && (
            <Pin02Icon
              className="h-3 w-3 shrink-0 text-muted"
              aria-label="Pinned"
              title="Pinned - will auto-resume on server restart"
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
        {/* Line 2: Project badge + last user message */}
        {(showDirectory || showMessage) && (
          <div className="flex flex-wrap items-center gap-1 pl-[1.375rem]">
            {showDirectory && (
              <ProjectBadge name={directoryLeaf!} fullPath={session.projectPath} />
            )}
            {showMessage && (
              <span className="truncate text-xs italic text-muted">
                "{session.lastUserMessage!.length > 200
                  ? session.lastUserMessage!.slice(0, 200) + '…'
                  : session.lastUserMessage}"
              </span>
            )}
          </div>
        )}
      </div>

      {/* Context menu */}
      {contextMenu && (
        <div
          ref={contextMenuRef}
          className="fixed z-50 min-w-[160px] rounded-md border border-border bg-elevated shadow-lg py-1"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          role="menu"
        >
          {onSetPinned && (
            <button
              onClick={(e) => {
                e.stopPropagation()
                setContextMenu(null)
                onSetPinned(session.sessionId, !session.isPinned)
              }}
              className="w-full px-3 py-2 text-left text-sm text-secondary hover:bg-hover hover:text-primary flex items-center gap-2"
              role="menuitem"
              title={session.isPinned ? 'Remove from auto-resume list' : 'Auto-resume on server restart'}
            >
              <Pin02Icon width={14} height={14} />
              {session.isPinned ? 'Unpin' : 'Pin'}
            </button>
          )}
          {session.logFilePath && (
            <button
              onClick={(e) => {
                e.stopPropagation()
                void navigator.clipboard.writeText(session.logFilePath).catch(() => {})
                setContextMenu(null)
              }}
              className="w-full px-3 py-2 text-left text-sm text-secondary hover:bg-hover hover:text-primary flex items-center gap-2"
              role="menuitem"
              title={session.logFilePath}
            >
              <File06Icon width={14} height={14} />
              Copy Log Path
            </button>
          )}
        </div>
      )}
    </div>
  )
})
