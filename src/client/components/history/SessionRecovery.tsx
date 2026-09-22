/** Minimal recovery surface: lists interrupted sessions and reopens them. */
import { useCallback, useEffect, useState } from 'react'
import type { Session, ServerMessage } from '@shared/types'
import type { HistoryPage, SavedSession } from '@shared/persistence'
import { libraryRequest, historyButton } from './api'
import { createOperationId } from '../../utils/operationId'

interface SessionRecoveryProps {
  open: boolean
  subscribe: (listener: (message: ServerMessage) => void) => () => void
  onClose: () => void
  onOpenSession: (session: Session) => void
}

function age(iso: string) {
  const minutes = Math.floor((Date.now() - Date.parse(iso)) / 60000)
  if (minutes < 60) return `${Math.max(1, minutes)}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

export default function SessionRecovery({
  open,
  subscribe,
  onClose,
  onOpenSession,
}: SessionRecoveryProps) {
  const [sessions, setSessions] = useState<SavedSession[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  const refresh = useCallback(
    (signal?: AbortSignal) => {
      libraryRequest<HistoryPage>('?state=interrupted&limit=100', 'GET', undefined, signal)
        .then((page) => {
          setSessions(page.sessions)
          setError(null)
        })
        .catch((e) => {
          if (!signal?.aborted) setError(String(e))
        })
    },
    []
  )

  useEffect(() => {
    if (!open) return
    const controller = new AbortController()
    refresh(controller.signal)
    const unsubscribe = subscribe((message) => {
      if (message.type === 'library-changed') refresh()
    })
    return () => {
      controller.abort()
      unsubscribe()
    }
  }, [open, refresh, subscribe])

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  const reopen = async (saved: SavedSession) => {
    setBusyId(saved.id)
    try {
      const live = await libraryRequest<Session>(`/${saved.id}/resume`, 'POST', {
        operationId: createOperationId(),
      })
      onOpenSession(live)
      onClose()
    } catch (e) {
      setError(String(e))
      refresh()
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg rounded border border-border bg-elevated shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold text-primary">Session recovery</h2>
          <button
            onClick={onClose}
            className="text-secondary hover:text-primary"
            aria-label="Close"
          >
            ✕
          </button>
        </div>
        <div className="max-h-[60vh] overflow-y-auto p-2">
          {error && (
            <div className="m-2 rounded border border-error/40 bg-error/10 px-3 py-2 text-[12px] text-error">
              {error}
            </div>
          )}
          {!sessions.length && !error && (
            <p className="p-4 text-center text-[12px] text-secondary">
              No interrupted sessions.
            </p>
          )}
          {sessions.map((saved) => (
            <div
              key={saved.id}
              className="flex items-center gap-3 rounded px-3 py-2 hover:bg-hover"
            >
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] text-primary">
                  {saved.name}
                </div>
                <div className="truncate text-[11px] text-secondary">
                  {saved.projectPath} · {age(saved.lastActivityAt)}
                  {saved.error ? ` · ${saved.error}` : ''}
                </div>
              </div>
              <button
                className={historyButton}
                disabled={busyId === saved.id}
                onClick={() => void reopen(saved)}
              >
                Reopen
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
