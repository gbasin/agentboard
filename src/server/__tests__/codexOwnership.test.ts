import { describe, expect, test } from 'bun:test'
import { parseOpenFiles, parseProcesses, parseTranscriptHead, resolveOwnership } from '../ownership/codex'
import type { OpenFile, ProcessIdentity, TranscriptIdentity } from '../ownership/codex'

const rootId = '01a14fcb-08fc-7e63-af00-4939edcd8a36'
const otherId = '01a14fd2-61f1-7732-bf69-49ee279a1187'
const home = '/tmp/codex home'
const root = `${home}/sessions/2026/10/18/rollout-${rootId}.jsonl`
const child = `${home}/sessions/2026/10/18/rollout-${otherId}.jsonl`
const proc = (pid: number, ppid: number, command = 'codex'): ProcessIdentity => ({ pid, ppid, command, started: 'Sun Oct 18 12:14:26 2026' })
const file = (name: string, pid = 42): OpenFile => ({ pid, name, access: 'w', type: 'REG' })
const lock = (id = rootId, pid = 42) => file(`${home}/thread-writer-locks/${id}.lock`, pid)
function input() {
  return { panes: [{ window: 'agentboard:@1', pane: '%1', pid: 40 }],
    before: [proc(40, 1, 'zsh'), proc(42, 40)], after: [proc(40, 1, 'zsh'), proc(42, 40)],
    files: [file(root), lock()], codexHome: home,
    metadata: new Map<string, TranscriptIdentity | null>([[root, { id: rootId, source: 'cli' }]]) }
}
describe('Codex ownership', () => {
  test('resolves idle sessions with no screen text or log growth', () => {
    expect(resolveOwnership(input())[0]).toMatchObject({ status: 'resolved', pid: 42, sessionId: rootId })
  })
  test('ignores subagent roots even when they are newer and share the writer', () => {
    const data = input()
    data.files.unshift(file(child), lock(otherId))
    data.metadata.set(child, { id: otherId, source: { subagent: { thread_spawn: { parent_thread_id: rootId } } } })
    expect(resolveOwnership(data)[0]).toMatchObject({ status: 'resolved', sessionId: rootId })
  })
  test('refuses two root threads during a switch instead of choosing the newest', () => {
    const data = input()
    data.files.push(file(child), lock(otherId))
    data.metadata.set(child, { id: otherId, source: 'cli' })
    expect(resolveOwnership(data)[0]).toMatchObject({ status: 'unresolved', reason: 'expected one CLI root transcript; found 2' })
    // Once the old root closes, a subsequent snapshot resolves the new identity.
    data.files = [file(child), lock(otherId)]
    expect(resolveOwnership(data)[0]).toMatchObject({ status: 'resolved', sessionId: otherId })
  })
  test('does not assign shared-daemon transcripts to a CLI client', () => {
    const data = input()
    data.before.push(proc(90, 1)); data.after.push(proc(90, 1))
    data.files = [file(root, 90), lock(rootId, 90)]
    expect(resolveOwnership(data)[0].status).toBe('unresolved')
  })
  test('nested Codex tool processes do not displace the outer CLI', () => {
    const data = input()
    data.before.push(proc(90, 42)); data.after.push(proc(90, 42))
    data.files.push(file(child, 90), lock(otherId, 90))
    data.metadata.set(child, { id: otherId, source: 'cli' })
    expect(resolveOwnership(data)[0]).toMatchObject({ status: 'resolved', pid: 42, sessionId: rootId })
  })
  test('sibling Codex processes under a shell are ambiguous', () => {
    const data = input()
    data.before.push(proc(90, 40)); data.after.push(proc(90, 40))
    expect(resolveOwnership(data)[0].status).toBe('unresolved')
  })
  test.each(['exit', 'reuse', 'reparent'] as const)('rejects process %s during inspection', change => {
    const data = input()
    if (change === 'exit') data.after.pop()
    if (change === 'reuse') data.after[1].started = 'Sun Oct 18 12:30:00 2026'
    if (change === 'reparent') data.after[1].ppid = 1
    expect(resolveOwnership(data)[0].status).toBe('unresolved')
  })
  test('rejects unreadable metadata rather than hiding another potential root', () => {
    const data = input()
    data.files.push(file(child)); data.metadata.set(child, null)
    expect(resolveOwnership(data)[0].status).toBe('unresolved')
  })
  test('rejects unknown source formats', () => {
    const data = input()
    data.files.push(file(child)); data.metadata.set(child, { id: otherId, source: 'future-format' })
    expect(resolveOwnership(data)[0].status).toBe('unresolved')
  })
  test('read-only transcript descriptors are not ownership', () => {
    const data = input(); data.files[0].access = 'r'
    expect(resolveOwnership(data)[0].status).toBe('unresolved')
  })
  test('a lock file must be open in the owning process', () => {
    const data = input(); data.files.pop()
    expect(resolveOwnership(data)[0].status).toBe('unresolved')
  })
  test('refuses duplicate session claims across panes', () => {
    const data = input()
    data.panes.push({ window: 'agentboard:@2', pane: '%2', pid: 50 })
    data.before.push(proc(50, 1)); data.after.push(proc(50, 1))
    data.files.push(file(root, 50), lock(rootId, 50))
    expect(resolveOwnership(data).every(result => result.status === 'unresolved')).toBe(true)
  })
  test('does not follow process ancestry cycles indefinitely', () => {
    const data = input()
    data.before[1].ppid = 43; data.before.push(proc(43, 42, 'zsh'))
    expect(resolveOwnership(data)[0].status).toBe('unresolved')
  })
  test('parses NUL-delimited lsof fields without mixing processes or descriptors', () => {
    const text = `p42\0\nfcwd\0a \0tDIR\0n/tmp\0\nf8\0aw\0tREG\0n${root}\0\np90\0\nf9\0au\0tREG\0n${child}\0\n`
    expect(parseOpenFiles(text).slice(1)).toEqual([file(root), { ...file(child, 90), access: 'u' }])
  })
  test('parses process start identity and executable paths with spaces', () => {
    expect(parseProcesses(' 42 40 Sun Oct 18 12:14:26 2026 /some path/codex\ninvalid')).toEqual([proc(42, 40, '/some path/codex')])
  })
  test('accepts only complete session metadata with a valid ID', () => {
    expect(parseTranscriptHead(JSON.stringify({ type: 'session_meta', payload: { id: rootId, source: 'cli' } }) + '\npartial')).toEqual({ id: rootId, source: 'cli' })
    expect(parseTranscriptHead('{"type":')).toBeNull()
    expect(parseTranscriptHead('{"type":"session_meta","payload":{"id":"unknown"}}')).toBeNull()
  })
})
