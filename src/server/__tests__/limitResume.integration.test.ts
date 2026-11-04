// Limit-resumes through the real manager, driver, mailbox, and dispatcher
// (limit-resume-unheld-sessions; oracle-hazards M1): the 2026-11-03 incident's
// frames, replayed on a fake CLI. A human-created chat starts two background
// agents; both die on a 429, the agent-started turn of the first failure hits
// the final limit itself, and nothing else happens. The session must be
// paused until the reset, and at the reset it must receive one limit-resume
// naming both lost agents, which starts a turn without human input.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Query, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { initDatabase, type SessionDatabase } from '../db'
import { SessionRegistry } from '../SessionRegistry'
import { ChatSessionManager, type ChatQueryFactory } from '../chat/ChatSessionManager'

interface FakeCli { push: (message: SDKMessage) => void; prompts: SDKUserMessage[] }

function fakeQueryFactory(clis: FakeCli[]): ChatQueryFactory {
  return ({ prompt }) => {
    const queue: SDKMessage[] = []
    let wake: ((result: IteratorResult<SDKMessage>) => void) | null = null
    let ended = false
    const cli: FakeCli = { prompts: [], push: message => {
      if (wake) { const resolve = wake; wake = null; resolve({ value: message, done: false }) } else queue.push(message)
    } }
    const stream = async function* (): AsyncGenerator<SDKMessage, void> {
      while (true) {
        const next = await new Promise<IteratorResult<SDKMessage>>(resolve => {
          if (queue.length > 0) resolve({ value: queue.shift()!, done: false })
          else if (ended) resolve({ value: undefined, done: true })
          else wake = resolve
        })
        if (next.done) return
        yield next.value
      }
    }
    clis.push(cli)
    void (async () => { for await (const message of prompt) cli.prompts.push(message) })()
    return Object.assign(stream(), {
      interrupt: () => Promise.resolve(undefined),
      close: () => { ended = true; wake?.({ value: undefined, done: true }) },
    }) as unknown as Query
  }
}

let seq = 0
const frame = (fields: Record<string, unknown>) => ({ uuid: `f-${++seq}`, session_id: 'sdk-1', ...fields }) as unknown as SDKMessage
const init = () => frame({ type: 'system', subtype: 'init' })
const result = (prompt?: SDKUserMessage, fields: Record<string, unknown> = {}) => frame({
  ...(prompt?.uuid ? { user_message_uuid: prompt.uuid, user_message_uuids: [prompt.uuid] } : {}),
  type: 'result', subtype: 'success', is_error: false, num_turns: 1, total_cost_usd: 0, result: 'done',
  duration_ms: 1, duration_api_ms: 1, usage: { input_tokens: 1, output_tokens: 1 }, modelUsage: {}, permission_denials: [], stop_reason: null,
  ...fields,
})

const AGENTS = [
  { toolUseId: 'toolu_01VrcsgEY1BeB56hxXdU97vE', taskId: 'ae109e7e514ff68c5', description: 'Budget metrics and report tools' },
  { toolUseId: 'toolu_01WQ4kkYcB2CmZrWmweSnx8G', taskId: 'a1b9e4ba4fc743796', description: 'Budget task_get and task_text_read' },
]
const SUMMARY = "Agent terminated early due to an API error: You've hit your 5-hour limit · resets 1:50am (Asia/Yerevan) " +
  '(error type rate_limit, HTTP 429, request id req_011CggcfJfFwPm77jAjMXqYj, model sent to the API: claude-opus-5-5)'

async function waitFor(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const started = Date.now()
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error('Timed out waiting for condition')
    await Bun.sleep(5)
  }
}

let tempDir: string
let db: SessionDatabase
let manager: ChatSessionManager | null = null
/** Turns completed so far, every session. */
let completedTurns = 0
const saved = { key: process.env.ANTHROPIC_API_KEY, config: process.env.CLAUDE_CONFIG_DIR, home: process.env.HOME }

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-limit-resume-'))
  db = initDatabase({ path: path.join(tempDir, 'test.db') })
  process.env.ANTHROPIC_API_KEY = 'sk-test-key'
  process.env.CLAUDE_CONFIG_DIR = path.join(tempDir, 'claude-config')
  process.env.HOME = tempDir
})

afterEach(() => {
  manager?.dispatcher.close()
  manager?.shutdown()
  manager = null
  for (const [key, value] of [['ANTHROPIC_API_KEY', saved.key], ['CLAUDE_CONFIG_DIR', saved.config], ['HOME', saved.home]] as const) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  db.close()
  fs.rmSync(tempDir, { recursive: true, force: true })
})

/** A manager on fake CLIs with one human-created session in a plain-directory team. */
async function setup() {
  completedTurns = 0
  const clis: FakeCli[] = []
  const registry = new SessionRegistry()
  const project = path.join(tempDir, 'proj')
  fs.mkdirSync(project)
  manager = new ChatSessionManager({
    isDirectory: () => true, registry, db, onEvent: (_id, event) => { if (event.type === 'turn_completed') completedTurns++ },
    profileCatalogHome: tempDir,
    queryFactory: fakeQueryFactory(clis),
    providerUsageFetch: (async () => { throw new Error('no provider pulls') }) as unknown as typeof fetch,
  })
  await manager.whenRestored()
  const created = manager.createSession({ projectPath: project })
  if (!created.ok) throw new Error(created.error)
  const id = created.session.id
  await waitFor(() => manager!.teams.teamOf(id) !== undefined)
  return { clis, registry, id }
}

/** The human's turn starts both background agents and ends. */
async function humanTurnStartsAgents(id: string, clis: FakeCli[]) {
  expect((await manager!.send(id, 'implement the budget change')).ok).toBe(true)
  await waitFor(() => clis.length > 0 && clis[0]!.prompts.length > 0)
  const cli = clis[0]!
  cli.push(init())
  for (const agent of AGENTS) {
    cli.push(frame({ type: 'assistant', parent_tool_use_id: null, message: { id: `msg_${agent.taskId}`, role: 'assistant',
      content: [{ type: 'tool_use', id: agent.toolUseId, name: 'Agent', input: { description: agent.description, prompt: 'work', subagent_type: 'general-purpose' } }] } }))
    cli.push(frame({ type: 'system', subtype: 'task_started', task_id: agent.taskId, tool_use_id: agent.toolUseId, description: agent.description,
      subagent_type: 'general-purpose', is_backgrounded: true, spawn_depth: 1, task_type: 'local_agent' }))
  }
  cli.push(result(cli.prompts[0]))
  await waitFor(() => completedTurns === 1 && (manager!.getSnapshot(id)?.workers ?? []).length === 2)
  return cli
}

/** A background agent dies on the 429; when `parentLimited`, the parent's own call then hits the final limit. */
function agentFails(cli: FakeCli, agent: typeof AGENTS[number], resetsAtSec: number, parentLimited: boolean) {
  cli.push(frame({ type: 'system', subtype: 'task_notification', task_id: agent.taskId, tool_use_id: agent.toolUseId, status: 'failed', summary: SUMMARY }))
  cli.push(init())
  if (parentLimited) {
    cli.push(frame({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: resetsAtSec, rateLimitType: 'five_hour' } }))
    cli.push(frame({ type: 'assistant', error: 'rate_limit', parent_tool_use_id: null,
      message: { id: `err_${agent.taskId}`, role: 'assistant', content: [{ type: 'text', text: "You've hit your 5-hour limit · resets 1:50am (Asia/Yerevan)" }] } }))
    cli.push(result(undefined, { is_error: true, result: "You've hit your 5-hour limit", api_error_status: 429 }))
  } else {
    cli.push(result(undefined, { result: '' }))
  }
}

const limitResumes = (id: string) => (db.db.prepare(`SELECT id, state, deliver_at, body FROM team_messages WHERE to_id = ? AND tags LIKE '%"limit-resume"%' ORDER BY rowid`)
  .all(id) as Array<{ id: string; state: string; deliver_at: string; body: string }>)
const promptText = (prompt: SDKUserMessage) => JSON.stringify(prompt.message.content)

// @covers: profile-limit-handling › Limited human sessions resume at the reset › Human turn hits the limit
// @covers: profile-limit-handling › Limit-resumes name the workers lost to the limit › Two background agents lost
// @covers: profile-limit-handling › A pending limit-resume shows the session as paused › Paused until the reset
test('the incident: a limited human chat is paused, then resumed at the reset naming both lost agents', async () => {
  const { clis, registry, id } = await setup()
  const cli = await humanTurnStartsAgents(id, clis)
  // The reset is a few seconds out, so the dispatcher delivers within the test.
  const resetsAtSec = Math.ceil(Date.now() / 1000) + 3
  agentFails(cli, AGENTS[0]!, resetsAtSec, true)
  await waitFor(() => limitResumes(id).length === 1)
  agentFails(cli, AGENTS[1]!, resetsAtSec, false)
  await waitFor(() => limitResumes(id).some(row => row.state === 'queued' && row.body.includes(AGENTS[1]!.taskId)))

  // O3, O15a: exactly one pending resume at the reset, naming both agents.
  const queued = limitResumes(id).filter(row => row.state === 'queued')
  expect(queued).toHaveLength(1)
  expect(queued[0]!.deliver_at).toBe(new Date(resetsAtSec * 1000).toISOString())
  for (const agent of AGENTS) expect(queued[0]!.body).toContain(`- "${agent.description}" (task ${agent.taskId})`)
  // D9: paused until the resume's own time.
  await waitFor(() => registry.get(id)?.parked?.messageId === queued[0]!.id)
  expect(registry.get(id)?.parked).toMatchObject({ until: queued[0]!.deliver_at, profileId: 'default' })

  // O20: at the reset the resume is delivered as a turn of its own, without human input.
  const before = cli.prompts.length
  await waitFor(() => cli.prompts.length > before, 10_000)
  const delivered = promptText(cli.prompts.at(-1)!)
  expect(delivered).toContain('has reset')
  for (const agent of AGENTS) expect(delivered).toContain(agent.taskId)
  await waitFor(() => limitResumes(id).every(row => row.state !== 'queued'))
  await waitFor(() => registry.get(id)?.parked == null)
}, 20_000)

// @covers: profile-limit-handling › A pending limit-resume shows the session as paused › Pause clears on cancel
test('O12: the human continuing before the reset cancels the resume and the pause', async () => {
  const { clis, registry, id } = await setup()
  const cli = await humanTurnStartsAgents(id, clis)
  agentFails(cli, AGENTS[0]!, Math.ceil(Date.now() / 1000) + 3600, true)
  await waitFor(() => limitResumes(id).length === 1 && registry.get(id)?.parked != null)
  expect((await manager!.send(id, 'continue')).ok).toBe(true)
  await waitFor(() => cli.prompts.length >= 2)
  cli.push(init())
  cli.push(result(cli.prompts.at(-1)))
  await waitFor(() => limitResumes(id)[0]?.state === 'cancelled')
  await waitFor(() => registry.get(id)?.parked == null)
}, 20_000)

// @covers: profile-limit-handling › The human's own activity cancels a pending limit-resume › Session archived while waiting
test('O18: archiving cancels the pending resume, and the session stays archived', async () => {
  const { clis, id } = await setup()
  const cli = await humanTurnStartsAgents(id, clis)
  agentFails(cli, AGENTS[0]!, Math.ceil(Date.now() / 1000) + 3600, true)
  await waitFor(() => limitResumes(id).length === 1)
  expect(manager!.archive(id).ok).toBe(true)
  expect(limitResumes(id)[0]?.state).toBe('cancelled')
  manager!.dispatcher.notify()
  await manager!.dispatcher.settled()
  const row = db.db.prepare('SELECT archived_at FROM chat_sessions WHERE session_id = ?').get(id) as { archived_at: string | null }
  expect(row.archived_at).not.toBeNull()
}, 20_000)
