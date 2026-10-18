import { describe, expect, test } from 'bun:test'
import { probeOwnership } from '../ownership/probe'
import type { OwnershipIO, OwnershipWindow } from '../ownership/probe'
import { parseClaudeRecord } from '../ownership/claude'
import type { OpenFile, ProcessIdentity } from '../ownership/codex'

const claudeId = '9c7e140b-f415-486d-9892-b93e7f36b6b1'
const codexId = '01a14fcb-08fc-7e63-af00-4939edcd8a36'
const started = 'Thu Oct 15 20:05:59 2026'
const transcript = `/codex/sessions/2026/10/18/rollout-${codexId}.jsonl`
function fixture() {
  const windows: OwnershipWindow[] = [
    { tmuxWindow: 'ab:@1', agentType: 'claude', agentSessionId: claudeId },
    { tmuxWindow: 'ab:@2', agentType: 'codex' },
  ]
  const panes = [{ window: 'ab:@1', pane: '%1', pid: 10 }, { window: 'ab:@2', pane: '%2', pid: 20 }]
  const processes: ProcessIdentity[] = [{ pid: 10, ppid: 1, started, command: 'claude' }, { pid: 20, ppid: 1, started, command: 'codex' }]
  const record = { pid: 10, sessionId: claudeId, procStart: started, version: '2.1.300', kind: 'interactive', entrypoint: 'cli', pidDomain: 'darwin', tmux: 'obsolete-mirror:@1.%1' }
  const files: OpenFile[] = [transcript, `/codex/thread-writer-locks/${codexId}.lock`].map(name => ({ pid: 20, name, access: 'w', type: 'REG' }))
  const io: OwnershipIO = {
    codexHome: '/codex', claudeHome: '/claude', platform: 'darwin',
    panes: async () => structuredClone(panes), processes: async () => structuredClone(processes),
    files: async () => structuredClone(files),
    head: async file => file === transcript
      ? JSON.stringify({ type: 'session_meta', payload: { id: codexId, source: 'cli' } })
      : JSON.stringify(record),
  }
  return { windows, panes, processes, record, files, io }
}

describe('ownership probe', () => {
  test('resolves both providers with no terminal text and ignores stale mirror metadata', async () => {
    const f = fixture()
    expect((await probeOwnership(f.windows, f.io)).map(result => result.status === 'resolved' && result.sessionId)).toEqual([claudeId, codexId])
  })
  test('Claude stale PID start is rejected even if session ID matches', async () => {
    const f = fixture(); f.record.procStart = 'Wed Oct 14 20:05:59 2026'
    expect((await probeOwnership(f.windows, f.io))[0]).toMatchObject({ status: 'unresolved', reason: 'claude_registry_stale_process' })
  })
  test('registry switch during capture is unresolved, next stable capture resolves', async () => {
    const f = fixture(); let reads = 0
    const original = f.io.head
    f.io.head = async (file, cache) => {
      if (file.endsWith('10.json') && ++reads === 2) f.record.sessionId = codexId
      return original(file, cache)
    }
    expect((await probeOwnership(f.windows, f.io))[0]).toMatchObject({ status: 'unresolved', reason: 'claude_registry_changed' })
    expect((await probeOwnership(f.windows, f.io))[0]).toMatchObject({ status: 'resolved', sessionId: codexId })
  })
  test('missing lsof does not block Claude', async () => {
    const f = fixture(); f.io.files = async () => { throw new Error('ENOENT') }
    const result = await probeOwnership(f.windows, f.io)
    expect(result[0].status).toBe('resolved')
    expect(result[1]).toMatchObject({ status: 'unresolved', reason: 'codex_descriptor_inspection_failed' })
  })
  test('changed descriptors invalidate a Codex result', async () => {
    const f = fixture(); let reads = 0
    f.io.files = async () => ++reads === 1 ? f.files : []
    expect((await probeOwnership(f.windows, f.io))[1]).toMatchObject({ status: 'unresolved', reason: 'codex_descriptors_changed' })
  })
  test('pane replacement is rejected', async () => {
    const f = fixture(); let reads = 0
    f.io.panes = async () => ++reads === 1 ? f.panes : f.panes.map(pane => ({ ...pane, pid: 99 }))
    expect((await probeOwnership(f.windows, f.io)).every(result => result.status === 'unresolved')).toBe(true)
  })
  test('a different tmux server invalidates otherwise identical pane IDs', async () => {
    const f = fixture(); let reads = 0
    f.io.panes = async () => f.panes.map(pane => ({ ...pane, serverPid: ++reads < 3 ? 100 : 200 }))
    expect((await probeOwnership(f.windows, f.io)).every(result => result.status === 'unresolved')).toBe(true)
  })
  test('multiple panes cannot silently select one window owner', async () => {
    const f = fixture(); f.panes.push({ window: 'ab:@1', pane: '%3', pid: 30 })
    expect((await probeOwnership(f.windows, f.io)).filter(result => result.window === 'ab:@1').every(result => result.status === 'unresolved')).toBe(true)
  })
  test('remote-only snapshots never inspect this host', async () => {
    const f = fixture(); f.windows.forEach(window => { window.remote = true })
    f.io.panes = async () => { throw new Error('should not run') }
    expect(await probeOwnership(f.windows, f.io)).toEqual([])
  })
  test('unsupported or truncated Claude records fail closed', () => {
    const f = fixture()
    expect(parseClaudeRecord('{', 10, 'darwin')).toBeNull()
    expect(parseClaudeRecord(JSON.stringify({ ...f.record, version: '3.0' }), 10, 'darwin')).toBeNull()
    expect(parseClaudeRecord(JSON.stringify(f.record), 11, 'darwin')).toBeNull()
    expect(parseClaudeRecord(JSON.stringify(f.record), 10, 'linux')).toBeNull()
    expect(parseClaudeRecord(JSON.stringify({ ...f.record, kind: 'background' }), 10, 'darwin')).toBeNull()
  })
  test('normalizes process timestamp spacing', () => {
    const f = fixture(); f.record.procStart = 'Thu  Oct  15 20:05:59 2026'
    expect(parseClaudeRecord(JSON.stringify(f.record), 10, 'darwin')?.procStart).toBe(started)
  })
})
