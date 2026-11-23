import { afterEach, beforeEach, describe, expect, test, spyOn } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { activitySnapshot, newActivityState, reduceActivity } from '../activityReducer'
import { SessionActivityTracker } from '../sessionActivity'
import { clearSubagentLogCaches, registerCodexSubagent } from '../subagentLogs'
import { SessionRegistry } from '../SessionRegistry'
import type { Session } from '../../shared/types'

const FULL_RANK_FOR_TESTS = 30 * 1000

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
    reduceActivity(s, claudeTool('c', 'Bash'), 'claude')
    expect(JSON.stringify(activitySnapshot(s))).not.toContain('secret')
    reduceActivity(s, { type: 'assistant', message: { stop_reason: 'refusal' } }, 'claude')
    expect(activitySnapshot(s)).toMatchObject({ phase: 'idle', label: 'Turn finished', tools: [] })
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
  // Real independent associations exceed a small cursor LRU.
  for (let i = 0; i < 4; i++) {
    const file = path.join(dir, `${i}.jsonl`)
    await fs.writeFile(file, line(event('task_complete')))
    sessions.push({ ...p, id: String(i), agentSessionId: String(i), logFilePath: file })
  }
  let progress = 0
  const observer = new SessionActivityTracker(() => { progress++ }, 3)
  const initial = await observer.enrich(sessions)
  expect(initial.every(s => s.activity?.main.phase === 'idle')).toBe(true)
  expect(progress).toBe(4)
  // Prove eviction happened; disabling the bound must fail this regression.
  const cursors = (observer as unknown as { cursors: Map<string, unknown> }).cursors
  expect(cursors.size).toBe(3)
  expect(cursors.has(sessions[0].logFilePath!)).toBe(false)
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

test('Claude interruption ends pending work, survives cold replay, and resumes on new activity', async () => {
  const log = path.join(dir, 'parent.jsonl')
  for (const marker of ['[Request interrupted by user]', '[Request interrupted by user for tool use]']) {
    const stopped = { type: 'user', timestamp: '2026-01-01T00:00:00Z', message: { content: [{ type: 'text', text: marker }] } }
    await fs.writeFile(log, line(claudeTool('x', 'Bash')) + line(stopped))
    const tracker = new SessionActivityTracker()
    expect((await tracker.enrich([session('claude', log)]))[0].activity?.main)
      .toMatchObject({ phase: 'idle', label: 'Interrupted', tools: [] })
    await fs.appendFile(log, line({ type: 'api-request' }))
    expect((await tracker.enrich([session('claude', log)]))[0].activity?.main)
      .toMatchObject({ phase: 'model', label: 'Model turn active', tools: [] })
  }
  const state = newActivityState()
  reduceActivity(state, claudeTool('x', 'Bash'), 'claude')
  reduceActivity(state, { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'x', content: '[Request interrupted by user]' }] } }, 'claude')
  expect(state.phase).toBe('model')
  reduceActivity(state, { type: 'user', message: { content: 'Explain [Request interrupted by user]' } }, 'claude')
  expect(state.phase).toBe('model')
})

test('stoppedByUser metadata ends a child only while strictly newer than its transcript', async () => {
  const log = path.join(dir, 'parent.jsonl')
  const child = path.join(dir, 'parent/subagents/agent-a.jsonl')
  await fs.mkdir(path.dirname(child), { recursive: true })
  await fs.writeFile(log, line({ type: 'api-request' }))
  await fs.writeFile(child, line(claudeTool('x', 'Bash')))
  const meta = child.replace('.jsonl', '.meta.json')
  await fs.writeFile(meta, JSON.stringify({ stoppedByUser: true }))
  const stamp = Date.now() / 1000
  await fs.utimes(child, stamp - 2, stamp - 2)
  await fs.utimes(meta, stamp, stamp)
  const tracker = new SessionActivityTracker()
  const now = Date.now()
  const clock = spyOn(Date, 'now').mockReturnValue(now)
  try {
    let [s] = await tracker.enrich([session('claude', log)])
    expect(s.activity).toMatchObject({ running: 0, unknown: 0 })
    expect(s.activity?.subagents[0].activity.label).toBe('Stopped')
    clock.mockReturnValue(now + FULL_RANK_FOR_TESTS)
    await tracker.enrich([session('claude', log)])
    await fs.writeFile(meta, JSON.stringify({ stoppedByUser: true, description: 'Review parser' }))
    await fs.utimes(meta, stamp, stamp)
    ;[s] = await tracker.enrich([session('claude', log)])
    expect(s.activity?.subagents[0].name).toBe('Review parser')
    await fs.appendFile(child, line({ type: 'api-request' }))
    for (const time of [stamp, stamp + 1]) {
      await fs.utimes(child, time, time)
      ;[s] = await tracker.enrich([session('claude', log)])
      expect(s.activity?.running).toBe(1)
    }
  } finally { clock.mockRestore() }
})

test('a transient Claude sidecar read failure is retried without a file change', async () => {
  const log = path.join(dir, 'parent.jsonl')
  const childDir = await claudeChildren(1, 'a', new Date(Date.now() - 60 * 60 * 1000))
  await fs.writeFile(log, line({ type: 'api-request' }))
  const meta = path.join(childDir, 'agent-a000.meta.json')
  await fs.writeFile(meta, JSON.stringify({ stoppedByUser: true, description: 'Review parser' }))

  const read = spyOn(fs, 'readFile').mockImplementationOnce(async () => {
    throw Object.assign(new Error('transient sidecar read failure'), { code: 'EIO' })
  })
  try {
    const tracker = new SessionActivityTracker()
    const [first] = await tracker.enrich([session('claude', log)])
    expect(first.activity?.subagents[0]).toMatchObject({ name: 'a000', activity: { label: 'Turn finished' } })
    const [retry] = await tracker.enrich([session('claude', log)])
    expect(retry.activity?.subagents[0]).toMatchObject({ name: 'Review parser', activity: { label: 'Stopped' } })
  } finally { read.mockRestore() }
})
const finished = line({ type: 'assistant', message: { stop_reason: 'end_turn', content: [] } })
async function claudeChildren(count: number, prefix: string, mtime: Date): Promise<string> {
  const childDir = path.join(dir, 'parent/subagents')
  await fs.mkdir(childDir, { recursive: true })
  for (let i = 0; i < count; i++) {
    const p = path.join(childDir, `agent-${prefix}${String(i).padStart(3, '0')}.jsonl`)
    await fs.writeFile(p, finished)
    await fs.utimes(p, mtime, mtime)
  }
  return childDir
}

test('read cap keeps the most recently written children, not the first names', async () => {
  const log = path.join(dir, 'parent.jsonl')
  await fs.writeFile(log, line({ type: 'api-request' }))
  const childDir = await claudeChildren(260, 'a', new Date(Date.now() - 60 * 60 * 1000))
  // Sorts after every finished child, so a name-ordered cap would skip it.
  await fs.writeFile(path.join(childDir, 'agent-zzz-live.jsonl'), line(claudeTool('x', 'Bash')))
  let progress = 0
  const [s] = await new SessionActivityTracker(() => { progress++ }).enrich([session('claude', log)])
  expect(s.activity).toMatchObject({ running: 1, total: 261, unknown: 5 })
  expect(s.activity?.subagents[0].id).toBe('zzz-live')
  // The stat pass reports progress before any capped read starts.
  expect(progress).toBeGreaterThan(256 + Math.floor(261 / 64))
})

test('a child last seen working keeps its read slot while newer siblings finish', async () => {
  const log = path.join(dir, 'parent.jsonl')
  await fs.writeFile(log, line({ type: 'api-request' }))
  const childDir = path.join(dir, 'parent/subagents')
  await fs.mkdir(childDir, { recursive: true })
  const live = path.join(childDir, 'agent-a-long-tool.jsonl')
  await fs.writeFile(live, line(claudeTool('x', 'Bash')))
  const tracker = new SessionActivityTracker()
  expect((await tracker.enrich([session('claude', log)]))[0].activity?.running).toBe(1)
  // A long tool call writes nothing, so 260 newer finished siblings outrank it by mtime.
  const silent = new Date(Date.now() - 5 * 60 * 1000)
  await fs.utimes(live, silent, silent)
  await claudeChildren(260, 'b', new Date())
  const now = Date.now()
  const clock = spyOn(Date, 'now').mockReturnValue(now + FULL_RANK_FOR_TESTS)
  try {
    const [s] = await tracker.enrich([session('claude', log)])
    expect(s.activity).toMatchObject({ running: 1, total: 261 })
    expect(s.activity?.subagents[0].id).toBe('a-long-tool')
  } finally { clock.mockRestore() }
})

test('fast scans reuse idle children and see new children before the full sweep', async () => {
  const log = path.join(dir, 'parent.jsonl')
  await fs.writeFile(log, line({ type: 'api-request' }))
  const childDir = await claudeChildren(300, 'a', new Date(Date.now() - 60 * 60 * 1000))
  const tracker = new SessionActivityTracker()
  const start = Date.now()
  const clock = spyOn(Date, 'now').mockReturnValue(start)
  try {
    const [initial] = await tracker.enrich([session('claude', log)])
    const stat = spyOn(fs, 'stat')
    const open = spyOn(fs, 'open')
    try {
      const [unchanged] = await tracker.enrich([session('claude', log)])
      expect(unchanged.activity).toEqual(initial.activity)
      expect(open.mock.calls.filter(([p]) => path.dirname(String(p)) === childDir)).toHaveLength(0)
      expect(stat.mock.calls.filter(([p]) => path.dirname(String(p)) === childDir).length).toBeLessThan(64)
    } finally {
      open.mockRestore()
      stat.mockRestore()
    }

    // This was outside the initial read budget, so only the full sweep notices its append.
    const resumed = path.join(childDir, 'agent-a299.jsonl')
    await fs.appendFile(resumed, line(claudeTool('y', 'Bash')))
    await fs.writeFile(path.join(childDir, 'agent-new.jsonl'), line(claudeTool('z', 'Bash')))
    const [mid] = await tracker.enrich([session('claude', log)])
    expect(mid.activity?.subagents.map(c => c.id)).toContain('new')
    expect(mid.activity?.running).toBe(1)

    clock.mockReturnValue(start + FULL_RANK_FOR_TESTS)
    const [full] = await tracker.enrich([session('claude', log)])
    expect(full.activity?.running).toBe(2)
    expect(full.activity?.subagents.map(c => c.id)).toContain('a299')
  } finally { clock.mockRestore() }
})

test('finished children remain known beyond the read cap as full sweeps cover the backlog', async () => {
  const log = path.join(dir, 'parent.jsonl')
  await fs.writeFile(log, line({ type: 'api-request' }))
  const now = Date.now()
  await claudeChildren(256, 'a', new Date(now - 2 * 60 * 60 * 1000))
  const clock = spyOn(Date, 'now').mockReturnValue(now)
  try {
    const tracker = new SessionActivityTracker()
    const [initial] = await tracker.enrich([session('claude', log)])
    expect(initial.activity).toMatchObject({ total: 256, running: 0, unknown: 0 })
    await claudeChildren(260, 'b', new Date(now - 60 * 60 * 1000))
    clock.mockReturnValue(now + FULL_RANK_FOR_TESTS)
    const [first] = await tracker.enrich([session('claude', log)])
    expect(first.activity).toMatchObject({ total: 516, running: 0 })
    expect(first.activity?.unknown).toBeLessThan(260)
    expect(first.activity?.subagents[0]).toMatchObject({ id: 'a000', activity: { phase: 'idle' } })

    clock.mockReturnValue(now + 2 * FULL_RANK_FOR_TESTS)
    const [settled] = await tracker.enrich([session('claude', log)])
    expect(settled.activity).toMatchObject({ total: 516, running: 0, unknown: 0 })
    const oldChild = path.join(dir, 'parent/subagents/agent-a000.jsonl')
    await fs.appendFile(oldChild, line(claudeTool('resume', 'Bash')))
    expect((await tracker.enrich([session('claude', log)]))[0].activity?.running).toBe(0)
    clock.mockReturnValue(now + 3 * FULL_RANK_FOR_TESTS)
    const [resumed] = await tracker.enrich([session('claude', log)])
    expect(resumed.activity).toMatchObject({ total: 516, running: 1, unknown: 0 })
    expect(resumed.activity?.subagents[0]).toMatchObject({ id: 'a000', activity: { phase: 'tool' } })

    expect(await tracker.enrich([])).toEqual([])
    const [reopened] = await tracker.enrich([session('claude', log)])
    expect(reopened.activity).toMatchObject({ total: 516, running: 1, unknown: 260 })
  } finally { clock.mockRestore() }
})

test('a full sweep revalidates sidecar-only changes for a cold Claude child', async () => {
  const log = path.join(dir, 'parent.jsonl')
  await fs.writeFile(log, line({ type: 'api-request' }))
  const now = Date.now()
  const childDir = await claudeChildren(260, 'b', new Date(now - 60 * 60 * 1000))
  const child = path.join(childDir, 'agent-a000.jsonl')
  await fs.writeFile(child, finished)
  const old = new Date(now - 2 * 60 * 60 * 1000)
  await fs.utimes(child, old, old)
  const meta = child.replace('.jsonl', '.meta.json')
  const clock = spyOn(Date, 'now').mockReturnValue(now)
  try {
    const tracker = new SessionActivityTracker()
    await tracker.enrich([session('claude', log)])
    clock.mockReturnValue(now + FULL_RANK_FOR_TESTS)
    const [initial] = await tracker.enrich([session('claude', log)])
    expect(initial.activity?.subagents[0]).toMatchObject({ id: 'a000', name: 'a000' })

    await fs.writeFile(meta, JSON.stringify({ stoppedByUser: true, description: 'Review parser' }))
    clock.mockReturnValue(now + 2 * FULL_RANK_FOR_TESTS)
    const [stopped] = await tracker.enrich([session('claude', log)])
    expect(stopped.activity?.subagents[0]).toMatchObject({
      id: 'a000', name: 'Review parser', activity: { label: 'Stopped' },
    })

    await fs.unlink(meta)
    clock.mockReturnValue(now + 3 * FULL_RANK_FOR_TESTS)
    const [removed] = await tracker.enrich([session('claude', log)])
    expect(removed.activity?.subagents[0]).toMatchObject({
      id: 'a000', name: 'a000', activity: { label: 'Turn finished' },
    })
  } finally { clock.mockRestore() }
})

test('missing children sort last and sessions at the cap skip the stat pass', async () => {
  const log = path.join(dir, 'parent.jsonl')
  await fs.writeFile(log, line(event('task_started')))
  for (let i = 0; i < 256; i++) {
    const p = path.join(dir, `child-${i}.jsonl`)
    await fs.writeFile(p, line(event('task_complete')))
    registerCodexSubagent(`child-${i}`, 'parent', p)
  }
  const stat = spyOn(fs, 'stat')
  const [atCap] = await new SessionActivityTracker().enrich([session('codex', log)])
  expect(stat).not.toHaveBeenCalled()
  stat.mockRestore()
  expect(atCap.activity).toMatchObject({ total: 256, unknown: 0 })
  registerCodexSubagent('gone', 'parent', path.join(dir, 'gone.jsonl'))
  const [over] = await new SessionActivityTracker().enrich([session('codex', log)])
  expect(over.activity).toMatchObject({ total: 257, unknown: 1 })
  expect(over.activity?.subagents.some(c => c.id === 'gone')).toBe(false)
})

test('Antigravity tracks pending tools until each indexed result completes', () => {
  const state = newActivityState()
  const apply = (step_index: number, type: string, extra = {}) => reduceActivity(state, {
    step_index, type, source: 'MODEL', status: 'DONE', created_at: '2026-11-01T12:00:00Z', ...extra,
  }, 'antigravity')
  apply(0, 'USER_INPUT', { source: 'USER_EXPLICIT' })
  expect(state.phase).toBe('model')
  apply(1, 'PLANNER_RESPONSE', { tool_calls: [{ name: 'read_file' }, { name: 'run_command' }] })
  expect(activitySnapshot(state).tools).toEqual(['read_file', 'run_command'])
  apply(2, 'GENERIC')
  expect(activitySnapshot(state).tools).toEqual(['run_command'])
  apply(3, 'RUN_COMMAND')
  expect(state.phase).toBe('model')
  apply(4, 'PLANNER_RESPONSE')
  apply(5, 'OTHER')
  expect(activitySnapshot(state)).toMatchObject({ phase: 'idle', tools: [], updatedAt: '2026-11-01T12:00:00Z' })
})
