/** Surface interrupted sessions even when the live terminal list is empty. */
import { useEffect, useState } from 'react'
import type { PersistenceHealth } from '@shared/persistence'
import type { ServerMessage, SubscribeServerMessage } from '@shared/types'
import { safeStorage } from '../../utils/storage'
import { libraryRequest } from './api'

// Interruptions are rare (backend crashes, tmux restarts), so a slow
// background poll keeps the notice current without per-client load.
const HEALTH_POLL_MS = 60_000
const DISMISSED_KEY = 'agentboard.recovery-notice.dismissed'

interface Dismissed {
  ids: string[]
  error: string | null
}

function readDismissed(): Dismissed {
  try {
    const raw = safeStorage.getItem(DISMISSED_KEY) as string | null
    if (!raw) return { ids: [], error: null }
    const parsed = JSON.parse(raw) as Partial<Dismissed>
    return {
      ids: Array.isArray(parsed.ids)
        ? parsed.ids.filter((id): id is string => typeof id === 'string')
        : [],
      error: typeof parsed.error === 'string' ? parsed.error : null,
    }
  } catch {
    return { ids: [], error: null }
  }
}

export function RecoveryNotice({
  onOpen,
  subscribe,
}: {
  onOpen: () => void
  subscribe?: SubscribeServerMessage
}) {
  const [health, setHealth] = useState<PersistenceHealth | null>(null)
  const [dismissed, setDismissed] = useState<Dismissed>(readDismissed)

  useEffect(() => {
    let alive = true
    const refresh = () =>
      libraryRequest<PersistenceHealth>('/health')
        .then((h) => {
          if (alive) setHealth(h)
        })
        .catch(() => {})
    void refresh()
    const timer = setInterval(() => {
      void refresh()
    }, HEALTH_POLL_MS)
    // Resume/reconcile broadcasts library-changed; refreshing immediately
    // clears the notice after recovery instead of waiting a full poll.
    const unsubscribe = subscribe?.((message: ServerMessage) => {
      if (message.type === 'library-changed') void refresh()
    })
    return () => {
      alive = false
      clearInterval(timer)
      unsubscribe?.()
    }
  }, [subscribe])

  if (!health) return null
  const dismissedIds = new Set(dismissed.ids)
  const pending = (
    health.interruptedIds ?? (health.interrupted ? ['*'] : [])
  ).filter((id) => !dismissedIds.has(id))
  const errorPending = Boolean(health.error) && health.error !== dismissed.error
  if (!pending.length && !errorPending) return null

  const dismiss = () => {
    const next: Dismissed = {
      ids: health.interruptedIds ?? pending,
      error: health.error,
    }
    try {
      safeStorage.setItem(DISMISSED_KEY, JSON.stringify(next))
    } catch {}
    setDismissed(next)
  }

  return (
    <div
      className="flex w-full items-stretch border-b border-border bg-approval/10 text-[12px] text-approval"
      data-testid="recovery-notice"
    >
      <button onClick={onOpen} className="flex-1 px-3 py-2 text-left">
        {pending.length
          ? `${pending.length} interrupted session${pending.length === 1 ? '' : 's'} saved. Review and reopen →`
          : 'Session recovery needs attention →'}
      </button>
      <button
        onClick={dismiss}
        className="px-3 text-approval/70 hover:text-approval"
        aria-label="Dismiss"
      >
        ✕
      </button>
    </div>
  )
}
