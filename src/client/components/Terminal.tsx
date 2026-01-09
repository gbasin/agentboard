import type { Session } from '@shared/types'
import type { ConnectionStatus } from '../stores/sessionStore'
import { useTerminal } from '../hooks/useTerminal'

interface TerminalProps {
  session: Session | null
  connectionStatus: ConnectionStatus
  sendMessage: (message: any) => void
  subscribe: (listener: any) => () => void
  onClose: () => void
}

const statusText: Record<Session['status'], string> = {
  working: 'Working',
  needs_approval: 'Needs Approval',
  waiting: 'Waiting',
  idle: 'Idle',
  unknown: 'Unknown',
}

export default function Terminal({
  session,
  connectionStatus,
  sendMessage,
  subscribe,
  onClose,
}: TerminalProps) {
  const { containerRef } = useTerminal({
    sessionId: session?.id ?? null,
    sendMessage,
    subscribe,
  })

  const isActive = Boolean(session)
  const overlayClasses = isActive
    ? 'fixed inset-0 z-40 flex flex-col bg-[#151210] md:static md:inset-auto md:h-[320px] md:rounded-3xl'
    : 'hidden md:flex md:h-[320px] md:flex-col md:rounded-3xl'

  return (
    <section className={`terminal-shell ${overlayClasses}`}>
      <div className="flex items-center justify-between border-b border-white/10 bg-[#1a1714] px-4 py-3 text-white">
        <div>
          <p className="text-xs uppercase tracking-[0.2em] text-white/60">
            Terminal
          </p>
          <h3 className="text-base font-semibold">
            {session ? session.name : 'Select a session'}
          </h3>
        </div>
        <div className="flex items-center gap-3">
          {session && (
            <span className="rounded-full bg-white/10 px-3 py-1 text-xs font-semibold text-white/80">
              {statusText[session.status]}
            </span>
          )}
          <button
            onClick={onClose}
            className="rounded-full border border-white/20 px-3 py-1 text-xs font-semibold text-white/80 md:hidden"
          >
            Back
          </button>
        </div>
      </div>

      {connectionStatus !== 'connected' && (
        <div className="border-b border-white/10 bg-amber-500/20 px-4 py-2 text-xs text-amber-100">
          Connection {connectionStatus}. Terminal updates may be delayed.
        </div>
      )}

      <div className="relative flex-1 bg-[#151210]">
        <div ref={containerRef} className="h-full w-full" />
        {!session && (
          <div className="absolute inset-0 flex items-center justify-center text-sm text-white/60">
            Choose a session to open its tmux window.
          </div>
        )}
      </div>
    </section>
  )
}
