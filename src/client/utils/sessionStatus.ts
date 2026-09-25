import type { Session } from '@shared/types'

export const statusText: Record<Session['status'], string> = {
  working: 'Working',
  waiting: 'Waiting',
  permission: 'Needs Input',
  unknown: 'Unknown',
}

export const statusClass: Record<Session['status'], string> = {
  working: 'text-working',
  waiting: 'text-waiting',
  permission: 'text-approval',
  unknown: 'text-muted',
}
