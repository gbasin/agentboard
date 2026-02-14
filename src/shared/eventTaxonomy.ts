export type NormalizedEventKind =
  | 'message'
  | 'tool_call'
  | 'tool_result'
  | 'result'
  | 'unknown'

export type NormalizedEventRole =
  | 'user'
  | 'assistant'
  | 'system'
  | 'tool'
  | 'other'

export type NormalizedSourceFamily = 'claude' | 'codex' | 'pi' | 'unknown'

export interface NormalizedEventSource {
  family: NormalizedSourceFamily
  rawType: string
  payloadType?: string
}

export interface NormalizedEvent {
  kind: NormalizedEventKind
  role: NormalizedEventRole
  text: string
  source: NormalizedEventSource
}

export interface NormalizedLineParseResult {
  parsed: boolean
  events: NormalizedEvent[]
  raw: unknown
}

const TOOL_RESULT_TYPES = new Set(['tool_result', 'custom_tool_call_output'])
const TEXT_CONTENT_TYPES = new Set(['text', 'input_text', 'output_text'])

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object') return null
  return value as Record<string, unknown>
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function normalizeRole(value: unknown): NormalizedEventRole {
  if (value === 'user') return 'user'
  if (value === 'assistant') return 'assistant'
  if (value === 'system') return 'system'
  if (value === 'tool') return 'tool'
  return 'other'
}

function inferSourceFamily(record: Record<string, unknown>): NormalizedSourceFamily {
  const typeValue = asString(record.type) ?? ''
  const payload = asRecord(record.payload)
  const payloadType = asString(payload?.type) ?? ''
  const source = asString(record.source) ?? asString(payload?.source) ?? ''
  const agent = asString(record.agent) ?? ''

  if (typeValue === 'response_item' || typeValue === 'event_msg') {
    return 'codex'
  }
  if (typeValue === 'tool_use' || typeValue === 'result') {
    return 'claude'
  }
  if (
    typeValue === 'user' ||
    typeValue === 'assistant' ||
    typeValue === 'system'
  ) {
    return 'claude'
  }
  if (payloadType === 'user_message' || payloadType === 'assistant_message') {
    return 'codex'
  }
  if (source.toLowerCase() === 'pi' || agent.toLowerCase() === 'pi') {
    return 'pi'
  }
  return 'unknown'
}

function createSource(record: Record<string, unknown>): NormalizedEventSource {
  const payload = asRecord(record.payload)
  const payloadType = asString(payload?.type)
  return {
    family: inferSourceFamily(record),
    rawType: asString(record.type) ?? 'unknown',
    ...(payloadType ? { payloadType } : {}),
  }
}

function extractTextFromContent(content: unknown): string[] {
  if (!content) return []

  if (typeof content === 'string') {
    return content.trim() ? [content] : []
  }

  if (Array.isArray(content)) {
    const chunks: string[] = []
    for (const item of content) {
      if (typeof item === 'string') {
        if (item.trim()) chunks.push(item)
        continue
      }
      const itemRecord = asRecord(item)
      if (!itemRecord) continue
      const type = asString(itemRecord.type)
      if (type && TOOL_RESULT_TYPES.has(type)) {
        continue
      }
      if (type && !TEXT_CONTENT_TYPES.has(type)) {
        continue
      }
      const text = asString(itemRecord.text)
      if (text && text.trim()) {
        chunks.push(text)
      }
    }
    return chunks
  }

  const contentRecord = asRecord(content)
  if (contentRecord) {
    const type = asString(contentRecord.type)
    if (type && TOOL_RESULT_TYPES.has(type)) {
      return []
    }
    const text = asString(contentRecord.text)
    if (text && text.trim()) {
      return [text]
    }
    return []
  }
  return []
}

function normalizeResponseItemMessage(
  record: Record<string, unknown>,
  source: NormalizedEventSource
): NormalizedEvent[] {
  if (record.type !== 'response_item') return []
  const payload = asRecord(record.payload)
  if (!payload || payload.type !== 'message') return []

  const role = normalizeRole(payload.role)
  return extractTextFromContent(payload.content).map((text) => ({
    kind: 'message' as const,
    role,
    text,
    source,
  }))
}

function normalizeEventMsgMessage(
  record: Record<string, unknown>,
  source: NormalizedEventSource
): NormalizedEvent[] {
  if (record.type !== 'event_msg') return []
  const payload = asRecord(record.payload)
  if (!payload || payload.type !== 'user_message') return []
  const text = asString(payload.message)
  if (!text || !text.trim()) return []

  return [
    {
      kind: 'message',
      role: 'user',
      text,
      source,
    },
  ]
}

function normalizeTopLevelMessage(
  record: Record<string, unknown>,
  source: NormalizedEventSource
): NormalizedEvent[] {
  const typeRole = normalizeRole(record.type)
  const message = asRecord(record.message)

  if (message) {
    const role = normalizeRole(message.role ?? record.type)
    return extractTextFromContent(message.content).map((text) => ({
      kind: 'message' as const,
      role,
      text,
      source,
    }))
  }

  if (!['user', 'assistant', 'system'].includes(typeRole)) {
    return []
  }

  const chunks = [
    ...extractTextFromContent(record.content),
    ...extractTextFromContent(record.text),
  ]
  return chunks.map((text) => ({
    kind: 'message' as const,
    role: typeRole,
    text,
    source,
  }))
}

function normalizeGenericRoleMessage(
  record: Record<string, unknown>,
  source: NormalizedEventSource
): NormalizedEvent[] {
  const role = normalizeRole(record.role)
  if (!['user', 'assistant', 'system'].includes(role)) {
    return []
  }

  const chunks = [
    ...extractTextFromContent(record.content),
    ...extractTextFromContent(record.message),
    ...extractTextFromContent(record.text),
  ]
  return chunks.map((text) => ({
    kind: 'message' as const,
    role,
    text,
    source,
  }))
}

function normalizeToolEvent(
  record: Record<string, unknown>,
  source: NormalizedEventSource
): NormalizedEvent[] {
  const type = asString(record.type)
  const event = asString(record.event)
  if (type !== 'tool_use' && event !== 'tool_use') {
    return []
  }

  const name = asString(record.name) ?? 'tool'
  return [
    {
      kind: 'tool_call',
      role: 'assistant',
      text: `[Tool: ${name}]`,
      source,
    },
  ]
}

function normalizeResultEvent(
  record: Record<string, unknown>,
  source: NormalizedEventSource
): NormalizedEvent[] {
  if (record.type !== 'result') return []
  const result = asString(record.result)
  if (!result || !result.trim()) return []
  return [
    {
      kind: 'result',
      role: 'system',
      text: result,
      source,
    },
  ]
}

function normalizeFallbackMessage(
  record: Record<string, unknown>,
  source: NormalizedEventSource
): NormalizedEvent[] {
  const chunks = [
    ...extractTextFromContent(record.message),
    ...extractTextFromContent(record.content),
    ...extractTextFromContent(record.text),
  ]
  if (chunks.length === 0) return []
  return chunks.map((text) => ({
    kind: 'unknown' as const,
    role: 'other',
    text,
    source,
  }))
}

function normalizeToolResultEvent(
  record: Record<string, unknown>,
  source: NormalizedEventSource
): NormalizedEvent[] {
  const type = asString(record.type)
  const payload = asRecord(record.payload)
  const payloadType = asString(payload?.type)
  if (
    (type && TOOL_RESULT_TYPES.has(type)) ||
    (payloadType && TOOL_RESULT_TYPES.has(payloadType))
  ) {
    return [
      {
        kind: 'tool_result',
        role: 'tool',
        text: '',
        source,
      },
    ]
  }
  return []
}

export function normalizeAgentLogEntry(entry: unknown): NormalizedEvent[] {
  const record = asRecord(entry)
  if (!record) return []

  const source = createSource(record)
  const primary = [
    ...normalizeResponseItemMessage(record, source),
    ...normalizeEventMsgMessage(record, source),
    ...normalizeTopLevelMessage(record, source),
    ...normalizeToolEvent(record, source),
    ...normalizeResultEvent(record, source),
    ...normalizeToolResultEvent(record, source),
  ]

  if (primary.length > 0) return primary
  const generic = normalizeGenericRoleMessage(record, source)
  if (generic.length > 0) return generic
  return normalizeFallbackMessage(record, source)
}

export function parseAndNormalizeAgentLogLine(
  line: string
): NormalizedLineParseResult | null {
  const trimmed = line.trim()
  if (!trimmed) return null

  try {
    const entry = JSON.parse(trimmed)
    return {
      parsed: true,
      events: normalizeAgentLogEntry(entry),
      raw: entry,
    }
  } catch {
    return {
      parsed: false,
      events: [
        {
          kind: 'unknown',
          role: 'other',
          text: trimmed,
          source: {
            family: 'unknown',
            rawType: 'raw_text',
          },
        },
      ],
      raw: line,
    }
  }
}
