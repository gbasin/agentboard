import type { Session } from '@shared/types'
import SessionCard from './SessionCard'

interface DashboardProps {
  sessions: Session[]
  selectedSessionId: string | null
  loading: boolean
  error: string | null
  onSelect: (sessionId: string) => void
  onKill: (sessionId: string) => void
}

const columns = [
  {
    key: 'working',
    title: 'Working',
    subtitle: 'Claude is actively processing.',
    accent: 'border-working/40 bg-working/10',
  },
  {
    key: 'needs_approval',
    title: 'Needs Approval',
    subtitle: 'Awaiting tool approval.',
    accent: 'border-approval/50 bg-approval/15',
  },
  {
    key: 'waiting',
    title: 'Waiting',
    subtitle: 'Turn completed, waiting for you.',
    accent: 'border-waiting/40 bg-waiting/10',
  },
  {
    key: 'idle',
    title: 'Idle',
    subtitle: 'No recent activity.',
    accent: 'border-idle/40 bg-idle/10',
  },
] as const

export default function Dashboard({
  sessions,
  selectedSessionId,
  loading,
  error,
  onSelect,
  onKill,
}: DashboardProps) {
  const grouped: Record<string, Session[]> = {
    working: [],
    needs_approval: [],
    waiting: [],
    idle: [],
  }

  for (const session of sessions) {
    const status = session.status === 'unknown' ? 'idle' : session.status
    grouped[status]?.push(session)
  }

  for (const key of Object.keys(grouped)) {
    grouped[key].sort((a, b) => {
      return Date.parse(b.lastActivity) - Date.parse(a.lastActivity)
    })
  }

  return (
    <section className="px-6 pb-6">
      {error && (
        <div className="mb-4 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700 shadow-glow">
          {error}
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {columns.map((column, index) => (
          <div
            key={column.key}
            className={`glass-card flex min-h-[220px] flex-col gap-3 rounded-3xl border p-4 ${column.accent} animate-rise`}
            style={{ animationDelay: `${index * 60}ms` }}
          >
            <div>
              <h2 className="text-lg font-semibold text-ink">
                {column.title}
              </h2>
              <p className="text-xs uppercase tracking-[0.2em] text-muted">
                {column.subtitle}
              </p>
            </div>

            {loading ? (
              <div className="space-y-3">
                {[0, 1].map((value) => (
                  <div
                    key={value}
                    className="h-20 rounded-2xl bg-white/60"
                  />
                ))}
              </div>
            ) : grouped[column.key].length === 0 ? (
              <div className="rounded-2xl border border-dashed border-white/70 bg-white/40 px-4 py-6 text-sm text-muted">
                No sessions here yet.
              </div>
            ) : (
              grouped[column.key].map((session) => (
                <SessionCard
                  key={session.id}
                  session={session}
                  isSelected={session.id === selectedSessionId}
                  onSelect={() => onSelect(session.id)}
                  onKill={() => onKill(session.id)}
                />
              ))
            )}
          </div>
        ))}
      </div>
    </section>
  )
}
