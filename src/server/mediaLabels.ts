/** Bounded tool-call labels shared by incremental and indexed media scans. */
import { asRecord, asString } from '../shared/json'
import { mediaLabelKey } from './mediaIndexLabels'
const MAX_PENDING_LABELS = 2000

function pathLeaf(p: string): string {
  const clean = p.replace(/[?#].*$/, '').replace(/\/+$/, '')
  const leaf = clean.slice(clean.lastIndexOf('/') + 1)
  return leaf || p
}

/** "Read · hero.png" when the args carry a path, else just the tool name. */
function toolLabel(name: string | null, args: unknown): string {
  let parsed: unknown = args
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed)
    } catch {
      parsed = null
    }
  }
  const record = asRecord(parsed)
  const pathValue =
    asString(record?.file_path) ??
    asString(record?.filePath) ??
    asString(record?.path) ??
    asString(record?.filename)
  if (pathValue) {
    return `${name ?? 'tool'} · ${pathLeaf(pathValue)}`
  }
  return name ?? 'tool'
}

// Registers tool-call ids -> labels for lines carrying a path argument, so
// tool_result payloads on later lines can be captioned. Covers Claude/Pi
// content blocks, Codex payload calls, devin toolCalls, grok tool_calls.
export function collectToolLabels(
  record: Record<string, unknown>,
  pending: Map<string, string>
): void {
  const register = (id: unknown, label: string) => {
    if (typeof id !== 'string' || !id) return
    const key = mediaLabelKey(id)
    if (!pending.has(key) && pending.size >= MAX_PENDING_LABELS) {
      const oldest = pending.keys().next().value
      if (oldest !== undefined) pending.delete(oldest)
    }
    pending.set(key, label.slice(0, 512))
  }

  const content = asRecord(record.message)?.content
  if (Array.isArray(content)) {
    for (const item of content) {
      const block = asRecord(item)
      if (!block) continue
      const type = asString(block.type)
      if (type !== 'tool_use' && type !== 'toolCall') continue
      register(
        block.id,
        toolLabel(
          asString(block.name),
          block.input ?? block.arguments ?? block.partialJson
        )
      )
    }
  }

  const payload = asRecord(record.payload)
  const payloadType = asString(payload?.type)
  if (
    payloadType === 'function_call' ||
    payloadType === 'custom_tool_call' ||
    payloadType === 'tool_call'
  ) {
    if (!payload) return
    register(
      asString(payload.call_id) ?? asString(payload.id),
      toolLabel(asString(payload.name), payload.arguments ?? payload.input)
    )
  }

  for (const calls of [asRecord(record.message)?.toolCalls, record.tool_calls]) {
    if (!Array.isArray(calls)) continue
    for (const call of calls) {
      const c = asRecord(call)
      register(c?.id, toolLabel(asString(c?.name), c?.arguments))
    }
  }
}

