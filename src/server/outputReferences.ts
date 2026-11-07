/** Only assistant-presented HTML paths and loopback URLs become previews. */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { normalizeAgentLogEntry } from '../shared/eventTaxonomy'

export type OutputReference = { kind: 'html' | 'localhost' | 'visualization'; target: string; label: string }

export function loopbackUrl(value: string): URL | null {
  try {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return null
    if (!url.port) return null
    return url
  } catch { return null }
}

export function extractOutputReferences(record: unknown): OutputReference[] {
  const result = new Map<string, OutputReference>()
  for (const event of normalizeAgentLogEntry(record)) {
    if (event.kind !== 'message' || event.role !== 'assistant') continue
    // Code examples are not presented outputs. Markdown links and inline paths
    // outside fenced code are evidence; tool calls/results and user text aren't.
    const text = event.text.replace(/```[\s\S]*?```/g, '').replace(/visualize([\s\S]*?)/g, (_marker, json: string) => {
      try {
        const value = JSON.parse(json)
        if (typeof value.path === 'string' && /\.html?$/i.test(value.path) && !value.path.includes('\0')) {
          result.set(value.path, { kind: 'visualization', target: value.path, label: typeof value.title === 'string' ? value.title.slice(0, 200) : path.basename(value.path, path.extname(value.path)).replace(/[-_]/g, ' ') })
        }
      } catch { /* Malformed markers aren't usable outputs. */ }
      return ''
    })
    const add = (raw: string, label?: string) => {
      let target = raw.replace(/^<|>$/g, '')
      const url = loopbackUrl(target)
      if (url) {
        result.set(url.href, { kind: 'localhost', target: url.href, label: label || `App preview · port ${url.port}` })
        return
      }
      target = target.replace(/[:#]L?\d+(?::\d+)?$/, '')
      if (target.startsWith('file://')) {
        try { target = fileURLToPath(target) } catch { return }
      } else {
        if (/^[a-z][a-z\d+.-]*:/i.test(target)) return
        try { target = decodeURIComponent(target) } catch { return }
      }
      if (!/\.html?$/i.test(target) || target.includes('\0') || target.includes('\n')) return
      if (result.get(target)?.kind === 'visualization') return
      result.set(target, { kind: 'html', target, label: label || path.basename(target) })
    }
    for (const m of text.matchAll(/\[([^\]\n]+)\]\((<[^>]+>|[^)\s]+)\)/g)) add(m[2], m[1])
    const rest = text.replace(/\[[^\]\n]+\]\([^\n]*?\)/g, '')
    for (const m of rest.matchAll(/`([^`\n]+)`/g)) add(m[1])
    for (const m of rest.replace(/`[^`]*`/g, '').matchAll(/(?:https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):\d+[^\s<>`"']*|(?:file:\/\/|\/|\.\.?\/)[^\s<>`"']+\.html?)/g)) {
      add(m[0].replace(/[.,;)]+$/, ''))
    }
  }
  return [...result.values()]
}
