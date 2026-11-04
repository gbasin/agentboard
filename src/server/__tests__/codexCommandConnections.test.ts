// W1: production manager -> Codex driver -> real app-server client -> fake
// executable -> ChatConnections fanout/snapshot, with independent home/cwd.
import { afterEach, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ServerMessage } from '../../shared/types'
import { ChatConnections } from '../chat/ChatConnections'
import { ChatSessionManager } from '../chat/ChatSessionManager'
import { resetCodexExecutableCache } from '../chat/codex/codexExecutable'
import { initDatabase, type SessionDatabase } from '../db'
import { SessionRegistry } from '../SessionRegistry'
import { FAKE_CODEX, Script, until } from './codexDriverHarness'

// Table W1 verbatim: [Id, Input / seam, Observable result].
const oracle = ['W1', 'Real manager driver factory, attach two subscribers then refresh skills', 'Both receive loading/ready changes; reconnect snapshot matches']
const envKeys = ['CODEX_HOME', 'KAWAI_CODEX_PATH', 'FAKE_TRANSCRIPT', 'FAKE_RUN']
const original = envKeys.map(key => process.env[key])
let manager: ChatSessionManager | undefined
let connections: ChatConnections | undefined
let db: SessionDatabase | undefined
let dir: string | undefined
afterEach(() => {
  connections?.stop(); manager?.shutdown(); db?.close()
  if (dir) fs.rmSync(dir, { recursive: true, force: true })
  envKeys.forEach((key, i) => { if (original[i] === undefined) delete process.env[key]; else process.env[key] = original[i] })
  resetCodexExecutableCache()
})

// @covers: codex-chat-sessions › Codex command discovery refreshes without interrupting chat › Reconnecting and archived chats
// @covers: codex-chat-sessions › Codex command discovery refreshes without interrupting chat › Skills change while attached
test('W1/L8/L9/C4: two subscribers see refreshed Codex commands and reconnect snapshots without cross-session leakage', async () => {
  expect(oracle[0]).toBe('W1')
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codex-command-connections-')))
  const home = path.join(dir, 'home')
  const projectA = path.join(dir, 'a'), projectB = path.join(dir, 'b')
  const homeA = path.join(dir, 'codex-a'), homeB = path.join(dir, 'codex-b')
  for (const p of [projectA, projectB, homeA, homeB, path.join(home, '.kawai')]) fs.mkdirSync(p, { recursive: true })
  for (const p of [homeA, homeB]) fs.writeFileSync(path.join(p, 'auth.json'), JSON.stringify({ tokens: { access_token: 'fake' } }))
  fs.writeFileSync(path.join(home, '.kawai/profiles.json'), JSON.stringify({
    'codex-a': { label: 'A', runtime: 'codex', codexHome: homeA },
    'codex-b': { label: 'B', runtime: 'codex', codexHome: homeB },
  }))
  const catalog = (cwd: string, name: string) => ({ cwd, errors: [], skills: [
    { name, description: name, enabled: true, path: `/skills/${name}/SKILL.md`, scope: 'repo' },
  ] })
  const gate = path.join(dir, 'refresh')
  const script = new Script().boot('thread/start', 'test', path.join(homeA, 'rollout.jsonl'))
    .request('account/rateLimits/read', {})
    .request('skills/list', { data: [catalog(projectB, 'foreign'), catalog(projectA, 'explore')] })
    .gate(gate).notify('skills/changed', {})
    .request('skills/list', { data: [catalog(projectA, 'review')] })
  script.lines.push(...new Script().boot('thread/start', 'test', path.join(homeB, 'rollout.jsonl'))
    .request('account/rateLimits/read', {}).request('skills/list', { data: [catalog(projectB, 'other')] }).lines)
  process.env.FAKE_TRANSCRIPT = script.write(dir)
  process.env.KAWAI_CODEX_PATH = FAKE_CODEX; process.env.CODEX_HOME = homeA; process.env.FAKE_RUN = '1'
  resetCodexExecutableCache()
  db = initDatabase({ path: path.join(dir, 'db.sqlite') })
  manager = new ChatSessionManager({
    db, registry: new SessionRegistry(), profileCatalogHome: home, availabilityProbe: async () => {},
    onEvent() {}, onCommandState: (id, state) => connections?.publishCommandState(id, state),
  })
  connections = new ChatConnections(manager)
  await manager.whenRestored()
  const first = await manager.createAvailableSession({ projectPath: projectA, claudeProfileId: 'codex-a' })
  if (!first.ok) throw new Error(first.error)
  const id = first.session.id
  const messagesA: ServerMessage[] = [], messagesB: ServerMessage[] = []
  const a = { send: (message: ServerMessage) => messagesA.push(message) }
  const b = { send: (message: ServerMessage) => messagesB.push(message) }
  await connections.handle(a, { type: 'chat-attach', sessionId: id })
  await connections.handle(b, { type: 'chat-attach', sessionId: id })
  await until(() => manager!.getSnapshot(id)!.commands.status === 'ready')
  expect(manager.getSnapshot(id)!.commands.commands.map(command => command.name)).toEqual(['explore'])
  for (const messages of [messagesA, messagesB]) {
    expect(messages.some(message => message.type === 'chat-commands' && message.state.status === 'ready')).toBe(true)
  }
  messagesA.length = 0; messagesB.length = 0
  fs.writeFileSync(gate, '')
  await until(() => manager!.getSnapshot(id)!.commands.commands[0]?.name === 'review')
  for (const messages of [messagesA, messagesB]) {
    expect(messages.filter(message => message.type === 'chat-commands').map(message => message.state.status)).toEqual(['loading', 'ready'])
  }
  const reconnected: ServerMessage[] = []
  await connections.handle({ send: message => reconnected.push(message) }, { type: 'chat-attach', sessionId: id })
  expect(reconnected.find(message => message.type === 'chat-snapshot')).toMatchObject({ commands: manager.getSnapshot(id)!.commands })

  process.env.FAKE_RUN = '2'
  const second = await manager.createAvailableSession({ projectPath: projectB, claudeProfileId: 'codex-b' })
  if (!second.ok) throw new Error(second.error)
  await manager.start(second.session.id)
  await until(() => manager!.getSnapshot(second.session.id)!.commands.status === 'ready')
  expect(manager.getSnapshot(second.session.id)!.commands.commands.map(command => command.name)).toEqual(['other'])
  expect(manager.getSnapshot(id)!.commands.commands.map(command => command.name)).toEqual(['review'])
  manager.archive(id)
  expect(manager.getSnapshot(id)!.commands.status).toBe('unavailable')
  const archived: ServerMessage[] = []
  await connections.handle({ send: message => archived.push(message) }, { type: 'chat-attach', sessionId: id })
  expect(archived.find(message => message.type === 'chat-snapshot')).toMatchObject({ commands: { status: 'unavailable', commands: [] } })
  expect(manager.getSnapshot(id)!.commands.status).toBe('unavailable')
})
