import { afterEach, beforeEach, describe, expect, test, spyOn } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { activitySnapshot, newActivityState, reduceActivity } from '../activityReducer'
import { SessionActivityTracker } from '../sessionActivity'
import { clearSubagentLogCaches, registerCodexSubagent } from '../subagentLogs'
import { SessionRegistry } from '../SessionRegistry'
import type { Session } from '../../shared/types'

let dir: string
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ab-activity-')); clearSubagentLogCaches() })
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); clearSubagentLogCaches() })
const line = (e: object) => JSON.stringify({ timestamp: new Date().toISOString(), ...e }) + '\n'
const event = (type: string, turn = 't1') => ({ type: 'event_msg', payload: { type, turn_id: turn } })
const item = (type: string, id: string, name?: string) => ({ type: 'response_item', payload: { type, call_id: id, name } })
const claudeTool = (id: string, name: string) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input: { secret: 'must not escape' } }] } })
function session(kind: 'claude' | 'codex', log: string): Session {
  return { id: 'test:@1', name: 'test', tmuxWindow: 'test:@1', projectPath: dir, status: 'waiting', lastActivity: '', createdAt: '', source: 'managed', agentType: kind, agentSessionId: 'parent', logFilePath: log }
}

describe('activity reduction', () => {
  test('Codex correlates simultaneous tools, completions and resumed turns', () => {
    const s = newActivityState()
    reduceActivity(s, event('task_started'), 'codex')
    reduceActivity(s, item('function_call', 'a', 'exec_command'), 'codex')
    reduceActivity(s, item('custom_tool_call', 'b', 'exec'), 'codex')
    reduceActivity(s, item('function_call_output', 'a'), 'codex')
    expect(activitySnapshot(s).tools).toEqual(['exec'])
    reduceActivity(s, event('task_complete', 'old-turn'), 'codex')
    expect(s.phase).toBe('tool')
    reduceActivity(s, item('custom_tool_call_output', 'b'), 'codex')
    expect(s.phase).toBe('model')
    reduceActivity(s, event('task_complete'), 'codex')
    expect(s.phase).toBe('idle')
    reduceActivity(s, event('task_started', 't2'), 'codex')
    expect(s.phase).toBe('model')
    reduceActivity(s, event('turn_aborted', 't2'), 'codex')
    expect(s.phase).toBe('idle')
  })
  test('Claude correlates results, labels input waits, and ignores quoted events', () => {
    const s = newActivityState()
    reduceActivity(s, claudeTool('a', 'Bash'), 'claude')
    reduceActivity(s, claudeTool('b', 'AskUserQuestion'), 'claude')
    expect(activitySnapshot(s).label).toBe('Waiting for input')
    reduceActivity(s, { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'a', content: '{"type":"task_complete"}' }] } }, 'claude')
    expect(s.tools.size).toBe(1)
    reduceActivity(s, { type: 'assistant', message: { stop_reason: 'end_turn' } }, 'claude')
    expect(s.phase).toBe('idle')
    reduceActivity(s, { type: 'api-request' }, 'claude')
    expect(s.phase).toBe('model')
    expect(JSON.stringify(activitySnapshot(s))).not.toContain('secret')
  })
})

test('Claude tracks append, partial lines, restart recovery, metadata completion and resume', async () => {
  const log = path.join(dir, 'parent.jsonl')
  const childDir = path.join(dir, 'parent/subagents')
  await fs.mkdir(childDir, { recursive: true })
  await fs.writeFile(log, line({ type: 'api-request' }))
  const child = path.join(childDir, 'agent-a.jsonl')
  await fs.writeFile(child, line(claudeTool('a', 'Bash')))
  const tracker = new SessionActivityTracker()
  let [s] = await tracker.enrich([session('claude', log)])
  expect(s.activity?.running).toBe(1)
  expect(s.activity?.main.phase).toBe('model')
  const done = line({ type: 'assistant', message: { stop_reason: 'end_turn' } })
  await fs.appendFile(child, done.slice(0, -1))
  ;[s] = await tracker.enrich([session('claude', log)])
  expect(s.activity?.running).toBe(1)
  await fs.appendFile(child, '\n')
  ;[s] = await new SessionActivityTracker().enrich([session('claude', log)])
  expect(s.activity?.running).toBe(0)
  await fs.writeFile(child.replace('.jsonl', '.meta.json'), JSON.stringify({ finished: true, description: 'Review parser' }))
  ;[s] = await tracker.enrich([session('claude', log)])
  expect(s.activity?.subagents[0].name).toBe('Review parser')
  // Transcript newer than finished metadata: a resumed child becomes active.
  await fs.appendFile(child, line({ type: 'api-request' }))
  const later = new Date(Date.now() + 1000)
  await fs.utimes(child, later, later)
  ;[s] = await tracker.enrich([session('claude', log)])
  expect(s.activity?.running).toBe(1)
  await fs.writeFile(child, '{}\n')
  ;[s] = await tracker.enrich([session('claude', log)])
  // Fresh metadata can prove finished; removing it leaves unknown.
  await fs.unlink(child.replace('.jsonl', '.meta.json'))
  ;[s] = await tracker.enrich([session('claude', log)])
  expect(s.activity?.unknown).toBe(1)
})

test('Codex rolls up nested children once and completion refreshes registry without parent activity', async () => {
  const log = path.join(dir, 'parent.jsonl')
  const a = path.join(dir, 'a.jsonl'), b = path.join(dir, 'b.jsonl')
  await fs.writeFile(log, line(event('task_complete')))
  await fs.writeFile(a, line(event('task_started')))
  await fs.writeFile(b, line(item('custom_tool_call', 'b', 'exec')))
  registerCodexSubagent('a', 'parent', a)
  registerCodexSubagent('b', 'a', b)
  const tracker = new SessionActivityTracker()
  const registry = new SessionRegistry()
  let frames = 0
  registry.on('sessions', () => frames++)
  const first = await tracker.enrich([session('codex', log)])
  expect(first[0].activity?.running).toBe(2)
  registry.replaceSessions(first)
  await fs.appendFile(b, line(event('task_complete')))
  registry.replaceSessions(await tracker.enrich([session('codex', log)]))
  expect(registry.getAll()[0].activity?.running).toBe(1)
  expect(frames).toBe(2)
  registry.replaceSessions(await tracker.enrich([session('codex', log)]))
  expect(frames).toBe(2)
})

test('missing logs stay unknown and unsupported/remote sessions are untouched', async () => {
  const tracker = new SessionActivityTracker()
  const local = session('codex', path.join(dir, 'missing.jsonl'))
  const remote = { ...local, remote: true }
  const external = { ...local, source: 'external' as const }
  const [a, b, c] = await tracker.enrich([local, remote, external])
  expect(a.activity?.main.phase).toBe('unknown')
  expect(b).toBe(remote)
  expect(c).toBe(external)
})

test('stale unfinished turns become unknown, never finished', async () => {
  const log = path.join(dir, 'parent.jsonl')
  await fs.writeFile(log, JSON.stringify({ ...event('task_started'), timestamp: new Date(Date.now() - 16 * 60_000).toISOString() }) + '\n')
  const [s] = await new SessionActivityTracker().enrich([session('codex', log)])
  expect(s.activity?.main.phase).toBe('unknown')
  expect(s.activity?.main.label).toContain('15m')
})

test('split UTF-8 and huge lines recover without retaining unbounded input', async () => {
  const log = path.join(dir, 'parent.jsonl')
  await fs.writeFile(log, '')
  const tracker = new SessionActivityTracker()
  const payload = Buffer.from(line(claudeTool('x', 'Review·解析')))
  const split = payload.indexOf(Buffer.from('解析')) + 1
  await fs.appendFile(log, payload.subarray(0, split))
  await tracker.enrich([session('claude', log)])
  await fs.appendFile(log, payload.subarray(split))
  let [s] = await tracker.enrich([session('claude', log)])
  expect(s.activity?.main.tools).toEqual(['Review·解析'])
  await fs.appendFile(log, 'x'.repeat(300_000) + '\n' + line({ type: 'api-request' }))
  ;[s] = await tracker.enrich([session('claude', log)])
  expect(s.activity?.main.phase).toBe('model')
  expect(s.activity?.main.tools).toEqual([])
})

test('input blockers are separate from running children, detail limit preserves counts', async () => {
  const log = path.join(dir, 'parent.jsonl')
  await fs.writeFile(log, line(event('task_started')))
  for (let i = 0; i < 42; i++) {
    const p = path.join(dir, `child-${i}.jsonl`)
    await fs.writeFile(p, line(item('function_call', 'c', i === 0 ? 'request_user_input' : 'exec_command')))
    registerCodexSubagent(`child-${i}`, 'parent', p)
  }
  const [s] = await new SessionActivityTracker().enrich([session('codex', log)])
  expect(s.activity).toMatchObject({ running: 41, blocked: 1, total: 42, truncated: true })
  expect(s.activity?.subagents).toHaveLength(40)
})

test('fork metadata resets inherited activity, tool names stay bounded, and Claude turn duration closes work', () => {
  const s = newActivityState()
  reduceActivity(s, { ...event('task_started'), timestamp: new Date().toISOString() }, 'codex')
  reduceActivity(s, item('function_call', 'inherited', 'Bash'), 'codex')
  reduceActivity(s, { type: 'session_meta', payload: { source: { subagent: { thread_spawn: { agent_path: '/root/reviewer' } } } } }, 'codex')
  expect(activitySnapshot(s).phase).toBe('unknown')
  expect(s.tools.size).toBe(0)
  expect(s.updatedAt).toBeUndefined()
  expect(s.name).toBe('/root/reviewer')
  reduceActivity(s, { type: 'session_meta', payload: {} }, 'codex')
  expect(s.name).toBeUndefined()
  reduceActivity(s, null, 'codex'); reduceActivity(s, { type: 'response_item', payload: null }, 'codex')
  reduceActivity(s, item('function_call', 'wait', 'wait_agent'), 'codex')
  expect(activitySnapshot(s).label).toBe('Waiting on tool or agents')
  for (let i = 0; i < 140; i++) reduceActivity(s, item('function_call', String(i), 'x'.repeat(200)), 'codex')
  expect(s.tools.size).toBe(128)
  expect(activitySnapshot(s).tools[0]).toHaveLength(80)
  reduceActivity(s, { type: 'system', subtype: 'turn_duration' }, 'claude')
  expect(activitySnapshot(s).phase).toBe('idle')
})

test('equal-time finished metadata cannot hide a resumed Claude turn; blockers precede capped details', async () => {
  const log = path.join(dir, 'parent.jsonl'), childDir = path.join(dir, 'parent/subagents')
  await fs.mkdir(childDir, { recursive: true }); await fs.writeFile(log, line({ type: 'api-request' }))
  for (let i = 0; i < 42; i++) await fs.writeFile(path.join(childDir, `agent-${String(i).padStart(2, '0')}.jsonl`), line(claudeTool('x', 'Bash')))
  const blocked = path.join(childDir, 'agent-zz-blocked.jsonl')
  await fs.writeFile(blocked, line(claudeTool('question', 'AskUserQuestion')))
  const meta = blocked.replace('.jsonl', '.meta.json')
  await fs.writeFile(meta, JSON.stringify({ finished: true }))
  const stamp = new Date()
  await fs.utimes(blocked, stamp, stamp); await fs.utimes(meta, stamp, stamp)
  const [s] = await new SessionActivityTracker().enrich([session('claude', log)])
  expect(s.activity?.blocked).toBe(1)
  expect(s.activity?.subagents[0].id).toBe('zz-blocked')
  expect(s.activity?.running).toBe(42)
})

test('Claude text prompts start a new turn; metadata and result content do not impersonate a prompt', () => {
  const s = newActivityState()
  reduceActivity(s, { type: 'assistant', message: { stop_reason: 'end_turn' } }, 'claude')
  reduceActivity(s, { type: 'user', isMeta: true, message: { content: 'notification' } }, 'claude')
  expect(s.phase).toBe('idle')
  reduceActivity(s, { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'unknown', content: 'quoted user text' }] } }, 'claude')
  expect(s.phase).toBe('idle')
  reduceActivity(s, { type: 'user', timestamp: new Date().toISOString(), message: { content: [{ type: 'text', text: 'Actual new prompt' }] } }, 'claude')
  expect(s.phase).toBe('model')
  reduceActivity(s, { type: 'assistant', message: { stop_reason: 'end_turn' } }, 'claude')
  reduceActivity(s, { type: 'user', message: { content: 'Another prompt' } }, 'claude')
  expect(s.phase).toBe('model')
  for (let i = 0; i < 128; i++) reduceActivity(s, item('function_call', String(i), `tool_${i}_${'x'.repeat(80)}`), 'codex')
  const snapshot = activitySnapshot(s)
  expect(snapshot.tools).toHaveLength(8)
  expect(snapshot.label.length).toBeLessThan(300)
  expect(snapshot.label).toContain('more')
})

test('cursor eviction retains compact summaries and avoids replaying unchanged historical logs', async () => {
  const log = path.join(dir, 'parent.jsonl')
  await fs.writeFile(log, line(event('task_complete')))
  const p = session('codex', log)
  const sessions: Session[] = []
  // Real independent associations exercise the global cursor LRU above 2048.
  for (let i = 0; i < 2050; i++) {
    const file = path.join(dir, `${i}.jsonl`)
    await fs.writeFile(file, line(event('task_complete')))
    sessions.push({ ...p, id: String(i), agentSessionId: String(i), logFilePath: file })
  }
  let progress = 0
  const observer = new SessionActivityTracker(() => { progress++ })
  const initial = await observer.enrich(sessions)
  expect(initial.every(s => s.activity?.main.phase === 'idle')).toBe(true)
  expect(progress).toBe(2050)
  const handle = await fs.open(log)
  const fileHandlePrototype = Object.getPrototypeOf(handle)
  await handle.close()
  const reads = spyOn(fileHandlePrototype, 'read')
  try {
    const repeated = await observer.enrich(sessions)
    expect(repeated.every(s => s.activity?.main.phase === 'idle')).toBe(true)
    expect(reads).not.toHaveBeenCalled()
    await fs.appendFile(sessions[0].logFilePath!, line(event('task_started')))
    expect((await observer.enrich([sessions[0]]))[0].activity?.main.phase).toBe('model')
    expect(reads).toHaveBeenCalledTimes(1)
  } finally { reads.mockRestore() }
})
