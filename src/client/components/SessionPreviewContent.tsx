import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  parseAndNormalizeAgentLogLine,
  inferSourceFamily,
  type NormalizedEventKind,
} from '@shared/eventTaxonomy'
import { asRecord, asString } from '@shared/json'
import type { AgentSession } from '@shared/types'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkBreaks from 'remark-breaks'

const PREVIEW_FETCH_TIMEOUT_MS = 10_000
const PREVIEW_LINE_LIMIT = 200

interface PreviewData {
  sessionId: string
  displayName: string
  projectPath: string
  agentType: string
  lastActivityAt: string
  totalLines: number | null
  startLine: number
  endLine: number
  hasMoreBefore: boolean
  lines: string[]
  lineKeys?: string[]
  startByte?: number
  endByte?: number
}

interface ParsedEntry {
  type: 'user' | 'assistant' | 'system' | 'tool' | 'other'
  kind: NormalizedEventKind
  content: string
  raw: string
  sourceKey: string
  lineNumber: number
  // Index of this entry within its source line. Combined with lineNumber it forms
  // a stable React key that survives prepending earlier history (positional keys
  // would shift and force a full remount, collapsing expanded tool entries).
  seq: number
  exactLineNumber: boolean
  timestamp?: string
}

interface StructuredLogLine {
  sourceKey: string
  lineNumber: number
  exactLineNumber: boolean
  parsed: boolean
  raw: string
  source: string
  type: string
  prominence: 'message' | 'tool' | 'system' | 'plain'
  role?: string
  timestamp?: string
  title: string
  body?: string
  details: Array<{ label: string; value: string }>
}

function extractLogTimestampFromRecord(record: Record<string, unknown>): string | null {
  const payload = asRecord(record.payload)
  const message = asRecord(record.message)
  const timestamp =
    asString(record.timestamp) ??
    asString(payload?.timestamp) ??
    asString(message?.timestamp) ??
    asString(record.created_at) ??
    asString(payload?.created_at) ??
    asString(record.createdAt) ??
    asString(payload?.createdAt)

  return timestamp && !Number.isNaN(Date.parse(timestamp)) ? timestamp : null
}

function formatLogTimestamp(timestamp?: string): string | null {
  if (!timestamp) return null
  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime())) return null

  const now = new Date()
  const sameDay = date.toDateString() === now.toDateString()
  const sameYear = date.getFullYear() === now.getFullYear()

  const options: Intl.DateTimeFormatOptions = sameDay
    ? { hour: 'numeric', minute: '2-digit' }
    : sameYear
      ? { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }
      : { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }

  return new Intl.DateTimeFormat(undefined, options).format(date)
}

function compactJson(value: unknown) {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function extractReadableText(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (typeof item === 'string') return item
        const record = asRecord(item)
        if (!record) return ''
        const type = asString(record.type)
        if (type === 'thinking') return ''
        if (type === 'tool_use') return `[Tool: ${asString(record.name) ?? 'tool'}]`
        const text = asString(record.text) ?? asString(record.content) ?? asString(record.output)
        if (text) return text
        return ''
      })
      .filter(Boolean)
      .join('\n\n')
  }
  const record = asRecord(value)
  if (!record) return compactJson(value)
  const type = asString(record.type)
  if (type === 'thinking') return ''
  if (type === 'tool_use') return `[Tool: ${asString(record.name) ?? 'tool'}]`
  const nestedContent = extractReadableText(record.content)
  if (nestedContent) return nestedContent
  const nestedMessage = extractReadableText(record.message)
  if (nestedMessage) return nestedMessage
  return (
    asString(record.text) ??
    asString(record.output) ??
    ''
  )
}

function inferLogSource(record: Record<string, unknown>): string {
  // Reuse the shared family detection for pi/claude, then layer the transcript
  // badge's display heuristics on top (any payload.type reads as a Codex signal,
  // ahead of Claude type detection — matching the original ordering).
  const family = inferSourceFamily(record)
  if (family === 'pi') return 'pi'
  const type = asString(record.type) ?? ''
  const payloadType = asString(asRecord(record.payload)?.type) ?? ''
  if (type === 'event_msg' || type === 'response_item' || payloadType) return 'codex'
  if (family === 'claude' || type === 'tool_result') return 'claude'
  return 'log'
}

function parseStructuredLogLine(
  line: string,
  sourceKey: string,
  lineNumber: number,
  exactLineNumber: boolean
): StructuredLogLine {
  try {
    const parsed = JSON.parse(line) as unknown
    const record = asRecord(parsed)
    if (!record) {
      return {
        lineNumber,
        sourceKey,
        exactLineNumber,
        parsed: true,
        raw: line,
        source: 'json',
        type: Array.isArray(parsed) ? 'array' : typeof parsed,
        prominence: 'plain',
        title: Array.isArray(parsed) ? 'JSON array' : 'JSON value',
        body: compactJson(parsed),
        details: [],
      }
    }

    const payload = asRecord(record.payload)
    const message = asRecord(record.message)
    const type = asString(record.type) ?? 'unknown'
    const payloadType = asString(payload?.type)
    const role = asString(record.role) ?? asString(message?.role) ?? asString(payload?.role)
    const timestamp = extractLogTimestampFromRecord(record)
    const source = inferLogSource(record)
    const prominence = getStructuredProminence(
      type,
      payloadType ?? undefined,
      role ?? undefined
    )
    const titleParts = [
      payloadType ? `${type} / ${payloadType}` : type,
      role,
    ].filter(Boolean)

    let body =
      extractReadableText(message?.content) ||
      extractReadableText(message?.message) ||
      extractReadableText(payload?.message) ||
      extractReadableText(payload?.content) ||
      extractReadableText(payload?.text) ||
      asString(record.result) ||
      asString(record.name) ||
      extractReadableText(record.content) ||
      extractReadableText(record.text)

    if (type === 'tool_use' && asString(record.name)) {
      body = `[Tool: ${asString(record.name)}]`
    }

    const details = [
      { label: 'uuid', value: asString(record.uuid) ?? '' },
      { label: 'parent', value: asString(record.parentUuid) ?? '' },
      { label: 'session', value: asString(record.sessionId) ?? asString(payload?.session_id) ?? '' },
      { label: 'cwd', value: asString(record.cwd) ?? '' },
      { label: 'metadata', value: compactJson(record.metadata ?? payload?.metadata) },
      { label: 'payload', value: payload ? compactJson(payload) : '' },
    ].filter((detail) => detail.value)

    return {
      lineNumber,
      sourceKey,
      exactLineNumber,
      parsed: true,
      raw: line,
      source,
      type: payloadType ? `${type}:${payloadType}` : type,
      prominence,
      ...(role ? { role } : {}),
      ...(timestamp ? { timestamp } : {}),
      title: titleParts.join(' · '),
      ...(body ? { body } : {}),
      details,
    }
  } catch {
    return {
      lineNumber,
      sourceKey,
      exactLineNumber,
      parsed: false,
      raw: line,
      source: 'text',
      type: 'plain',
      prominence: 'plain',
      title: 'Plain text',
      body: line,
      details: [],
    }
  }
}

function getStructuredProminence(
  type: string,
  payloadType?: string,
  role?: string
): StructuredLogLine['prominence'] {
  if (role === 'user' || role === 'assistant') return 'message'
  if (
    type === 'user' ||
    type === 'assistant' ||
    payloadType === 'user_message' ||
    payloadType === 'assistant_message' ||
    payloadType === 'message'
  ) {
    return 'message'
  }
  if (
    type === 'tool_use' ||
    type === 'tool_result' ||
    type === 'result' ||
    type.includes('tool') ||
    payloadType?.includes('tool') ||
    payloadType === 'function_call' ||
    payloadType === 'function_call_output' ||
    payloadType === 'custom_tool_call_output'
  ) {
    return 'tool'
  }
  if (type === 'plain') return 'plain'
  return 'system'
}

function mapNormalizedRoleToEntryType(role: string): ParsedEntry['type'] {
  if (role === 'user') return 'user'
  if (role === 'assistant') return 'assistant'
  if (role === 'system') return 'system'
  if (role === 'tool') return 'tool'
  return 'other'
}

function parseLogEntry(
  line: string,
  sourceKey: string,
  lineNumber: number,
  exactLineNumber: boolean
): ParsedEntry[] {
  const parsed = parseAndNormalizeAgentLogLine(line)
  if (!parsed) return []
  // Reuse the object parseAndNormalizeAgentLogLine already parsed instead of
  // re-running JSON.parse on the same line.
  const record = parsed.parsed ? asRecord(parsed.raw) : null
  const timestamp = record ? extractLogTimestampFromRecord(record) : null

  const entries = parsed.events
    .map((event, seq) => ({
      type: mapNormalizedRoleToEntryType(event.role),
      kind: event.kind,
      content: event.text.trim(),
      raw: line,
      sourceKey,
      lineNumber,
      seq,
      exactLineNumber,
      ...(timestamp ? { timestamp } : {}),
    }))
    .filter((entry) => entry.content.length > 0)

  if (entries.length > 0) {
    return entries
  }

  if (!parsed.parsed && line.trim()) {
    return [{
      type: 'other',
      kind: 'unknown',
      content: line.trim(),
      raw: line,
      sourceKey,
      lineNumber,
      seq: 0,
      exactLineNumber,
    }]
  }

  return []
}

function lineKey(entry: ParsedEntry) {
  return `${entry.sourceKey}:${entry.seq}`
}

function lineTitle(lineNumber: number, timestamp: string | undefined, exactLineNumber: boolean) {
  if (!exactLineNumber) return timestamp
  return timestamp ? `Line ${lineNumber + 1} · ${timestamp}` : undefined
}

function lineMarker(lineNumber: number, timestamp: string | undefined, exactLineNumber: boolean) {
  const formatted = formatLogTimestamp(timestamp)
  if (formatted) return formatted
  return exactLineNumber ? `Line ${lineNumber + 1}` : 'Entry'
}

function entryLabel(entry: ParsedEntry) {
  if (entry.type === 'user') return 'User'
  if (entry.type === 'assistant') return 'Assistant'
  if (entry.type === 'system') return 'System'
  if (entry.type === 'tool') return 'Tool'
  return 'Log'
}

function entryToneClass(entry: ParsedEntry) {
  if (entry.type === 'user') return 'text-blue-400'
  if (entry.type === 'assistant') return 'text-emerald-400'
  if (entry.type === 'system') return 'text-yellow-400'
  return 'text-muted'
}

function ToolEntry({ entry }: { entry: ParsedEntry }) {
  const [expanded, setExpanded] = useState(false)
  const marker = lineMarker(entry.lineNumber, entry.timestamp, entry.exactLineNumber)
  const label = entry.kind === 'tool_call' ? entry.content : 'Result'

  return (
    <div className="rounded-md border border-border bg-surface/40">
      <button
        type="button"
        className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-xs text-muted hover:text-primary"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
      >
        <span className="min-w-0 truncate">
          <span
            className="mr-2 text-[10px] uppercase tracking-wide text-muted"
            title={lineTitle(entry.lineNumber, entry.timestamp, entry.exactLineNumber)}
          >
            {marker}
          </span>
          {label}
        </span>
        <span className="shrink-0 text-[11px]">{expanded ? 'Hide' : 'Show'}</span>
      </button>
      {expanded && (
        <pre className="max-h-80 overflow-auto border-t border-border px-3 py-2 whitespace-pre-wrap break-words text-xs leading-relaxed text-secondary">
          {entry.content}
        </pre>
      )}
    </div>
  )
}

// Tailwind-styled element overrides for rendered markdown (no typography plugin).
const markdownComponents: Components = {
  p: ({ children }) => <p className="my-2 first:mt-0 last:mb-0">{children}</p>,
  a: ({ children, href }) => (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      className="text-accent underline underline-offset-2 hover:text-primary"
    >
      {children}
    </a>
  ),
  ul: ({ children }) => <ul className="my-2 list-disc space-y-1 pl-5">{children}</ul>,
  ol: ({ children }) => <ol className="my-2 list-decimal space-y-1 pl-5">{children}</ol>,
  li: ({ children }) => <li className="leading-6">{children}</li>,
  h1: ({ children }) => <h1 className="mb-1 mt-3 text-base font-semibold first:mt-0">{children}</h1>,
  h2: ({ children }) => <h2 className="mb-1 mt-3 text-sm font-semibold first:mt-0">{children}</h2>,
  h3: ({ children }) => <h3 className="mb-1 mt-3 text-sm font-semibold first:mt-0">{children}</h3>,
  strong: ({ children }) => <strong className="font-semibold text-primary">{children}</strong>,
  em: ({ children }) => <em className="italic">{children}</em>,
  blockquote: ({ children }) => (
    <blockquote className="my-2 border-l-2 border-border pl-3 text-secondary">{children}</blockquote>
  ),
  hr: () => <hr className="my-3 border-border" />,
  pre: ({ children }) => (
    <pre className="my-2 overflow-x-auto rounded bg-base p-3 text-xs leading-relaxed text-secondary">
      {children}
    </pre>
  ),
  code: ({ className, children }) => {
    const text = String(children ?? '')
    // Block code carries a language-* class (fenced) or spans multiple lines;
    // everything else is inline and gets the chip treatment.
    const isBlock = (className?.includes('language-') ?? false) || text.includes('\n')
    if (isBlock) {
      return <code className={className}>{children}</code>
    }
    return <code className="rounded bg-surface px-1 py-0.5 text-[0.9em] text-primary">{children}</code>
  },
  table: ({ children }) => (
    <div className="my-2 overflow-x-auto">
      <table className="w-full border-collapse text-xs">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border border-border px-2 py-1 text-left font-semibold">{children}</th>
  ),
  td: ({ children }) => <td className="border border-border px-2 py-1 align-top">{children}</td>,
}

function MarkdownMessage({ content }: { content: string }) {
  return (
    <div className="min-w-0 break-words text-sm leading-6 text-primary [overflow-wrap:anywhere]">
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]} components={markdownComponents}>
        {content}
      </ReactMarkdown>
    </div>
  )
}

function TranscriptEntry({ entry }: { entry: ParsedEntry }) {
  // tool_result events normalize to empty text and are dropped by parseLogEntry,
  // so only tool_call and result entries reach the collapsible ToolEntry.
  if (entry.kind === 'tool_call' || entry.kind === 'result') {
    return <ToolEntry entry={entry} />
  }
  const marker = lineMarker(entry.lineNumber, entry.timestamp, entry.exactLineNumber)

  return (
    <article className="grid grid-cols-[5.75rem_minmax(0,1fr)] gap-3 border-b border-border/60 py-4 last:border-b-0 sm:grid-cols-[6.75rem_minmax(0,1fr)]">
      <div className="select-none pt-0.5 text-right">
        <div className={`text-[11px] font-semibold uppercase tracking-wide ${entryToneClass(entry)}`}>
          {entryLabel(entry)}
        </div>
        <div
          className="mt-1 text-[10px] tabular-nums text-muted"
          title={lineTitle(entry.lineNumber, entry.timestamp, entry.exactLineNumber)}
        >
          {marker}
        </div>
      </div>
      <MarkdownMessage content={entry.content} />
    </article>
  )
}

function StructuredLogEntry({ entry }: { entry: StructuredLogLine }) {
  const [bodyExpanded, setBodyExpanded] = useState(false)
  const isLowProminence = entry.prominence === 'system' || entry.prominence === 'plain'
  const collapseBody = entry.prominence === 'tool' && Boolean(entry.body && entry.body.length > 160)
  const timestamp = formatLogTimestamp(entry.timestamp)
  const rowClass = isLowProminence
    ? 'border-border/70 bg-surface/20 opacity-80'
    : entry.prominence === 'tool'
      ? 'border-border bg-surface/35'
      : 'border-border bg-surface/50'
  const sourceClass = entry.prominence === 'message'
    ? 'bg-accent/15 text-accent'
    : 'bg-surface text-muted'

  return (
    <article className={`rounded-md border ${rowClass}`}>
      <div className="grid grid-cols-[5.75rem_minmax(0,1fr)] gap-3 px-3 py-2 sm:grid-cols-[6.75rem_minmax(0,1fr)]">
        <div
          className="select-none text-right text-[11px] tabular-nums text-muted"
          title={lineTitle(entry.lineNumber, entry.timestamp, entry.exactLineNumber)}
        >
          {timestamp ?? (entry.exactLineNumber ? `Line ${entry.lineNumber + 1}` : 'Entry')}
        </div>
        <div className="min-w-0 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${sourceClass}`}>
              {entry.source}
            </span>
            <span className="min-w-0 break-words text-xs font-semibold text-primary">
              {entry.title}
            </span>
          </div>
          {entry.body && !collapseBody && (
            <pre className="whitespace-pre-wrap break-words rounded bg-base px-3 py-2 text-xs leading-relaxed text-secondary">
              {entry.body}
            </pre>
          )}
          {entry.body && collapseBody && (
            <div className="rounded bg-base px-3 py-2">
              <button
                type="button"
                className="select-none text-[11px] text-muted hover:text-primary"
                aria-expanded={bodyExpanded}
                onClick={() => setBodyExpanded((value) => !value)}
              >
                Output
              </button>
              {bodyExpanded && (
                <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-words text-xs leading-relaxed text-secondary">
                  {entry.body}
                </pre>
              )}
            </div>
          )}
          {entry.details.length > 0 && (
            <details className="group">
              <summary className="cursor-pointer select-none text-[11px] text-muted hover:text-primary">
                Details
              </summary>
              <div className="mt-2 space-y-2">
                {entry.details.map((detail) => (
                  <div key={detail.label}>
                    <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted">
                      {detail.label}
                    </div>
                    <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded bg-base px-3 py-2 text-[11px] leading-relaxed text-muted">
                      {detail.value}
                    </pre>
                  </div>
                ))}
              </div>
            </details>
          )}
        </div>
      </div>
    </article>
  )
}

async function fetchPreviewWindow(url: string, signal: AbortSignal): Promise<PreviewData> {
  const response = await fetch(url, { signal })
  if (!response.ok) {
    // Defensive: tolerate non-JSON error bodies (e.g., proxy-injected HTML) so we
    // surface the HTTP status instead of swallowing it in a parse throw.
    let message = `Failed to load preview (HTTP ${response.status})`
    try {
      const data = (await response.json()) as { error?: string }
      if (data?.error) message = data.error
    } catch {
      // Non-JSON — keep default message.
    }
    throw new Error(message)
  }
  return (await response.json()) as PreviewData
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
  const [loadingEarlier, setLoadingEarlier] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [previewData, setPreviewData] = useState<PreviewData | null>(null)
  const [viewMode, setViewMode] = useState<'messages' | 'events'>('messages')
  const contentRef = useRef<HTMLDivElement>(null)
  // Set during loadEarlier so the layout effect keeps scroll position instead of
  // snapping back to the top when older history is appended below.
  const skipScrollResetRef = useRef(false)
  // Atomic in-flight guard: a state flag is read from a stale render closure, so a
  // fast double-click could fire two identical "Load earlier" fetches and prepend
  // the same lines twice. A ref is updated synchronously and can't be stale.
  const loadingEarlierRef = useRef(false)

  useEffect(() => {
    let cancelled = false
    const controller = new AbortController()
    // Safety net so a hung fetch doesn't strand the "Loading preview..." state.
    const timeoutId = setTimeout(() => controller.abort(), PREVIEW_FETCH_TIMEOUT_MS)

    const fetchPreview = async () => {
      setLoading(true)
      setError(null)
      setPreviewData(null)

      try {
        const data = await fetchPreviewWindow(
          `/api/session-preview/${session.sessionId}?limit=${PREVIEW_LINE_LIMIT}`,
          controller.signal
        )
        if (!cancelled) {
          setPreviewData(data)
        }
      } catch (err) {
        if (cancelled) return
        if (controller.signal.aborted) {
          setError('Preview timed out')
        } else {
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
      clearTimeout(timeoutId)
      controller.abort()
    }
  }, [session.sessionId])

  const loadEarlier = async () => {
    if (!previewData || loadingEarlierRef.current || !previewData.hasMoreBefore) return
    loadingEarlierRef.current = true
    // Older history is appended below; suppress the scroll-to-top on this update.
    skipScrollResetRef.current = true

    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), PREVIEW_FETCH_TIMEOUT_MS)
    setLoadingEarlier(true)
    setError(null)

    try {
      const params = new URLSearchParams({ limit: String(PREVIEW_LINE_LIMIT) })
      if (typeof previewData.startByte === 'number') {
        params.set('beforeByte', String(previewData.startByte))
      } else {
        params.set('beforeLine', String(previewData.startLine))
      }
      const data = await fetchPreviewWindow(
        `/api/session-preview/${session.sessionId}?${params.toString()}`,
        controller.signal
      )
      setPreviewData((current) => {
        if (!current) return data
        return {
          ...current,
          totalLines: data.totalLines ?? current.totalLines,
          startLine: data.startLine,
          endLine: current.endLine,
          hasMoreBefore: data.hasMoreBefore,
          startByte: data.startByte,
          endByte: current.endByte,
          lines: [...data.lines, ...current.lines],
          lineKeys: [
            ...(data.lineKeys ?? data.lines.map((_, index) => String(data.startLine + index))),
            ...(current.lineKeys ??
              current.lines.map((_, index) => String(current.startLine + index))),
          ],
        }
      })
    } catch (err) {
      skipScrollResetRef.current = false
      if (controller.signal.aborted) {
        setError('Preview timed out')
      } else {
        setError(err instanceof Error ? err.message : 'Failed to load preview')
      }
    } finally {
      clearTimeout(timeoutId)
      loadingEarlierRef.current = false
      setLoadingEarlier(false)
    }
  }

  useEffect(() => {
    onStateChange?.({ loading, error })
  }, [error, loading, onStateChange])

  useLayoutEffect(() => {
    if (!contentRef.current || !previewData) return
    // Load-earlier appends older history below the fold — keep the user's place.
    if (skipScrollResetRef.current) {
      skipScrollResetRef.current = false
      return
    }
    // Newest-first ordering: open scrolled to the top so the latest is visible.
    contentRef.current.scrollTop = 0
  }, [previewData, viewMode])

  // Parse once per data change instead of on every render (view-mode toggle,
  // load-earlier spinner, etc.). previewData is replaced wholesale when it changes.
  const parsedEntries = useMemo(
    () =>
      previewData?.lines.flatMap((line, index) => {
        const exactLineNumber = previewData.totalLines !== null
        const lineNumber = exactLineNumber
          ? previewData.startLine + index
          : (previewData.startByte ?? 0) + index
        const sourceKey = previewData.lineKeys?.[index] ?? String(lineNumber)
        return parseLogEntry(line, sourceKey, lineNumber, exactLineNumber)
      }) ?? [],
    [previewData]
  )
  const structuredLines = useMemo(
    () =>
      previewData?.lines.map((line, index) => {
        const exactLineNumber = previewData.totalLines !== null
        const lineNumber = exactLineNumber
          ? previewData.startLine + index
          : (previewData.startByte ?? 0) + index
        const sourceKey = previewData.lineKeys?.[index] ?? String(lineNumber)
        return parseStructuredLogLine(line, sourceKey, lineNumber, exactLineNumber)
      }) ?? [],
    [previewData]
  )
  // Reverse-chronological display (newest first). The data model stays oldest-first
  // — pagination and keys are unchanged; only the render order is flipped.
  const messageEntries = useMemo(() => parsedEntries.slice().reverse(), [parsedEntries])
  const eventEntries = useMemo(() => structuredLines.slice().reverse(), [structuredLines])
  const lineRangeLabel = previewData
    ? previewData.totalLines === 0
      ? 'No transcript entries'
      : previewData.totalLines === null
        ? `Showing ${previewData.lines.length} recent log entries`
        : `Showing ${previewData.lines.length} of ${previewData.totalLines} log entries`
    : 'Derived from the saved session log.'

  return (
    <div className={`flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-elevated ${className}`.trim()}>
      <div className="flex flex-col gap-3 border-b border-border px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h3 className="text-sm font-semibold text-primary">Transcript</h3>
          <p className="text-xs text-muted">
            {lineRangeLabel}
          </p>
        </div>
        <div className="inline-flex w-fit rounded-md border border-border bg-base p-0.5">
          <button
            type="button"
            onClick={() => setViewMode('messages')}
            className={`rounded px-2.5 py-1 text-xs transition-colors ${
              viewMode === 'messages'
                ? 'bg-accent text-white'
                : 'text-muted hover:text-primary'
            }`}
            aria-pressed={viewMode === 'messages'}
          >
            Messages
          </button>
          <button
            type="button"
            onClick={() => setViewMode('events')}
            className={`rounded px-2.5 py-1 text-xs transition-colors ${
              viewMode === 'events'
                ? 'bg-accent text-white'
                : 'text-muted hover:text-primary'
            }`}
            aria-pressed={viewMode === 'events'}
          >
            Events
          </button>
        </div>
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
        {previewData && viewMode === 'messages' && (
          <div className="mx-auto flex w-full max-w-4xl flex-col">
            {messageEntries.length === 0 ? (
              <div className="py-8 text-center text-muted">
                No readable messages found. Try Events.
              </div>
            ) : (
              messageEntries.map((entry) => (
                <TranscriptEntry key={lineKey(entry)} entry={entry} />
              ))
            )}
            {previewData.hasMoreBefore && (
              <button
                type="button"
                className="btn mx-auto mt-3"
                onClick={loadEarlier}
                disabled={loadingEarlier}
              >
                {loadingEarlier ? 'Loading...' : 'Load earlier'}
              </button>
            )}
          </div>
        )}
        {previewData && viewMode === 'events' && (
          <div className="mx-auto flex w-full max-w-5xl flex-col gap-2">
            <div className="space-y-2">
              {eventEntries.map((entry) => (
                <StructuredLogEntry
                  key={`${entry.lineNumber}:${entry.type}:${entry.raw.slice(0, 24)}`}
                  entry={entry}
                />
              ))}
            </div>
            {previewData.hasMoreBefore && (
              <button
                type="button"
                className="btn mx-auto"
                onClick={loadEarlier}
                disabled={loadingEarlier}
              >
                {loadingEarlier ? 'Loading...' : 'Load earlier'}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
