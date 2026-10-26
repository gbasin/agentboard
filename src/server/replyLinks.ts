/** Web URLs in visible assistant prose. Never walks tool payloads or reasoning. */
import { fromMarkdown } from 'mdast-util-from-markdown'
import type { Nodes, Definition } from 'mdast'
import { normalizeAgentLogEntry } from '../shared/eventTaxonomy'
import { asRecord } from '../shared/json'

export interface ReplyLink {
  kind: 'link'
  url: string
  label?: string
  sourceText: string
}

// Plain-text URLs can be followed by prose punctuation. Markdown destinations
// are parsed separately so significant trailing punctuation remains intact.
function trimUrl(value: string): string {
  let url = value.replace(/[.,;:!?]+$/, '')
  for (const [open, close] of [['(', ')'], ['[', ']'], ['{', '}']]) {
    while (url.endsWith(close) && url.split(close).length > url.split(open).length) url = url.slice(0, -1)
  }
  return url.replace(/[.,;:!?]+$/, '')
}

function label(node: Nodes): string {
  const stack = [node], parts: string[] = []
  while (stack.length) {
    const current = stack.pop()!
    if ('value' in current) parts.push(current.value)
    else if ('children' in current) stack.push(...[...current.children].reverse())
  }
  return parts.join('').slice(0, 512)
}

export function extractReplyLinks(record: Record<string, unknown>): ReplyLink[] {
  const payload = asRecord(record.payload)
  if ([record.channel, payload?.channel].some(channel => channel === 'analysis' || channel === 'reasoning')) return []
  const found = new Map<string, ReplyLink>()
  for (const event of normalizeAgentLogEntry(record)) {
    if (event.kind !== 'message' || event.role !== 'assistant' || !/https?:/i.test(event.text)) continue
    const text = event.text, tree = fromMarkdown(text)
    const definitions = new Map<string, Definition>()
    const visit = (fn: (node: Nodes) => boolean | void) => {
      const stack: Nodes[] = [tree]
      while (stack.length) {
        const node = stack.pop()!
        if (fn(node) !== false && 'children' in node) stack.push(...[...node.children].reverse())
      }
    }
    visit(node => { if (node.type === 'definition') definitions.set(node.identifier, node) })
    const add = (url: string, title: string | undefined, offset: number) => {
      try {
        const parsed = new URL(url)
        if (!['https:', 'http:'].includes(parsed.protocol) || !parsed.hostname) return
      } catch { return }
      if (found.has(url)) return
      const start = Math.max(0, offset - 240)
      const end = Math.min(text.length, offset + url.length + 500)
      const excerpt = text.slice(start, end).slice(0, 1200)
      found.set(url, { kind: 'link', url, ...(title && title !== url ? { label: title } : {}),
        sourceText: `${start ? '…' : ''}${excerpt}${end < text.length || end - start > 1200 ? '…' : ''}` })
    }
    visit(node => {
      const offset = node.position?.start.offset ?? 0
      if (node.type === 'link' || node.type === 'image') {
        add(node.url, node.type === 'image' ? node.alt ?? undefined : label(node), offset)
        return false // URL-shaped labels must not become a second destination.
      }
      if (node.type === 'linkReference' || node.type === 'imageReference') {
        const target = definitions.get(node.identifier)
        if (target) add(target.url, node.type === 'imageReference' ? node.alt ?? undefined : label(node), offset)
        return false
      }
      if (node.type === 'definition') { add(node.url, undefined, offset); return false }
      if ('value' in node) {
        for (const match of node.value.matchAll(/https?:\/\/[^\s<>"'`]+/gi)) {
          add(trimUrl(match[0]), undefined, offset + match.index)
        }
      }
    })
  }
  return [...found.values()]
}
