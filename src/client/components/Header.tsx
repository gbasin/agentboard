import type { ConnectionStatus } from '../stores/sessionStore'

interface HeaderProps {
  connectionStatus: ConnectionStatus
  needsApprovalCount: number
  onNewSession: () => void
  onRefresh: () => void
}

const statusStyles: Record<ConnectionStatus, string> = {
  connected: 'bg-emerald-500',
  connecting: 'bg-amber-400',
  reconnecting: 'bg-amber-500 animate-pulse-soft',
  disconnected: 'bg-rose-500',
  error: 'bg-rose-500',
}

const statusLabels: Record<ConnectionStatus, string> = {
  connected: 'Connected',
  connecting: 'Connecting',
  reconnecting: 'Reconnecting',
  disconnected: 'Disconnected',
  error: 'Error',
}

export default function Header({
  connectionStatus,
  needsApprovalCount,
  onNewSession,
  onRefresh,
}: HeaderProps) {
  return (
    <header className="flex flex-wrap items-center justify-between gap-4 px-6 py-6">
      <div>
        <div className="flex items-center gap-3">
          <div className="h-3 w-3 rounded-full border border-white/70 bg-accent shadow-glow" />
          <h1 className="text-2xl font-semibold tracking-tight text-ink">
            Agentboard
          </h1>
          {needsApprovalCount > 0 && (
            <span className="status-pill bg-approval/20 text-ink">
              {needsApprovalCount} Needs Approval
            </span>
          )}
        </div>
        <p className="mt-2 text-sm text-muted">
          Live Claude sessions, tmux-backed terminals, and real-time status cues.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2 rounded-full bg-white/70 px-3 py-1 text-xs font-semibold text-muted shadow-glow">
          <span
            className={`h-2.5 w-2.5 rounded-full ${statusStyles[connectionStatus]}`}
          />
          {statusLabels[connectionStatus]}
        </div>
        <button
          onClick={onRefresh}
          className="rounded-full border border-white/70 bg-white/80 px-4 py-2 text-sm font-semibold text-ink shadow-glow transition hover:-translate-y-0.5"
        >
          Refresh
        </button>
        <button
          onClick={onNewSession}
          className="rounded-full bg-accent px-4 py-2 text-sm font-semibold text-white shadow-glow transition hover:-translate-y-0.5"
        >
          + New Session
        </button>
      </div>
    </header>
  )
}
