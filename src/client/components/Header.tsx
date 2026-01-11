import type { ConnectionStatus } from '../stores/sessionStore'
import { PlusIcon } from '@untitledui-icons/react/line'
import { getNavShortcutMod } from '../utils/device'

interface HeaderProps {
  connectionStatus: ConnectionStatus
  onNewSession: () => void
}

const statusDot: Record<ConnectionStatus, string> = {
  connected: 'bg-working',
  connecting: 'bg-approval',
  reconnecting: 'bg-approval',
  disconnected: 'bg-danger',
  error: 'bg-danger',
}

export default function Header({
  connectionStatus,
  onNewSession,
}: HeaderProps) {
  return (
    <header className="flex h-10 shrink-0 items-center justify-between border-b border-border bg-elevated px-3">
      <div className="flex items-center gap-2">
        <h1 className="text-sm font-semibold tracking-tight text-primary text-balance">
          AGENTBOARD
        </h1>
        <div className="flex items-center gap-1.5 text-xs text-muted">
          <span className={`h-2 w-2 rounded-full ${statusDot[connectionStatus]}`} />
        </div>
      </div>

      <button
        onClick={onNewSession}
        className="flex h-7 w-7 items-center justify-center rounded bg-accent text-white hover:bg-accent/90 active:scale-95 transition-all"
        title={`New session (${getNavShortcutMod()}N)`}
        aria-label="New session"
      >
        <PlusIcon width={16} height={16} />
      </button>
    </header>
  )
}
