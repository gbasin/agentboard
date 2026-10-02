import { useEffect, useRef, useState } from 'react'
import type { AgentSession } from '@shared/types'
import { AlertTriangleIcon, Edit05Icon, File06Icon, Moon01Icon, PlayIcon, XCloseIcon } from './icons'
import { ICON_SIZE, MOBILE_ROW_TARGET_CLASS } from './controlStyles'
import { copyText } from '../utils/copyText'
import { getPathLeaf } from '../utils/sessionLabel'
import { getSessionIdShort } from '../utils/sessionId'
import { formatRelativeTime } from '../utils/time'
import { useMenuViewportFit } from '../hooks/useMenuViewportFit'
import AgentIcon from './AgentIcon'
import ProjectBadge from './ProjectBadge'

interface HibernatingSessionItemProps {
  session: AgentSession
  isSelected: boolean
  showSessionIdPrefix: boolean
  showProjectName: boolean
  showLastUserMessage: boolean
  onSelect: (sessionId: string) => void
  onWake?: (sessionId: string) => void
  onRename?: (sessionId: string, newName: string) => void
  onMoveToHistory?: (sessionId: string) => void
}

export default function HibernatingSessionItem({
  session,
  isSelected,
  showSessionIdPrefix,
  showProjectName,
  showLastUserMessage,
  onSelect,
  onWake,
  onRename,
  onMoveToHistory,
}: HibernatingSessionItemProps) {
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
  const inputRef = useRef<HTMLInputElement>(null)
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null)
  const contextMenuPosition = useMenuViewportFit(contextMenuRef, contextMenu)
  const [isEditing, setIsEditing] = useState(false)
  const [editValue, setEditValue] = useState(displayName)

  useEffect(() => {
    setEditValue(displayName)
  }, [displayName])

  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [isEditing])

  const handleSubmit = () => {
    const trimmed = editValue.trim()
    if (trimmed && trimmed !== displayName) {
      onRename?.(session.sessionId, trimmed)
    }
    setIsEditing(false)
  }

  const handleEditKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      handleSubmit()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      setEditValue(displayName)
      setIsEditing(false)
    }
  }

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
      className={`group relative cursor-pointer px-3 py-2 hover:bg-hover ${MOBILE_ROW_TARGET_CLASS} ${isSelected ? 'bg-hover' : ''}`}
      role="button"
      tabIndex={0}
      data-testid="hibernating-session-card"
      data-session-id={session.sessionId}
      onClick={() => onSelect(session.sessionId)}
      onContextMenu={handleContextMenu}
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
          {isEditing ? (
            <input
              ref={inputRef}
              type="text"
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              onBlur={handleSubmit}
              onKeyDown={handleEditKeyDown}
              onClick={(e) => e.stopPropagation()}
              className="min-w-0 flex-1 rounded border border-border bg-surface px-1.5 py-0.5 text-sm font-medium text-primary outline-none focus:border-accent"
            />
          ) : (
            <span className="min-w-0 flex-1 truncate text-sm font-medium text-primary">
              {displayName}
            </span>
          )}
          <Moon01Icon
            width={ICON_SIZE.pill} height={ICON_SIZE.pill}
            className="shrink-0 text-muted"
            aria-label="Hibernating"
            title="Hibernating"
          />
          {session.lastResumeError && (
            <AlertTriangleIcon
              width={ICON_SIZE.pill} height={ICON_SIZE.pill}
              className="shrink-0 text-amber-500"
              aria-label="Wake failed"
              title={`Last wake failed: ${session.lastResumeError}`}
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
      {contextMenu && (
        <div
          ref={contextMenuRef}
          className="fixed z-50 min-w-[160px] rounded-md border border-border bg-elevated shadow-lg py-1"
          style={contextMenuPosition ?? undefined}
          role="menu"
        >
          {onWake && (
            <button
              onClick={(e) => {
                e.stopPropagation()
                setContextMenu(null)
                onWake(session.sessionId)
              }}
              className="w-full px-3 py-2 text-left text-sm text-secondary hover:bg-hover hover:text-primary flex items-center gap-2"
              role="menuitem"
            >
              <PlayIcon width={ICON_SIZE.default} height={ICON_SIZE.default} />
              Wake
            </button>
          )}
          {onRename && (
            <button
              onClick={(e) => {
                e.stopPropagation()
                setContextMenu(null)
                setIsEditing(true)
              }}
              className="w-full px-3 py-2 text-left text-sm text-secondary hover:bg-hover hover:text-primary flex items-center gap-2"
              role="menuitem"
            >
              <Edit05Icon width={ICON_SIZE.default} height={ICON_SIZE.default} />
              Rename
            </button>
          )}
          {session.logFilePath && (
            <button
              onClick={(e) => {
                e.stopPropagation()
                setContextMenu(null)
                copyText(session.logFilePath)
              }}
              className="w-full px-3 py-2 text-left text-sm text-secondary hover:bg-hover hover:text-primary flex items-center gap-2"
              role="menuitem"
              title={session.logFilePath}
            >
              <File06Icon width={ICON_SIZE.default} height={ICON_SIZE.default} />
              Copy Log Path
            </button>
          )}
          {onMoveToHistory && (
            <>
              <div className="my-1 border-t border-border" />
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  setContextMenu(null)
                  onMoveToHistory(session.sessionId)
                }}
                className="w-full px-3 py-2 text-left text-sm text-danger hover:bg-danger/10 flex items-center gap-2"
                role="menuitem"
              >
                <XCloseIcon width={ICON_SIZE.default} height={ICON_SIZE.default} />
                Move to History
              </button>
            </>
          )}
        </div>
      )}
    </div>
  )
}
