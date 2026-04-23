import { useEffect, useRef, useState } from 'react'
import { parseAndNormalizeAgentLogLine } from '@shared/eventTaxonomy'
import type { AgentSession } from '@shared/types'

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

interface SessionPreviewContentProps {
  session: AgentSession
  className?: string
  onStateChange?: (state: { loading: boolean; error: string | null }) => void
}

export default function SessionPreviewContent({
  session,
  className = '',
  onStateChange,
}: SessionPreviewContentProps) {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [previewData, setPreviewData] = useState<PreviewData | null>(null)
  const [showRaw, setShowRaw] = useState(false)
  const contentRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let cancelled = false

    const fetchPreview = async () => {
      setLoading(true)
      setError(null)
      setPreviewData(null)

      try {
        const response = await fetch(`/api/session-preview/${session.sessionId}`)
        if (!response.ok) {
          const data = await response.json()
          throw new Error(data.error || 'Failed to load preview')
        }
        const data = (await response.json()) as PreviewData
        if (!cancelled) {
          setPreviewData(data)
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load preview')
        }
      } finally {
        if (!cancelled) {
          setLoading(false)
        }
      }
    }

    void fetchPreview()
    return () => {
      cancelled = true
    }
  }, [session.sessionId])

  useEffect(() => {
    onStateChange?.({ loading, error })
  }, [error, loading, onStateChange])

  useEffect(() => {
    if (contentRef.current && previewData) {
      contentRef.current.scrollTop = contentRef.current.scrollHeight
    }
  }, [previewData, showRaw])

  const parsedEntries = previewData?.lines.flatMap(parseLogEntry).slice(-30) ?? []

  return (
    <div className={`flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-elevated ${className}`.trim()}>
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <div>
          <h3 className="text-sm font-semibold text-primary">Recent Preview</h3>
          <p className="text-xs text-muted">Derived from the saved session log.</p>
        </div>
        <button
          type="button"
          onClick={() => setShowRaw((value) => !value)}
          className={`btn text-xs ${showRaw ? 'btn-primary' : ''}`}
        >
          {showRaw ? 'Parsed' : 'Raw'}
        </button>
      </div>

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
                {line || ' '}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
