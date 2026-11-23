// Shared read-only collection and validation. No database or registry write capability.
import path from 'node:path'
import { antigravityHome } from '../antigravityLogs'
import { parseClaudeJobSession, parseClaudeRecord, resolveClaudeRecord } from './claude'
import { isTranscript, paneProcessRoots, parseTranscriptHead, resolveOwnership } from './codex'
import type { OpenFile, PaneIdentity, ProcessIdentity, TranscriptIdentity } from './codex'

export interface OwnershipWindow {
  tmuxWindow: string
  name?: string
  command?: string
  agentType?: string
  agentSessionId?: string
  remote?: boolean
  agentboardTags?: { runId: string; serverPid: number }
}
export type Observation = { window: string; pane: string; agent: 'claude' | 'codex' | 'antigravity' } & (
  | { status: 'resolved'; pid: number; started: string; sessionId: string; transcript?: string }
  | { status: 'unresolved'; reason: string }
)
export interface OwnershipIO {
  panes(): Promise<PaneIdentity[]>
  processes(): Promise<ProcessIdentity[]>
  files(pids: number[]): Promise<OpenFile[]>
  head(file: string, cache: boolean): Promise<string | null>
  codexHome: string
  claudeHome: string
  platform: string
}

export async function probeOwnership(windows: OwnershipWindow[], io: OwnershipIO): Promise<Observation[]> {
  const local = windows.filter(window => !window.remote && ['claude', 'codex', 'antigravity'].includes(window.agentType ?? ''))
  if (!local.length) return []
  const [allPanes, before] = await Promise.all([io.panes(), io.processes()])
  const panes = allPanes.filter(pane => local.some(window => window.tmuxWindow === pane.window))
  if (panes.length > 128) throw new Error('ownership pane limit exceeded')
  const agentOf = (pane: PaneIdentity) => local.find(window => window.tmuxWindow === pane.window)!.agentType as Observation['agent']
  const candidatesFor = (pane: PaneIdentity, snapshot: ProcessIdentity[]) =>
    paneProcessRoots(agentOf(pane) === 'antigravity' ? 'agy' : agentOf(pane), pane.pid, snapshot)
  const roots = new Map(panes.map(pane => [pane.pane, candidatesFor(pane, before)]))
  const codexPanes = panes.filter(pane => agentOf(pane) === 'codex')
  const pids = [...new Set(panes.filter(pane => agentOf(pane) !== 'claude').flatMap(pane => roots.get(pane.pane)!.map(process => process.pid)))]
  // A missing lsof must not suppress Claude's independent registry evidence.
  let fileError = false
  let files: OpenFile[] = []
  try { files = pids.length ? await io.files(pids) : [] } catch { fileError = true }
  const transcripts = [...new Set(files.filter(file => isTranscript(file, io.codexHome)).map(file => file.name))]
  if (transcripts.length > 1024) throw new Error('ownership transcript limit exceeded')
  const metadata = new Map<string, TranscriptIdentity | null>()
  for (const file of transcripts) metadata.set(file, parseTranscriptHead(await io.head(file, true) ?? ''))
  const claude = new Map<number, ReturnType<typeof parseClaudeRecord>>()
  const claudePanes = panes.filter(pane => agentOf(pane) === 'claude')
  for (const pane of claudePanes) {
    for (const process of roots.get(pane.pane)!) {
      claude.set(process.pid, parseClaudeRecord(await io.head(`${io.claudeHome}/sessions/${process.pid}.json`, false) ?? '', process.pid, io.platform))
    }
  }
  // Read only jobs selected by a validated local CLI record. Keep both
  // snapshots inside the registry/process bracket so unpark/repark races fail closed.
  const jobs = new Map<number, string | null>()
  const finalJobs = new Map<number, string | null>()
  for (const [pid, record] of claude) {
    if (record?.parkedJobId) {
      const file = `${io.claudeHome}/jobs/${record.parkedJobId}/state.json`
      jobs.set(pid, parseClaudeJobSession(await io.head(file, false) ?? '', record.parkedJobId))
      finalJobs.set(pid, parseClaudeJobSession(await io.head(file, false) ?? '', record.parkedJobId))
    }
  }
  let finalFiles: OpenFile[] = []
  try { finalFiles = pids.length ? await io.files(pids) : [] } catch { fileError = true }
  const finalClaude = new Map<number, ReturnType<typeof parseClaudeRecord>>()
  for (const pid of claude.keys()) finalClaude.set(pid, parseClaudeRecord(await io.head(`${io.claudeHome}/sessions/${pid}.json`, false) ?? '', pid, io.platform))
  const [finalPanes, after] = await Promise.all([io.panes(), io.processes()])
  const stable = (pid: number) => {
    const a = before.find(process => process.pid === pid)
    const b = after.find(process => process.pid === pid)
    return a && b && a.ppid === b.ppid && a.started === b.started && a.command === b.command
  }
  const codex = resolveOwnership({ panes: codexPanes, before, after, files, metadata, codexHome: io.codexHome })
  const fingerprint = (pid: number, snapshot: OpenFile[]) => JSON.stringify(snapshot
    .filter(file => file.pid === pid && (isTranscript(file, io.codexHome) || file.name.includes('/thread-writer-locks/')))
    .map(file => `${file.access}:${file.name}`).sort())
  const observations = panes.map((pane): Observation => {
    const agent = agentOf(pane)
    const base = { window: pane.window, pane: pane.pane, agent }
    const unknown = (reason: string): Observation => ({ ...base, status: 'unresolved', reason })
    const expectedServer = local.find(window => window.tmuxWindow === pane.window)?.agentboardTags?.serverPid
    if (expectedServer !== undefined && expectedServer !== pane.serverPid) return unknown('tmux_server_changed')
    if (panes.filter(other => other.window === pane.window).length !== 1) return unknown('multiple_panes_in_window')
    if (!stable(pane.pid) || !finalPanes.some(other => other.pane === pane.pane && other.window === pane.window && other.pid === pane.pid && other.serverPid === pane.serverPid)) return unknown('pane_changed')
    const candidates = roots.get(pane.pane)!
    if (candidates.length !== 1) return unknown('ambiguous_process_roots')
    const process = candidates[0]
    if (!stable(process.pid)) return unknown('process_changed')
    const finalRoots = candidatesFor(pane, after)
    if (finalRoots.length !== 1 || finalRoots[0].pid !== process.pid) return unknown('process_ancestry_changed')
    if (agent === 'claude') {
      const result = resolveClaudeRecord(process, claude.get(process.pid) ?? null, finalClaude.get(process.pid) ?? null)
      if (result.status === 'resolved' && claude.get(process.pid)?.parkedJobId) {
        const sessionId = jobs.get(process.pid)
        if (!sessionId || sessionId !== finalJobs.get(process.pid)) return unknown('claude_parked_job_unavailable_or_changed')
        return { ...base, status: 'resolved', sessionId, pid: process.pid, started: process.started }
      }
      return { ...base, ...result, ...(result.status === 'resolved' ? { pid: process.pid, started: process.started } : {}) } as Observation
    }
    if (fileError) return unknown(agent + '_descriptor_inspection_failed')
    if (agent === 'antigravity') {
      const home = antigravityHome()
      const locks = (snapshot: OpenFile[]) => snapshot.filter(f => f.pid === process.pid && f.type === 'REG' &&
        ['w', 'u'].includes(f.access) && path.dirname(f.name) === path.join(home, 'presence') &&
        /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.lock$/i.test(path.basename(f.name)))
      const first = locks(files), second = locks(finalFiles)
      if (first.length !== 1 || second.length !== 1 || first[0].name !== second[0].name) return unknown('antigravity_presence_ambiguous')
      const sessionId = path.basename(first[0].name, '.lock')
      return { ...base, status: 'resolved', pid: process.pid, started: process.started, sessionId,
        transcript: path.join(home, 'brain', sessionId, '.system_generated/logs/transcript.jsonl') }
    }
    if (fingerprint(process.pid, files) !== fingerprint(process.pid, finalFiles)) return unknown('codex_descriptors_changed')
    const result = codex.find(result => result.pane === pane.pane)
    return result?.status === 'resolved'
      ? { ...base, status: 'resolved', pid: result.pid, started: process.started, sessionId: result.sessionId, transcript: result.transcript }
      : unknown(result?.reason ?? 'codex_unresolved')
  })
  return observations.map(result => result.status === 'resolved' && observations.some(other => other !== result
    && other.status === 'resolved' && other.agent === result.agent && other.sessionId === result.sessionId)
    ? { window: result.window, pane: result.pane, agent: result.agent, status: 'unresolved', reason: 'duplicate_session_claim' }
    : result)
}
