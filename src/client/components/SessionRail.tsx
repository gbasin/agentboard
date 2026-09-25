/**
 * SessionRail - desktop-only bottom status rail (tmux-style status line).
 * Left: focused session identity (name, status) then a hairline-separated
 * context group (id, project, host, PR chips).
 * Right: transient segments (copy mode, jump-to-bottom, selection ready),
 * then a hairline before connection status and session actions
 * (wake / hibernate / kill).
 * Always rendered on md+ — with no selection it degrades to session count
 * plus connection status, like tmux's always-on status line.
 */

import type { AgentSession, Session } from '@shared/types'
import type { ConnectionStatus } from '../stores/sessionStore'
import { useSettingsStore } from '../stores/settingsStore'
import { getPathLeaf } from '../utils/sessionLabel'
import { getSessionIdShort } from '../utils/sessionId'
import { statusClass, statusText } from '../utils/sessionStatus'
import ProjectBadge from './ProjectBadge'
import HostBadge from './HostBadge'
import { PrChips } from './PrChips'
import { XCloseIcon } from '@untitledui-icons/react/line'
import Moon01Icon from '@untitledui-icons/react/line/esm/Moon01Icon'
import Copy01Icon from '@untitledui-icons/react/line/esm/Copy01Icon'

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
  isTmuxCopyMode: boolean
  showJumpToBottom: boolean
  onJumpToBottom: () => void
  selectionReady: boolean
  onCopySelection: () => void
  onDismissSelection: () => void
}

const segmentButton =
  'flex h-5 shrink-0 items-center gap-1 rounded px-1.5 text-[11px] font-medium transition-all hover:brightness-110 active:scale-95'
const iconButton =
  'flex h-5 w-5 shrink-0 items-center justify-center rounded transition-all active:scale-95 disabled:cursor-not-allowed disabled:opacity-40'
// Uniform rail pill size so badges line up with the text-[11px] PR chips
const railPill = 'text-[11px]'

const Divider = () => (
  <span aria-hidden className="mx-0.5 h-3.5 w-px shrink-0 bg-border" />
)

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

  const sessionDisplayName = session
    ? session.agentSessionName || session.name
    : ''
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

  const liveContext =
    !!sessionIdPrefix ||
    (showHostBadge && !!session?.host?.trim()) ||
    (showProjectName && !!projectLeaf) ||
    !!(session?.prs && session.prs.length > 0)
  const hibernatingContext =
    (showHostBadge && !!hibernatingSession?.host?.trim()) ||
    (showProjectName && !!hibernatingProjectLeaf) ||
    !!(hibernatingSession?.prs && hibernatingSession.prs.length > 0)

  const hasTransients =
    (selectionReady && !!session) ||
    (isTmuxCopyMode && !!session) ||
    (showJumpToBottom && !!session)

  return (
    <footer className="hidden h-7 shrink-0 select-none items-center justify-between gap-2 border-t border-border bg-elevated px-2 md:flex">
      {/* Left: identity group | context group */}
      <div className="flex min-w-0 items-center gap-1.5">
        {session ? (
          <>
            <span className="max-w-48 truncate text-xs font-medium text-primary">
              {sessionDisplayName}
            </span>
            <span
              className={`shrink-0 text-[11px] ${statusClass[session.status]}`}
            >
              {statusText[session.status]}
            </span>
            {liveContext && <Divider />}
            {sessionIdPrefix && (
              <span
                className="shrink-0 font-mono text-[10px] text-muted"
                title={agentSessionId}
              >
                {sessionIdPrefix}
              </span>
            )}
            {showHostBadge && session.host?.trim() && (
              <HostBadge name={session.host.trim()} className={railPill} />
            )}
            {showProjectName && projectLeaf && (
              <ProjectBadge
                name={projectLeaf}
                fullPath={session.projectPath}
                className={railPill}
              />
            )}
            {session.prs && session.prs.length > 0 && (
              <PrChips prs={session.prs} className="min-w-0 flex-1" />
            )}
          </>
        ) : hibernatingSession ? (
          <>
            <span className="max-w-48 truncate text-xs font-medium text-primary">
              {hibernatingDisplayName}
            </span>
            <span className="shrink-0 rounded-full bg-blue-500/15 px-1.5 py-px text-[9px] font-semibold uppercase tracking-wide text-blue-400">
              Hibernating
            </span>
            {hibernatingContext && <Divider />}
            {showHostBadge && hibernatingSession.host?.trim() && (
              <HostBadge
                name={hibernatingSession.host.trim()}
                className={railPill}
              />
            )}
            {showProjectName && hibernatingProjectLeaf && (
              <ProjectBadge
                name={hibernatingProjectLeaf}
                fullPath={hibernatingSession.projectPath}
                className={railPill}
              />
            )}
            {hibernatingSession.prs && hibernatingSession.prs.length > 0 && (
              <PrChips prs={hibernatingSession.prs} className="min-w-0 flex-1" />
            )}
          </>
        ) : (
          <span className="text-[11px] text-muted">
            {sessionCount} {sessionCount === 1 ? 'session' : 'sessions'}
          </span>
        )}
      </div>

      {/* Right: transient segments | connection, actions */}
      <div className="flex shrink-0 items-center gap-1.5">
        {selectionReady && session && (
          <span className="flex h-5 shrink-0 items-center gap-1 rounded bg-elevated px-1.5 text-[11px] text-secondary">
            Selection ready
            <button
              type="button"
              onClick={onCopySelection}
              className="flex h-4 items-center gap-0.5 rounded bg-accent px-1 text-[10px] font-medium text-white hover:bg-accent/90"
              aria-label="Copy selection"
            >
              <Copy01Icon width={10} height={10} />
              Copy
            </button>
            <button
              type="button"
              onClick={onDismissSelection}
              className="flex h-4 w-4 items-center justify-center rounded text-muted hover:text-primary"
              title="Dismiss"
              aria-label="Dismiss"
            >
              <XCloseIcon width={10} height={10} />
            </button>
          </span>
        )}
        {isTmuxCopyMode && session ? (
          <button
            type="button"
            onClick={onJumpToBottom}
            className={`${segmentButton} border border-amber-400/35 bg-amber-500/20 text-amber-100 hover:bg-amber-500/30`}
            title="Exit tmux copy mode and return to live output"
            aria-label="Exit copy mode"
          >
            <span className="text-[9px] font-semibold uppercase tracking-wide">
              Copy mode
            </span>
            <span aria-hidden className="text-amber-100/40">·</span>
            Exit
          </button>
        ) : showJumpToBottom && session ? (
          <button
            type="button"
            onClick={onJumpToBottom}
            className={`${segmentButton} bg-blue-600/90 text-white hover:bg-blue-600`}
            title="Scroll to bottom"
            aria-label="Scroll to bottom"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="12"
              height="12"
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
          <span className="text-[11px] text-approval">{connectionStatus}</span>
        )}

        {hibernatingSession && (
          <button
            type="button"
            onClick={onWake}
            className={`${segmentButton} bg-accent text-white hover:bg-accent/90`}
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
            <Moon01Icon width={11} height={11} />
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
            <XCloseIcon width={12} height={12} />
          </button>
        )}
      </div>
    </footer>
  )
}
