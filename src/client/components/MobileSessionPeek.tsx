/** Mobile status overview and drawer opener. Never covers terminal text. */
import { useId } from 'react'
import type { Session } from '@shared/types'
import { statusText } from '../utils/sessionStatus'

const colors: Record<Session['status'], string> = {
  working: 'bg-working/45',
  waiting: 'bg-waiting/45',
  permission: 'bg-approval',
  unknown: 'bg-muted/40',
}

interface Props {
  sessions: Session[]
  selectedId: string
  isOpen: boolean
  onOpen: () => void
}

export default function MobileSessionPeek({ sessions, selectedId, isOpen, onOpen }: Props) {
  const descriptionId = useId()
  return (
    <button
      type="button"
      data-testid="session-peek"
      className="absolute inset-y-0 left-0 z-10 flex w-[8px] flex-col gap-1 overflow-hidden bg-elevated py-1 md:hidden focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-[-2px]"
      aria-label="Open session overview"
      aria-expanded={isOpen}
      aria-describedby={descriptionId}
      onClick={onOpen}
    >
      <span id={descriptionId} className="sr-only">
        {sessions.map((s) => `${s.name}: ${statusText[s.status]}${s.id === selectedId ? ', current session' : ''}`).join('; ')}
      </span>
      {sessions.map((s) => (
        <span
          key={s.id}
          data-session-id={s.id}
          data-status={s.status}
          data-selected={s.id === selectedId}
          aria-hidden="true"
          className={`relative min-h-0 max-h-12 w-full flex-1 rounded-r-sm ${colors[s.status]}`}
        >
          {s.id === selectedId && (
            <span className="absolute inset-y-1/3 left-0 w-1 rounded-r-sm bg-primary" />
          )}
        </span>
      ))}
    </button>
  )
}
