/** Explicit HTML paths in assistant messages and tool records; never infer prose directories. */
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { asRecord } from '../../shared/json'
import { extractOutputReferences } from '../outputReferences'

export function absoluteOutputPath(ref: string, cwd: string): string {
  return ref.startsWith('~/') ? path.join(os.homedir(), ref.slice(2)) : path.resolve(cwd, ref)
}

export function collectFileEvidence(raw: unknown, previousCwd: string): { cwd: string; paths: string[] } {
  const record = asRecord(raw)
  if (!record) return { cwd: previousCwd, paths: [] }
  const payload = asRecord(record.payload)
  const recordedCwd = record.cwd ?? (['session_meta', 'turn_context'].includes(String(record.type)) ? payload?.cwd : undefined)
  const cwd = typeof recordedCwd === 'string' && path.isAbsolute(recordedCwd) ? recordedCwd : previousCwd
  const paths = new Set<string>()
  const add = (value: string, base = cwd, allowBare = false) => {
    if (value.startsWith('file://')) { try { value = fileURLToPath(value) } catch { return } }
    if (!/\.html?$/i.test(value) || value.includes('\0') || /[\n\r*?{}$]/.test(value) || /^[a-z][a-z\d+.-]*:/i.test(value)) return
    if (!allowBare && !value.includes('/')) return
    paths.add(absoluteOutputPath(value, base))
  }
  const textPaths = (text: string, base = cwd) => {
    // Quoted paths support spaces. Unquoted paths stop at shell/markdown delimiters.
    for (const m of text.matchAll(/[`"']((?:file:\/\/|~\/|\/|\.\.?\/)[^`"'\n]+\.html?)[`"']|(?:^|[\s(=])((?:file:\/\/|~\/|\/|\.\.?\/)[^\s`"'<>;|&()]+\.html?)(?=$|[\s`"'<>;|&().,])/g)) add(m[1] ?? m[2], base)
  }
  for (const ref of extractOutputReferences(raw)) if (ref.kind !== 'localhost') add(ref.target)
  const inputPaths = (input: unknown) => {
    if (typeof input === 'string') { try { input = JSON.parse(input) } catch { textPaths(input as string); return } }
    const args = asRecord(input)
    if (!args) return
    const dir = args.workdir ?? args.cwd
    const base = typeof dir === 'string' ? absoluteOutputPath(dir, cwd) : cwd
    for (const key of ['file_path', 'path', 'filename', 'filePath']) if (typeof args[key] === 'string') add(args[key] as string, base, true)
    for (const key of ['command', 'cmd', 'script', 'input']) if (typeof args[key] === 'string') textPaths(args[key] as string, base)
  }
  const resultPaths = (value: unknown, depth = 0) => {
    if (depth > 8) return
    if (typeof value === 'string') textPaths(value)
    else if (Array.isArray(value)) for (const item of value) resultPaths(item, depth + 1)
    else {
      const obj = asRecord(value)
      if (!obj || obj.type === 'image') return
      for (const key of ['text', 'content', 'output', 'file_path', 'path']) if (key in obj) resultPaths(obj[key], depth + 1)
    }
  }
  const message = asRecord(record.message)
  const content = message?.content ?? record.content
  if (Array.isArray(content)) for (const block of content) {
    const item = asRecord(block)
    if (item?.type === 'tool_use' || item?.type === 'toolCall') inputPaths(item.input ?? item.arguments)
    if (item?.type === 'tool_result') resultPaths(item.content)
  }
  if (record.type === 'tool_use') inputPaths(record.input)
  if (payload?.type === 'function_call') inputPaths(payload.arguments)
  if (payload?.type === 'custom_tool_call') inputPaths(payload.input)
  if (['function_call_output', 'custom_tool_call_output'].includes(String(payload?.type))) resultPaths(payload?.output)
  if (record.type === 'tool_result' || message?.role === 'toolResult' || message?.role === 'tool') resultPaths(content)
  return { cwd, paths: [...paths] }
}
