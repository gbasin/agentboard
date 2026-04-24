import { useCallback, useEffect, useRef, useState } from 'react'
import type { AgentSession } from '@shared/types'
import { formatRelativeTime } from '../utils/time'
import { getPathLeaf } from '../utils/sessionLabel'
import AgentIcon from './AgentIcon'
import SessionPreviewContent from './SessionPreviewContent'

interface SessionPreviewModalProps {
  session: AgentSession
  onClose: () => void
  onResume: (sessionId: string) => void
}

export default function SessionPreviewModal({
  session,
  onClose,
  onResume,
}: SessionPreviewModalProps) {
  const modalRef = useRef<HTMLDivElement>(null)
  const [previewState, setPreviewState] = useState({
    loading: true,
    error: null as string | null,
  })

  // useCallback keeps the keydown effect from re-binding on every render.
  const handleResume = useCallback(() => {
    if (previewState.loading || previewState.error) return
    onResume(session.sessionId)
  }, [previewState.loading, previewState.error, onResume, session.sessionId])

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      } else if (e.key === 'Enter') {
        e.preventDefault()
        handleResume()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [handleResume, onClose])

  // Focus trap
  useEffect(() => {
    modalRef.current?.focus()
  }, [])

  const displayName = session.displayName || getPathLeaf(session.projectPath) || session.sessionId.slice(0, 8)
  const lastActivity = formatRelativeTime(session.lastActivityAt)

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="preview-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        ref={modalRef}
        tabIndex={-1}
        className="flex max-h-[80vh] w-full max-w-2xl flex-col border border-border bg-elevated"
      >
        {/* Header */}
        <div className="flex items-center gap-3 border-b border-border px-4 py-3">
          <AgentIcon
            agentType={session.agentType}
            className="h-5 w-5 shrink-0 text-muted"
          />
          <div className="min-w-0 flex-1">
            <h2 id="preview-title" className="truncate text-sm font-semibold text-primary">
              {displayName}
            </h2>
            <p className="truncate text-xs text-muted" title={session.projectPath}>
              {getPathLeaf(session.projectPath)} &middot; {lastActivity}
            </p>
          </div>
        </div>

        <SessionPreviewContent
          session={session}
          className="m-4 mt-0 flex-1 border-0 bg-transparent"
          onStateChange={setPreviewState}
        />

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 border-t border-border px-4 py-3">
          <button type="button" onClick={onClose} className="btn">
            Cancel
          </button>
          <button
            type="button"
            onClick={handleResume}
            className="btn btn-primary"
            disabled={previewState.loading || !!previewState.error}
          >
            Resume
          </button>
        </div>
      </div>
    </div>
  )
}
