import { useEffect, useState, useRef } from 'react'
import { parseAndNormalizeAgentLogLine } from '@shared/eventTaxonomy'
import type { AgentSession } from '@shared/types'
import { formatRelativeTime } from '../utils/time'
import { getPathLeaf } from '../utils/sessionLabel'
import AgentIcon from './AgentIcon'

interface SessionPreviewModalProps {
  session: AgentSession
  onClose: () => void
  onResume: (sessionId: string) => void
}

interface PreviewData {
  sessionId: string
  displayName: string
  projectPath: string
  agentType: string
  lastActivityAt: string
  lines: string[]
}

interface ParsedEntry {
  type: 'user' | 'assistant' | 'system' | 'other'
  content: string
  raw: string
}

function mapNormalizedRoleToEntryType(role: string): ParsedEntry['type'] {
  if (role === 'user') return 'user'
  if (role === 'assistant') return 'assistant'
  if (role === 'system') return 'system'
  return 'other'
}

function parseLogEntry(line: string): ParsedEntry[] {
  const parsed = parseAndNormalizeAgentLogLine(line)
  if (!parsed) return []

  const entries = parsed.events
    .map((event) => ({
      type: mapNormalizedRoleToEntryType(event.role),
      content: event.text.trim(),
      raw: line,
    }))
    .filter((entry) => entry.content.length > 0)

  if (entries.length > 0) {
    return entries
  }

  if (!parsed.parsed && line.trim()) {
    return [{ type: 'other', content: line.trim(), raw: line }]
  }

  return []
}

export default function SessionPreviewModal({
  session,
  onClose,
  onResume,
}: SessionPreviewModalProps) {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [previewData, setPreviewData] = useState<PreviewData | null>(null)
  const [showRaw, setShowRaw] = useState(false)
  const contentRef = useRef<HTMLDivElement>(null)
  const modalRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const fetchPreview = async () => {
      try {
        const response = await fetch('/api/session-preview', {
          headers: {
            'x-session-id': session.sessionId,
          },
        })
        if (!response.ok) {
          const data = await response.json()
          throw new Error(data.error || 'Failed to load preview')
        }
        const data = await response.json() as PreviewData
        setPreviewData(data)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load preview')
      } finally {
        setLoading(false)
      }
    }
    fetchPreview()
  }, [session.sessionId])

  // Scroll to bottom when content loads
  useEffect(() => {
    if (contentRef.current && previewData) {
      contentRef.current.scrollTop = contentRef.current.scrollHeight
    }
  }, [previewData, showRaw])

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      } else if (e.key === 'Enter' && !loading && !error) {
        e.preventDefault()
        onResume(session.sessionId)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose, onResume, session.sessionId, loading, error])

  // Focus trap
  useEffect(() => {
    modalRef.current?.focus()
  }, [])

  const displayName = session.displayName || getPathLeaf(session.projectPath) || session.sessionId.slice(0, 8)
  const lastActivity = formatRelativeTime(session.lastActivityAt)

  const parsedEntries = previewData?.lines.flatMap(parseLogEntry).slice(-30) ?? []

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
          <button
            type="button"
            onClick={() => setShowRaw((v) => !v)}
            className={`btn text-xs ${showRaw ? 'btn-primary' : ''}`}
          >
            {showRaw ? 'Parsed' : 'Raw'}
          </button>
        </div>

        {/* Content */}
        <div
          ref={contentRef}
          className="flex-1 overflow-y-auto p-4 font-mono text-xs"
        >
          {loading && (
            <div className="flex items-center justify-center py-8 text-muted">
              Loading preview...
            </div>
          )}
          {error && (
            <div className="flex items-center justify-center py-8 text-danger">
              {error}
            </div>
          )}
          {previewData && !showRaw && (
            <div className="space-y-2">
              {parsedEntries.length === 0 ? (
                <div className="py-8 text-center text-muted">
                  No readable content found. Try raw view.
                </div>
              ) : (
                parsedEntries.map((entry, i) => (
                  <div
                    key={i}
                    className={`rounded px-2 py-1 ${
                      entry.type === 'user'
                        ? 'bg-blue-500/10 text-blue-400'
                        : entry.type === 'assistant'
                          ? 'bg-emerald-500/10 text-emerald-400'
                          : entry.type === 'system'
                            ? 'bg-yellow-500/10 text-yellow-400'
                            : 'text-muted'
                    }`}
                  >
                    <span className="whitespace-pre-wrap break-words">
                      {entry.content.length > 500
                        ? `${entry.content.slice(0, 500)}...`
                        : entry.content}
                    </span>
                  </div>
                ))
              )}
            </div>
          )}
          {previewData && showRaw && (
            <div className="space-y-1">
              {previewData.lines.slice(-50).map((line, i) => (
                <div key={i} className="whitespace-pre-wrap break-all text-muted">
                  {line || '\u00A0'}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 border-t border-border px-4 py-3">
          <button type="button" onClick={onClose} className="btn">
            Cancel
          </button>
          <button
            type="button"
            onClick={() => onResume(session.sessionId)}
            disabled={loading || !!error}
            className="btn btn-primary"
          >
            Resume
          </button>
        </div>
      </div>
    </div>
  )
}
