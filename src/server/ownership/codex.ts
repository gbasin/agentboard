// Codex identity evidence from pane-local processes and writable transcript descriptors.
import path from 'node:path'

export interface ProcessIdentity {
  pid: number
  ppid: number
  started: string
  command: string
}
export interface PaneIdentity { window: string; pane: string; pid: number; serverPid?: number }
export interface OpenFile { pid: number; name: string; access: string; type: string }
export interface TranscriptIdentity { id: string; source: unknown }
export type OwnershipResult = { window: string; pane: string } & (
  | { status: 'resolved'; pid: number; sessionId: string; transcript: string }
  | { status: 'unresolved'; reason: string }
)

export function parseProcesses(text: string): ProcessIdentity[] {
  return text.split('\n').flatMap(line => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+\S+\s+\d+)\s+(.+)$/)
    return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), started: match[3], command: match[4] }] : []
  })
}

// lsof -F0pftan: NUL terminates fields; newlines separate process/file records.
export function parseOpenFiles(text: string): OpenFile[] {
  const files: OpenFile[] = []
  let pid = 0
  let file: OpenFile | undefined
  for (const raw of text.split('\0')) {
    const field = raw.replace(/^\n/, '')
    const value = field.slice(1)
    switch (field[0]) {
      case 'p': pid = Number(value); file = undefined; break
      case 'f': file = { pid, name: '', access: '', type: '' }; files.push(file); break
      case 'a': if (file) file.access = value; break
      case 't': if (file) file.type = value; break
      case 'n': if (file) file.name = value; break
    }
  }
  return files.filter(file => file.pid > 0 && file.name !== '')
}

export function isWithinPane(pid: number, panePid: number, processes: ProcessIdentity[]): boolean {
  const table = new Map(processes.map(process => [process.pid, process.ppid]))
  const seen = new Set<number>()
  for (let current: number | undefined = pid; current && !seen.has(current); current = table.get(current)) {
    if (current === panePid) return true
    seen.add(current)
  }
  return false
}

export function isCodex(process: ProcessIdentity): boolean {
  return path.basename(process.command) === 'codex'
}

export function paneCodexRoots(panePid: number, processes: ProcessIdentity[]): ProcessIdentity[] {
  const candidates = processes.filter(process => isCodex(process) && isWithinPane(process.pid, panePid, processes))
  // Tool helpers (including app-server clients) can themselves be named codex.
  // Only the outermost Codex process represents the terminal's CLI.
  return candidates.filter(process => !candidates.some(other => other.pid !== process.pid
    && isWithinPane(process.pid, other.pid, processes)))
}

export function isTranscript(file: OpenFile, codexHome: string): boolean {
  const relative = path.relative(path.join(codexHome, 'sessions'), file.name)
  return file.type === 'REG' && ['w', 'u'].includes(file.access)
    && !relative.startsWith('..') && !path.isAbsolute(relative)
    && /^rollout-.*\.jsonl$/.test(path.basename(file.name))
}

export function parseTranscriptHead(head: string): TranscriptIdentity | null {
  try {
    const entry = JSON.parse(head.split('\n')[0])
    const id = entry?.payload?.id
    if (entry.type !== 'session_meta' || typeof id !== 'string'
      || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)) return null
    return { id, source: entry.payload.source }
  } catch { return null }
}

/** Resolve only stable, unique CLI roots. Never infer identity from cwd or recency. */
export function resolveOwnership(input: {
  panes: PaneIdentity[]
  before: ProcessIdentity[]
  after: ProcessIdentity[]
  files: OpenFile[]
  metadata: Map<string, TranscriptIdentity | null>
  codexHome: string
}): OwnershipResult[] {
  const { panes, before, after, files, metadata, codexHome } = input
  const stable = (pid: number): boolean => {
    const a = before.find(process => process.pid === pid)
    const b = after.find(process => process.pid === pid)
    return !!a && !!b && a.started === b.started && a.ppid === b.ppid && a.command === b.command
  }
  const results: OwnershipResult[] = panes.map(pane => {
    const base = { window: pane.window, pane: pane.pane }
    const unresolved = (reason: string): OwnershipResult => ({ ...base, status: 'unresolved', reason })
    if (!stable(pane.pid)) return unresolved('pane process changed during inspection')
    const candidates = paneCodexRoots(pane.pid, before)
    if (candidates.length !== 1) return unresolved(`expected one pane-local Codex process; found ${candidates.length}`)
    const process = candidates[0]
    if (!stable(process.pid) || !isWithinPane(process.pid, pane.pid, after)) return unresolved('Codex process changed during inspection')
    const transcripts = [...new Set(files.filter(file => file.pid === process.pid && isTranscript(file, codexHome)).map(file => file.name))]
    if (transcripts.length === 0) return unresolved('no writable transcript owned by pane-local process (daemon or not yet persisted)')
    // Unknown metadata could hide a second root; do not silently discard it.
    if (transcripts.some(file => !metadata.get(file))) return unresolved('unreadable or unsupported transcript metadata')
    if (transcripts.some(file => {
      const source = metadata.get(file)!.source
      return source !== 'cli' && source !== 'exec' && source !== 'vscode'
        && !(source && typeof source === 'object' && 'subagent' in source)
    })) return unresolved('unknown transcript source')
    const roots = transcripts.filter(file => metadata.get(file)?.source === 'cli')
    if (roots.length !== 1) return unresolved(`expected one CLI root transcript; found ${roots.length}`)
    const transcript = roots[0]
    const sessionId = metadata.get(transcript)!.id
    if (!files.some(file => file.pid === process.pid && file.type === 'REG'
      && ['w', 'u'].includes(file.access)
      && file.name === path.join(codexHome, 'thread-writer-locks', `${sessionId}.lock`))) {
      return unresolved('root transcript lacks an open writer-lock descriptor')
    }
    return { ...base, status: 'resolved', pid: process.pid, sessionId, transcript }
  })
  // A shared identity across panes is evidence of ambiguity, not permission to steal.
  return results.map(result => result.status === 'resolved'
    && results.some(other => other !== result && other.status === 'resolved' && other.sessionId === result.sessionId)
    ? { window: result.window, pane: result.pane, status: 'unresolved', reason: 'session claimed by multiple panes' }
    : result)
}
