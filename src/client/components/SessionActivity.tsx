// Counter and existing status pill share one accessible, collision-aware popover.
import { useState, useRef, useEffect, type ReactNode, type AnimationEventHandler } from 'react'
import { Popover } from '@base-ui/react/popover'
import type { Session } from '@shared/types'
import type { AgentActivity } from '@shared/activity'
import { formatRelativeTime } from '../utils/time'
import { XCloseIcon } from './icons'
import { ICON_SIZE } from './controlStyles'

const activityDot: Record<AgentActivity['phase'], string> = {
  model: 'bg-working',
  tool: 'bg-working',
  blocked: 'bg-approval',
  idle: 'bg-secondary',
  unknown: 'border border-secondary',
}

function ActivityLine({ name, activity }: { name: string; activity: AgentActivity }) {
  return (
    <li className="flex gap-3 py-3">
      <span aria-hidden className={`mt-[5px] size-[6px] shrink-0 rounded-full ${activityDot[activity.phase]}`} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <span className="min-w-0 break-words text-[13px] font-medium text-primary [overflow-wrap:anywhere]">{name}</span>
          {activity.updatedAt && <span title="Last activity signal" className="shrink-0 text-[11px] tabular-nums text-secondary"><span className="sr-only">Last signal </span>{formatRelativeTime(activity.updatedAt)}</span>}
        </div>
        <span className="mt-1 block break-words text-[12px] leading-relaxed text-secondary [overflow-wrap:anywhere]">{activity.label}</span>
      </div>
    </li>
  )
}

interface Props {
  session: Session
  statusClassName: string
  statusContent: ReactNode
  children: (counter: ReactNode, status: ReactNode) => ReactNode
  onAnimationEnd?: AnimationEventHandler
}

export default function SessionActivity({ session, statusClassName, statusContent, onAnimationEnd, children }: Props) {
  const [open, setOpen] = useState(false)
  const counterRef = useRef<HTMLButtonElement>(null)
  const statusRef = useRef<HTMLButtonElement>(null)
  const lastTrigger = useRef<HTMLButtonElement | null>(null)
  const restoreFocus = useRef(true)
  const hasActivity = !!session.activity
  useEffect(() => { if (!hasActivity) setOpen(false) }, [hasActivity])
  const data = session.activity
  if (!data) return children(null, <span className={`activity-status relative ${statusClassName}`} onAnimationEnd={onAnimationEnd}>{statusContent}</span>)
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
      {children((counterVisible || (open && data.total > 0)) ? (
        <Popover.Trigger
          ref={counterRef}
          data-testid="session-activity-counter"
          aria-label={`Subagents: ${counts}`}
          title={`Subagents: ${counts}`}
          className="activity-counter relative inline-flex shrink-0 items-center min-h-[24px] min-w-[24px] justify-center rounded text-[11px] leading-none tabular-nums text-secondary hover:bg-hover hover:text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
          onPointerDown={stop} onTouchStart={stop} onTouchEnd={stop} onClick={event => { event.stopPropagation(); lastTrigger.current = event.currentTarget }}
        >
          <span>+{data.running}</span>
          {data.blocked > 0 && <span aria-hidden data-testid="activity-attention" className="absolute -right-1 top-0.5 h-1 w-1 rounded-full bg-amber-500" />}
        </Popover.Trigger>
      ) : null,
      <Popover.Trigger
        ref={statusRef}
        data-testid="session-activity-status"
        aria-label={`Activity: ${summary}`}
        title={summary}
        className={`activity-status relative focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent ${statusClassName}`}
        onAnimationEnd={onAnimationEnd}
        onPointerDown={stop} onTouchStart={stop} onTouchEnd={stop} onClick={event => { event.stopPropagation(); lastTrigger.current = event.currentTarget }}
      >{statusContent}</Popover.Trigger>)}
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="end" sideOffset={8} collisionPadding={8} className="z-[70]">
          <Popover.Popup
            data-testid="session-activity-popover"
            initialFocus
            finalFocus={() => restoreFocus.current ? (lastTrigger.current?.isConnected ? lastTrigger.current : statusRef.current) : false}
            className="w-[360px] max-w-[calc(100vw-16px)] max-h-[min(480px,var(--available-height))] overflow-y-auto overscroll-contain rounded-xl border border-border bg-elevated p-4 text-primary outline-none"
            onClick={stop} onPointerDown={stop} onTouchStart={stop}
            onContextMenu={event => { event.preventDefault(); event.stopPropagation() }}
            onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); event.preventDefault(); restoreFocus.current = true; setOpen(false) } }}
          >
            <div className="flex items-center justify-between gap-3">
              <Popover.Title className="text-sm font-medium">Agent activity</Popover.Title>
              <Popover.Close aria-label="Close activity" className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded text-secondary hover:bg-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent sm:min-h-6 sm:min-w-6">
                <XCloseIcon aria-hidden width={ICON_SIZE.default} height={ICON_SIZE.default} />
              </Popover.Close>
            </div>
            <Popover.Description className="sr-only">Activity for the main session and its subagents.</Popover.Description>
            <ul aria-label="Main session" className="mt-1">
              <ActivityLine name="Main session" activity={{ ...data.main, phase: session.status === 'permission' ? 'blocked' : data.main.phase, label: summary }} />
            </ul>
            {data.total > 0 && (
              <section aria-label="Subagents" className="mt-1 border-t border-border pt-3">
                <div className="flex items-baseline justify-between gap-3">
                  <h3 className="text-[12px] font-medium">Subagents <span className="ml-1 tabular-nums text-secondary">{data.total}</span></h3>
                  <span className="text-[11px] tabular-nums text-secondary">{data.running} running</span>
                </div>
                {(data.blocked > 0 || data.unknown > 0) && (
                  <p className="mt-1 text-[11px] text-secondary">
                    {[data.blocked > 0 ? `${data.blocked} awaiting input` : '', data.unknown > 0 ? `${data.unknown} unknown` : ''].filter(Boolean).join(' · ')}
                  </p>
                )}
                <ul aria-label="Subagent activity" className="mt-1">
                  {data.subagents.map(child => <ActivityLine key={child.id} name={child.name} activity={child.activity} />)}
                </ul>
                {data.truncated && <p className="pb-3 text-[12px] leading-relaxed text-secondary">Showing {data.subagents.length} of {data.total} subagents. Uninspected activity is unknown.</p>}
              </section>
            )}
            <details className="mt-1 border-t border-border pt-3 text-[11px] leading-relaxed text-secondary">
              <summary className="cursor-pointer rounded hover:text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent">How activity is detected</summary>
              <p className="mt-2">From logs. Pending tools may await approval. Silence for 15 minutes means unknown.</p>
            </details>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  )
}
