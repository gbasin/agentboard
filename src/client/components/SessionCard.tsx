import type { Session } from '@shared/types'

interface SessionCardProps {
  session: Session
  isSelected: boolean
  onSelect: () => void
  onKill: () => void
}

const statusStyles: Record<Session['status'], string> = {
  working: 'bg-working/20 text-ink',
  needs_approval: 'bg-approval/25 text-ink',
  waiting: 'bg-waiting/20 text-ink',
  idle: 'bg-idle/20 text-ink',
  unknown: 'bg-idle/20 text-ink',
}

const statusLabel: Record<Session['status'], string> = {
  working: 'Working',
  needs_approval: 'Needs Approval',
  waiting: 'Waiting',
  idle: 'Idle',
  unknown: 'Unknown',
}

export default function SessionCard({
  session,
  isSelected,
  onSelect,
  onKill,
}: SessionCardProps) {
  const isManaged = session.source === 'managed'
  const lastActivity = formatRelativeTime(session.lastActivity)

  const handleKill = () => {
    if (!isManaged) {
      return
    }
    const confirmed = window.confirm(
      `Kill session "${session.name}"? This will close the tmux window.`
    )
    if (confirmed) {
      onKill()
    }
  }

  return (
    <div
      className={`rounded-2xl border border-white/60 bg-white/80 p-4 shadow-glow transition hover:-translate-y-0.5 ${
        isSelected ? 'ring-2 ring-accent/60' : ''
      } ${session.status === 'needs_approval' ? 'animate-pulse-soft' : ''}`}
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          onSelect()
        }
      }}
    >
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold text-ink">
            {session.name}
          </h3>
          <p className="text-xs text-muted">{session.projectPath}</p>
        </div>
        <span className={`status-pill ${statusStyles[session.status]}`}>
          {statusLabel[session.status]}
        </span>
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
        <span>Active {lastActivity}</span>
        {isManaged ? (
          <button
            onClick={(event) => {
              event.stopPropagation()
              handleKill()
            }}
            className="rounded-full border border-rose-200 bg-rose-50 px-3 py-1 font-semibold text-rose-700 transition hover:-translate-y-0.5"
          >
            Kill
          </button>
        ) : (
          <span className="rounded-full border border-white/70 bg-white/70 px-3 py-1 font-semibold">
            View Only
          </span>
        )}
      </div>
    </div>
  )
}

function formatRelativeTime(iso: string): string {
  const timestamp = Date.parse(iso)
  if (Number.isNaN(timestamp)) {
    return 'unknown'
  }

  const delta = Date.now() - timestamp
  const minutes = Math.floor(delta / 60000)
  if (minutes < 1) {
    return 'just now'
  }
  if (minutes < 60) {
    return `${minutes}m ago`
  }

  const hours = Math.floor(minutes / 60)
  if (hours < 24) {
    return `${hours}h ago`
  }

  const days = Math.floor(hours / 24)
  return `${days}d ago`
}
