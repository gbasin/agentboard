// Counter and existing status pill share one accessible, collision-aware popover.
import { useState, useRef, useEffect, type ReactNode, type AnimationEventHandler } from 'react'
import { Popover } from '@base-ui/react/popover'
import type { Session } from '@shared/types'
import type { AgentActivity } from '@shared/activity'
import { formatRelativeTime } from '../utils/time'
import { Users01Icon, XCloseIcon } from './icons'
import { ICON_SIZE } from './controlStyles'

function ActivityLine({ name, activity }: { name: string; activity: AgentActivity }) {
  return (
    <li className="border-t border-border py-2 first:border-0">
      <span className="block break-words text-[12px] font-medium text-primary">{name}</span>
      <span className={`block break-words text-[12px] ${activity.phase === 'blocked' ? 'text-amber-600' : 'text-secondary'}`}>{activity.label}</span>
      {activity.updatedAt && <span className="block text-[11px] text-secondary">Last signal {formatRelativeTime(activity.updatedAt)}</span>}
    </li>
  )
}

interface Props {
  session: Session
  statusClassName: string
  statusContent: ReactNode
  onAnimationEnd?: AnimationEventHandler
}

export default function SessionActivity({ session, statusClassName, statusContent, onAnimationEnd }: Props) {
  const [open, setOpen] = useState(false)
  const counterRef = useRef<HTMLButtonElement>(null)
  const statusRef = useRef<HTMLButtonElement>(null)
  const lastTrigger = useRef<HTMLButtonElement | null>(null)
  const restoreFocus = useRef(true)
  const hasActivity = !!session.activity
  useEffect(() => { if (!hasActivity) setOpen(false) }, [hasActivity])
  const data = session.activity
  if (!data) return <span className={`activity-status relative ${statusClassName}`} onAnimationEnd={onAnimationEnd}>{statusContent}</span>
  const summary = session.status === 'permission' ? 'Needs input (terminal signal)' : data.main.label
  const counts = [
    `${data.running} running`,
    data.blocked > 0 ? `${data.blocked} awaiting input` : '',
    data.unknown > 0 ? `${data.unknown} unknown` : '',
  ].filter(Boolean).join(', ')
  const counterVisible = data.running + data.blocked + data.unknown > 0
  const stop = (event: { stopPropagation(): void }) => event.stopPropagation()

  return (
    <Popover.Root open={open} onOpenChange={(next, details) => {
      restoreFocus.current = details.reason !== 'outside-press' && details.reason !== 'focus-out'
      setOpen(next)
    }} modal={false}>
      {(counterVisible || (open && data.total > 0)) && (
        <Popover.Trigger
          ref={counterRef}
          data-testid="session-activity-counter"
          aria-label={`Subagents: ${counts}`}
          title={`Subagents: ${counts}`}
          className="activity-counter relative inline-flex shrink-0 items-center gap-1 rounded px-1 py-0.5 text-xs tabular-nums text-secondary hover:bg-hover hover:text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
          onPointerDown={stop} onTouchStart={stop} onTouchEnd={stop} onClick={event => { event.stopPropagation(); lastTrigger.current = event.currentTarget }}
        >
          <Users01Icon aria-hidden width={ICON_SIZE.pill} height={ICON_SIZE.pill} />
          <span>{data.running}</span>
          {data.blocked > 0 && <span aria-hidden data-testid="activity-attention" className="h-1 w-1 rounded-full bg-amber-500" />}
          {data.unknown > 0 && <span aria-hidden className="text-muted">?</span>}
        </Popover.Trigger>
      )}
      <Popover.Trigger
        ref={statusRef}
        data-testid="session-activity-status"
        aria-label={`Activity: ${summary}`}
        title={summary}
        className={`activity-status relative ${statusClassName}`}
        onAnimationEnd={onAnimationEnd}
        onPointerDown={stop} onTouchStart={stop} onTouchEnd={stop} onClick={event => { event.stopPropagation(); lastTrigger.current = event.currentTarget }}
      >{statusContent}</Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="end" sideOffset={8} collisionPadding={8} className="z-[70]">
          <Popover.Popup
            data-testid="session-activity-popover"
            initialFocus
            finalFocus={() => restoreFocus.current ? (lastTrigger.current?.isConnected ? lastTrigger.current : statusRef.current) : false}
            className="w-[320px] max-w-[calc(100vw-16px)] max-h-[min(420px,var(--available-height))] overflow-y-auto overscroll-contain rounded-md border border-border bg-elevated p-3 text-primary outline-none"
            onClick={stop} onPointerDown={stop} onTouchStart={stop}
            onContextMenu={event => { event.preventDefault(); event.stopPropagation() }}
            onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); event.preventDefault(); restoreFocus.current = true; setOpen(false) } }}
          >
            <div className="flex items-center justify-between gap-3">
              <Popover.Title className="text-sm font-medium">Agent activity</Popover.Title>
              <Popover.Close aria-label="Close activity" className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded text-secondary hover:bg-hover sm:min-h-6 sm:min-w-6">
                <XCloseIcon aria-hidden width={ICON_SIZE.default} height={ICON_SIZE.default} />
              </Popover.Close>
            </div>
            <Popover.Description className="text-[12px] text-secondary">{counts} · {data.total} total</Popover.Description>
            <ul aria-label="Agent activity" className="mt-2">
              <ActivityLine name="Main session" activity={{ ...data.main, label: summary }} />
              {data.subagents.map(child => <ActivityLine key={child.id} name={child.name} activity={child.activity} />)}
            </ul>
            {data.truncated && <p className="mt-2 text-[12px] text-secondary">Showing {data.subagents.length} of {data.total} subagents. Uninspected activity is unknown.</p>}
            <p className="mt-2 border-t border-border pt-2 text-[11px] text-secondary">From logs. Pending tools may await approval. Silence for 15 minutes means unknown.</p>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  )
}
