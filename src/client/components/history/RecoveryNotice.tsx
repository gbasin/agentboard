/** Surface interrupted sessions even when the live terminal list is empty. */
import { useEffect, useState } from 'react'
import type { PersistenceHealth } from '@shared/persistence'
import { libraryRequest } from './api'
export function RecoveryNotice({ onOpen }: { onOpen: () => void }) {
  const [health, setHealth] = useState<PersistenceHealth | null>(null)
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
    }, 10000)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [])
  if (
    !health ||
    (!health.interrupted && !health.indexError && !health.backupError)
  )
    return null
  return (
    <button
      onClick={onOpen}
      className="w-full border-b border-border bg-approval/10 px-3 py-2 text-left text-[12px] text-approval"
      data-testid="recovery-notice"
    >
      {health.interrupted
        ? `${health.interrupted} interrupted sessions saved. Review and reopen →`
        : 'Session recovery needs attention →'}
    </button>
  )
}
