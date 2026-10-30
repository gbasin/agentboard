// Provisional compact treatment; the design gallery offers alternate layouts.
import { useState } from 'react'
import type { Session } from '@shared/types'
import type { AgentActivity } from '@shared/activity'
import { formatRelativeTime } from '../utils/time'
import { ChevronDownIcon, ChevronRightIcon } from './icons'
import { ICON_SIZE } from './controlStyles'

function ActivityLine({ name, activity }: { name: string; activity: AgentActivity }) {
  return (
    <li className="flex flex-col gap-0.5 border-t border-border py-2 first:border-0">
      <span className="truncate text-[12px] font-medium text-primary" title={name}>{name}</span>
      <span className="break-words text-[12px] text-secondary">{activity.label}</span>
      {activity.updatedAt && <span className="text-[11px] text-muted">Last signal {formatRelativeTime(activity.updatedAt)}</span>}
    </li>
  )
}

export default function SessionActivity({ session }: { session: Session }) {
  const [open, setOpen] = useState(false)
  const data = session.activity
  if (!data) return null
  if (data.main.phase === 'idle' && data.total === 0) return null
  const summary = session.status === 'permission' ? 'Needs input' : data.main.label
  const children = [
    data.running > 0 ? `${data.running} running` : '',
    data.blocked > 0 ? `${data.blocked} ${data.blocked === 1 ? 'needs' : 'need'} input` : '',
    data.unknown > 0 ? `${data.unknown} unknown` : '',
    data.running === 0 && data.blocked === 0 && data.unknown === 0 && data.total > 0 ? `${data.total} finished` : '',
  ].filter(Boolean).join(' · ')

  return (
    <div className="min-w-0 pl-[1.375rem]" data-testid="session-activity">
      <button
        type="button"
        aria-expanded={open}
        aria-label={`Activity: ${summary}${children ? `; subagents ${children}` : ''}`}
        className="flex min-h-[44px] sm:min-h-7 w-full items-center gap-2 rounded text-left text-[12px] text-secondary hover:text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        onPointerDown={e => e.stopPropagation()}
        onKeyDown={e => e.stopPropagation()}
        onClick={e => { e.stopPropagation(); setOpen(!open) }}
      >
        <span className="min-w-0 flex-1 truncate">{summary}</span>
        {children && <span title={children} className="max-w-[65%] shrink-0 truncate text-primary tabular-nums">{children}</span>}
        {open ? <ChevronDownIcon aria-hidden="true" width={ICON_SIZE.pill} height={ICON_SIZE.pill} /> : <ChevronRightIcon aria-hidden="true" width={ICON_SIZE.pill} height={ICON_SIZE.pill} />}
      </button>
      {open && (
        <div className="mt-1 rounded border border-border bg-surface px-2" onClick={e => e.stopPropagation()} onPointerDown={e => e.stopPropagation()}>
          <p className="py-2 text-[11px] text-muted" title="Pending tools may be awaiting approval. No lifecycle signal for 15 minutes means unknown.">From logs · updates may lag</p>
          <ul aria-label="Agent activity" className="max-h-64 overflow-y-auto">
            <ActivityLine name="Main session" activity={data.main} />
            {data.subagents.map(child => <ActivityLine key={child.id} name={child.name} activity={child.activity} />)}
          </ul>
          {data.truncated && <p className="py-2 text-[12px] text-secondary">Showing {data.subagents.length} of {data.total} subagents.</p>}
        </div>
      )}
    </div>
  )
}
