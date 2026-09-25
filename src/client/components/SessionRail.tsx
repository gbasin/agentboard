/**
 * SessionRail - desktop-only bottom status rail (tmux-style status line).
 * Left: hairline-separated segments — name | status | context meta
 * (id, host, project) | PR chips. The id and project badge copy on click,
 * and right-clicking the segments opens the same context menu the
 * session list offers.
 * Right: transient segments (copy mode, jump-to-bottom, selection ready),
 * then a hairline before connection status and session actions
 * (wake / hibernate / kill).
 * Always rendered on md+ — with no selection it degrades to session count
 * plus connection status, like tmux's always-on status line.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { AgentSession, Session } from '@shared/types'
import type { ConnectionStatus } from '../stores/sessionStore'
import { useSettingsStore } from '../stores/settingsStore'
import { getPathLeaf } from '../utils/sessionLabel'
import { getSessionIdShort } from '../utils/sessionId'
import { copyText } from '../utils/copyText'
import { statusClass, statusText } from '../utils/sessionStatus'
import ProjectBadge from './ProjectBadge'
import HostBadge from './HostBadge'
import { PrChips } from './PrChips'
import ContextMenu, { type ContextMenuEntry } from './ContextMenu'
import { XCloseIcon } from '@untitledui-icons/react/line'
import Moon01Icon from '@untitledui-icons/react/line/esm/Moon01Icon'
import Copy01Icon from '@untitledui-icons/react/line/esm/Copy01Icon'
import Edit05Icon from '@untitledui-icons/react/line/esm/Edit05Icon'
import File06Icon from '@untitledui-icons/react/line/esm/File06Icon'
import Hash01Icon from '@untitledui-icons/react/line/esm/Hash01Icon'
import PlayIcon from '@untitledui-icons/react/line/esm/PlayIcon'

interface SessionRailProps {
  session: Session | null
  hibernatingSession: AgentSession | null
  hibernatingDisplayName: string
  /** Matches SessionList's showHostInfo: host badge only when >1 host exists */
  showHostBadge: boolean
  sessionCount: number
  connectionStatus: ConnectionStatus
  isSwitching: boolean
  canControl: boolean
  canHibernate: boolean
  modDisplay: string
  onKill: () => void
  onHibernate: () => void
  onWake: () => void
  /** Rename whichever session the rail is showing (live id or agentSessionId) */
  onRename: (newName: string) => void
  /** Duplicate the live session into a new tmux window */
  onDuplicate?: () => void
  /** Move the hibernating session to history */
  onMoveToHistory?: () => void
  isTmuxCopyMode: boolean
  showJumpToBottom: boolean
  onJumpToBottom: () => void
  selectionReady: boolean
  onCopySelection: () => void
  onDismissSelection: () => void
}

const segmentButton =
  'flex h-7 shrink-0 items-center gap-2 rounded-md px-2.5 text-xs font-medium transition-colors active:scale-95'
// Transient segments (copy mode, jump-to-bottom, selection ready) share one
// quiet bordered pill matching the action buttons; state shows as a colored
// dot plus label, with the action appended after a middot.
const transientPill =
  'flex h-7 shrink-0 items-center gap-2 rounded-md border border-border bg-surface px-2.5 text-xs text-secondary transition-colors hover:bg-hover hover:text-primary'
const iconButton =
  'flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-all active:scale-95 disabled:cursor-not-allowed disabled:opacity-40'
// Pills (badges, PR chips) match the session list's 11px geometry.
const railPill = 'text-[11px]'
const copiedPill =
  'inline-flex shrink-0 items-center rounded-full bg-hover px-1.5 py-0.5 text-[11px] leading-none text-secondary'

const Divider = () => (
  <span aria-hidden className="mx-2 h-5 w-px shrink-0 bg-border" />
)

// Fixed slot sized to the widest status label ("Needs Input") so the
// divider behind it never shifts when status text changes width. ch
// units: this app sets html font-size to 13px, so rem-based widths come
// out 81% of their px expectation — 11ch tracks the glyph count exactly.
const STATUS_SLOT =
  'inline-block w-[11ch] shrink-0 whitespace-nowrap text-left text-xs'

/** Brief "Copied!" swap used by click-to-copy targets (Header.tsx pattern). */
function useCopiedFlag() {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    []
  )
  const markCopied = useCallback(() => {
    setCopied(true)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => setCopied(false), 1500)
  }, [])
  return [copied, markCopied] as const
}

export default function SessionRail({
  session,
  hibernatingSession,
  hibernatingDisplayName,
  showHostBadge,
  sessionCount,
  connectionStatus,
  isSwitching,
  canControl,
  canHibernate,
  modDisplay,
  onKill,
  onHibernate,
  onWake,
  onRename,
  onDuplicate,
  onMoveToHistory,
  isTmuxCopyMode,
  showJumpToBottom,
  onJumpToBottom,
  selectionReady,
  onCopySelection,
  onDismissSelection,
}: SessionRailProps) {
  const showProjectName = useSettingsStore((state) => state.showProjectName)
  const showSessionIdPrefix = useSettingsStore(
    (state) => state.showSessionIdPrefix
  )

  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const [isRenaming, setIsRenaming] = useState(false)
  const [renameValue, setRenameValue] = useState('')
  const renameInputRef = useRef<HTMLInputElement>(null)
  const [idCopied, markIdCopied] = useCopiedFlag()
  const [pathCopied, markPathCopied] = useCopiedFlag()

  const sessionDisplayName = session
    ? session.agentSessionName || session.name
    : ''
  const activeDisplayName = session
    ? sessionDisplayName
    : hibernatingDisplayName
  // Hide the project badge when it just repeats the session name
  const projectLeaf =
    session?.projectPath &&
    getPathLeaf(session.projectPath) !== sessionDisplayName
      ? getPathLeaf(session.projectPath)
      : ''
  const hibernatingProjectLeaf =
    hibernatingSession?.projectPath &&
    getPathLeaf(hibernatingSession.projectPath) !== hibernatingDisplayName
      ? getPathLeaf(hibernatingSession.projectPath)
      : ''
  const agentSessionId = session?.agentSessionId?.trim()
  const sessionIdPrefix =
    showSessionIdPrefix && agentSessionId ? getSessionIdShort(agentSessionId) : null

  // Context group = id / host / project meta; PR chips are their own group
  // and get their own divider, so neither count toward context emptiness.
  const liveContext =
    !!sessionIdPrefix ||
    (showHostBadge && !!session?.host?.trim()) ||
    (showProjectName && !!projectLeaf)
  const hibernatingContext =
    (showHostBadge && !!hibernatingSession?.host?.trim()) ||
    (showProjectName && !!hibernatingProjectLeaf)

  const hasTransients =
    (selectionReady && !!session) ||
    (isTmuxCopyMode && !!session) ||
    (showJumpToBottom && !!session)

  useEffect(() => {
    if (isRenaming && renameInputRef.current) {
      renameInputRef.current.focus()
      renameInputRef.current.select()
    }
  }, [isRenaming])

  const startRename = useCallback(() => {
    setRenameValue(activeDisplayName)
    setIsRenaming(true)
  }, [activeDisplayName])

  const submitRename = useCallback(() => {
    const trimmed = renameValue.trim()
    if (trimmed && trimmed !== activeDisplayName) onRename(trimmed)
    setIsRenaming(false)
  }, [renameValue, activeDisplayName, onRename])

  const openMenu = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setMenu({ x: e.clientX, y: e.clientY })
  }

  const menuItems: ContextMenuEntry[] = []
  if (session) {
    menuItems.push(
      { key: 'rename', label: 'Rename', icon: <Edit05Icon width={14} height={14} />, onSelect: startRename },
      ...(onDuplicate
        ? [{
            key: 'duplicate',
            label: 'Duplicate',
            icon: <Copy01Icon width={14} height={14} />,
            title: 'Create a copy in a new tmux window',
            onSelect: onDuplicate,
          }]
        : []),
      ...(canHibernate
        ? [{
            key: 'hibernate',
            label: 'Hibernate',
            icon: <Moon01Icon width={14} height={14} />,
            title: 'Close the live window and keep this session ready to wake',
            onSelect: onHibernate,
          }]
        : []),
      ...(agentSessionId
        ? [{
            key: 'copy-id',
            label: 'Copy Session ID',
            icon: <Hash01Icon width={14} height={14} />,
            title: agentSessionId,
            onSelect: () => copyText(agentSessionId),
          }]
        : []),
      ...(session.logFilePath
        ? [{
            key: 'copy-log',
            label: 'Copy Log Path',
            icon: <File06Icon width={14} height={14} />,
            title: session.logFilePath,
            onSelect: () => copyText(session.logFilePath!),
          }]
        : [])
    )
    if (canControl) {
      menuItems.push('divider', {
        key: 'kill',
        label: 'Kill Session',
        icon: <XCloseIcon width={14} height={14} />,
        danger: true,
        onSelect: onKill,
      })
    }
  } else if (hibernatingSession) {
    menuItems.push(
      { key: 'wake', label: 'Wake', icon: <PlayIcon width={14} height={14} />, onSelect: onWake },
      { key: 'rename', label: 'Rename', icon: <Edit05Icon width={14} height={14} />, onSelect: startRename },
      {
        key: 'copy-id',
        label: 'Copy Session ID',
        icon: <Hash01Icon width={14} height={14} />,
        title: hibernatingSession.sessionId,
        onSelect: () => copyText(hibernatingSession.sessionId),
      },
      ...(hibernatingSession.logFilePath
        ? [{
            key: 'copy-log',
            label: 'Copy Log Path',
            icon: <File06Icon width={14} height={14} />,
            title: hibernatingSession.logFilePath,
            onSelect: () => copyText(hibernatingSession.logFilePath!),
          }]
        : [])
    )
    if (onMoveToHistory) {
      menuItems.push('divider', {
        key: 'move-to-history',
        label: 'Move to History',
        icon: <XCloseIcon width={14} height={14} />,
        onSelect: onMoveToHistory,
      })
    }
  }

  const renameInput = (
    <input
      ref={renameInputRef}
      type="text"
      value={renameValue}
      onChange={(e) => setRenameValue(e.target.value)}
      onBlur={submitRename}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          submitRename()
        } else if (e.key === 'Escape') {
          setIsRenaming(false)
        }
      }}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.stopPropagation()}
      className="w-40 max-w-48 select-text rounded border border-border bg-surface px-1.5 py-0.5 text-sm font-medium text-primary outline-none focus:border-accent"
      aria-label="Rename session"
    />
  )

  const projectBadge = (leaf: string, fullPath: string) =>
    pathCopied ? (
      <span className={copiedPill}>Copied!</span>
    ) : (
      <button
        type="button"
        onClick={() => {
          copyText(fullPath)
          markPathCopied()
        }}
        className="shrink-0 cursor-pointer"
        title={fullPath}
        aria-label={`Copy project path ${fullPath}`}
      >
        <ProjectBadge name={leaf} fullPath={fullPath} className={railPill} />
      </button>
    )

  return (
    <footer className="hidden h-10 shrink-0 select-none items-center justify-between gap-3 border-t border-border bg-elevated px-4 md:flex">
      {/* Left: hairline-separated segments — name | status | context meta
          (id / host / project) | PR chips. The menu wrapper covers the
          segments so right-clicking a PR chip keeps the link's native menu.
          flex-1 sits on the outer div so PrChips gets a real width to
          measure against (basis-0 in a shrink-to-fit parent collapses every
          chip into "+N") */}
      <div className="flex min-w-0 flex-1 items-center">
        {session ? (
          <>
            <div className="flex min-w-0 items-center" onContextMenu={openMenu}>
              {isRenaming ? (
                renameInput
              ) : (
                <span className="max-w-48 truncate text-sm font-medium text-primary">
                  {sessionDisplayName}
                </span>
              )}
              <Divider />
              <span className={`${STATUS_SLOT} ${statusClass[session.status]}`}>
                {statusText[session.status]}
              </span>
              {liveContext && (
                <>
                  <Divider />
                  <div className="flex items-center gap-2.5">
                    {sessionIdPrefix && (
                      <button
                        type="button"
                        onClick={() => {
                          copyText(agentSessionId!)
                          markIdCopied()
                        }}
                        className="shrink-0 cursor-pointer text-xs text-muted transition-colors hover:text-primary"
                        title={`${agentSessionId} — click to copy`}
                        aria-label="Copy session ID"
                      >
                        {idCopied ? 'Copied!' : sessionIdPrefix}
                      </button>
                    )}
                    {showHostBadge && session.host?.trim() && (
                      <HostBadge name={session.host.trim()} className={railPill} />
                    )}
                    {showProjectName && projectLeaf &&
                      projectBadge(projectLeaf, session.projectPath)}
                  </div>
                </>
              )}
            </div>
            {session.prs && session.prs.length > 0 && (
              <>
                <Divider />
                <PrChips prs={session.prs} className="min-w-0 flex-1" />
              </>
            )}
          </>
        ) : hibernatingSession ? (
          <>
            <div className="flex min-w-0 items-center" onContextMenu={openMenu}>
              {isRenaming ? (
                renameInput
              ) : (
                <span className="max-w-48 truncate text-sm font-medium text-primary">
                  {hibernatingDisplayName}
                </span>
              )}
              <Divider />
              <span className="shrink-0 rounded-full bg-blue-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-blue-400">
                Hibernating
              </span>
              {hibernatingContext && (
                <>
                  <Divider />
                  <div className="flex items-center gap-2.5">
                    {showHostBadge && hibernatingSession.host?.trim() && (
                      <HostBadge
                        name={hibernatingSession.host.trim()}
                        className={railPill}
                      />
                    )}
                    {showProjectName && hibernatingProjectLeaf &&
                      projectBadge(hibernatingProjectLeaf, hibernatingSession.projectPath)}
                  </div>
                </>
              )}
            </div>
            {hibernatingSession.prs && hibernatingSession.prs.length > 0 && (
              <>
                <Divider />
                <PrChips prs={hibernatingSession.prs} className="min-w-0 flex-1" />
              </>
            )}
          </>
        ) : (
          <span className="text-xs text-muted">
            {sessionCount} {sessionCount === 1 ? 'session' : 'sessions'}
          </span>
        )}
      </div>

      {/* Right: transient segments | connection, actions */}
      <div className="flex shrink-0 items-center gap-2.5">
        {selectionReady && session && (
          <span className={`${transientPill} cursor-default`}>
            <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-accent" />
            Selection ready
            <button
              type="button"
              onClick={onCopySelection}
              className="flex h-5 items-center gap-1 rounded px-1 font-medium text-accent hover:text-primary"
              aria-label="Copy selection"
            >
              <Copy01Icon width={12} height={12} />
              Copy
            </button>
            <button
              type="button"
              onClick={onDismissSelection}
              className="flex h-5 w-5 items-center justify-center rounded text-muted hover:text-primary"
              title="Dismiss"
              aria-label="Dismiss"
            >
              <XCloseIcon width={12} height={12} />
            </button>
          </span>
        )}
        {isTmuxCopyMode && session ? (
          <button
            type="button"
            onClick={onJumpToBottom}
            className={transientPill}
            title="Exit tmux copy mode and return to live output"
            aria-label="Exit copy mode"
          >
            <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-amber-400" />
            Copy mode
            <span aria-hidden className="text-muted">·</span>
            <span className="font-medium text-amber-400">Exit</span>
          </button>
        ) : showJumpToBottom && session ? (
          <button
            type="button"
            onClick={onJumpToBottom}
            className={transientPill}
            title="Scroll to bottom"
            aria-label="Scroll to bottom"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M12 5v14M5 12l7 7 7-7" />
            </svg>
            Jump to bottom
          </button>
        ) : null}
        {hasTransients && <Divider />}

        {connectionStatus !== 'connected' && (
          <span className="text-xs text-approval">{connectionStatus}</span>
        )}

        {hibernatingSession && (
          <button
            type="button"
            onClick={onWake}
            className={`${segmentButton} border border-border bg-surface text-secondary hover:bg-hover hover:text-primary`}
          >
            Wake
          </button>
        )}
        {session && canHibernate && (
          <button
            onClick={onHibernate}
            className={`${iconButton} border border-border text-secondary hover:bg-hover hover:text-primary`}
            title="Hibernate session"
            aria-label="Hibernate session"
          >
            <Moon01Icon width={16} height={16} />
          </button>
        )}
        {session && canControl && (
          <button
            disabled={isSwitching}
            onClick={onKill}
            className={`${iconButton} border border-danger/30 bg-danger/10 text-danger hover:bg-danger/20`}
            title={`Kill session (${modDisplay}X)`}
            aria-label="Kill session"
          >
            <XCloseIcon width={16} height={16} />
          </button>
        )}
      </div>

      {menu && menuItems.length > 0 && (
        <ContextMenu
          anchor={menu}
          items={menuItems}
          anchorFromBottom
          onClose={() => setMenu(null)}
        />
      )}
    </footer>
  )
}
