// Submission table S: assertions inspect actual turn/start inputs through
// the production driver and scripted app-server; P2 exercises the resolver.
import { afterEach, expect, test } from 'bun:test'
import { codexCommandCatalog, codexSkillInputs } from '../chat/codex/codexCommands'
import { Script, startHarness, tempDirs, until, type Harness } from './codexDriverHarness'
import { formatEnvelope } from '../team/envelope'
import type { ChatPeerMessage } from '../../shared/chat'
import { CodexSessionDriver } from '../chat/codex/CodexSessionDriver'
import type { AppServerClientOptions } from '../chat/codex/appServerClient'

// Table S verbatim: [Id, Origin / catalog / text, Observable Codex input].
export const submissionOracles = [
  ['S1', 'Peer or internal continuation / * / contains slash references', 'Text only; no skill inputs'],
  ['S2', 'Human / loading or unavailable / *', 'Text only, request does not await discovery'],
  ['S3', 'Human / ready / exact eligible slash word anywhere', 'Original text then skill with server-reported name/path'],
  ['S4', 'Human / ready / unknown, removed, ambiguous, disabled, reserved name', 'No skill for that word'],
  ['S5', 'Human / ready / path, URL, case mismatch, punctuation suffix, partial name', 'No skill for that word'],
  ['S6', 'Human / ready / repeated and multiple exact eligible references', 'One skill input per name, first-reference order'],
  ['S7', 'Human accepted in ready state; catalog changes before turn/start', 'Skill identities captured at send remain fixed'],
] as const

const skill = (name: string, extra = {}) => ({ name, path: `/skills/${name}/SKILL.md`, enabled: true, scope: 'repo', description: name, ...extra })
const skills = [skill('explore'), skill('review'), skill('off', { enabled: false }),
  skill('ambiguous'), skill('ambiguous', { path: '/elsewhere/SKILL.md' }), skill('clear')]
const response = (cwd: string) => ({ data: [{ cwd, skills, errors: [] }] })
const textInput = (text: string) => ({ type: 'text', text, text_elements: [] })
const native = (name: string) => ({ type: 'skill' as const, name, path: `/skills/${name}/SKILL.md` })
let harness: Harness | null = null
afterEach(() => { harness?.cleanup(); harness = null })

for (const [id, text, expected] of [
  ['S3', 'please /explore this', ['explore']],
  ['S4', '/missing /off /ambiguous /clear', []],
  ['S5', 'x/explore https://explore /explore/more /explore, /Explore /exp', []],
  ['S6', '/review\n/explore /review', ['review', 'explore']],
] as const) {
  // @covers: codex-chat-sessions › Human slash-skill references invoke explicit Codex skills › Invoke a completed or manually typed skill
  // @covers: codex-chat-sessions › Human slash-skill references invoke explicit Codex skills › Repeated and multiple skills
  // @covers: codex-chat-sessions › Human slash-skill references invoke explicit Codex skills › Exact reference boundaries
  test(`${id}: ${submissionOracles.find(row => row[0] === id)![1]} on an actual Codex turn`, async () => {
    const dirs = tempDirs()
    const script = new Script().boot().request('skills/list', response(dirs.project)).turn('ct-1')
    harness = startHarness(script, {}, dirs)
    harness.driver.start(); await until(() => harness!.driver.getCommandState().status === 'ready')
    harness.driver.send(text)
    await until(() => harness!.sent.some(message => message.method === 'turn/start'))
    expect(harness.sent.find(message => message.method === 'turn/start')!.params!.input)
      .toEqual([textInput(text), ...expected.map(native)])
    expect(harness.events.find(event => event.type === 'user_message')).toMatchObject({ text })
  })
}

// @covers: codex-chat-sessions › Human slash-skill references invoke explicit Codex skills › A reference no longer resolves
test('S2: a send accepted before discovery stays plain text even when boot discovers the skill', async () => {
  const dirs = tempDirs()
  harness = startHarness(new Script().boot().request('skills/list', response(dirs.project)).turn('ct-1'), {}, dirs)
  harness.driver.send('/explore')
  await until(() => harness!.sent.some(message => message.method === 'turn/start'))
  expect(harness.sent.find(message => message.method === 'turn/start')!.params!.input).toEqual([textInput('/explore')])
})

// @covers: codex-chat-sessions › Human slash-skill references invoke explicit Codex skills › Peer mail and history
test('S1/S7: peer text never attaches skills; active-turn human inputs keep their send-time identities', async () => {
  const dirs = tempDirs()
  const script = new Script().boot().request('skills/list', response(dirs.project)).turn('ct-1').completed('ct-1')
    .turn('ct-2').request('turn/start', { turn: { id: 'ct-2' } })
  harness = startHarness(script, {}, dirs)
  harness.driver.start(); await until(() => harness!.driver.getCommandState().status === 'ready')
  const peer: ChatPeerMessage = {
    messageId: 'mail-1', senderSession: 'sender', senderGroup: null, priority: 'normal', possibleDuplicate: false,
    originPath: '/project', threadId: 'thread-1', tags: [], body: '/explore',
  }
  harness.driver.deliver(peer)
  await until(() => harness!.events.some(event => event.type === 'turn_completed'))
  expect(harness.sent.filter(message => message.method === 'turn/start')[0]!.params!.input).toEqual([textInput(formatEnvelope(peer))])
  harness.driver.send('/explore')
  // Invalidate synchronously before ready.then executes; the accepted input
  // must retain the ready catalog captured by send, not a fresh empty one.
  harness.driver.setProjectPath('/different')
  await until(() => harness!.sent.filter(message => message.method === 'turn/start').length === 2)
  expect(harness.sent.filter(message => message.method === 'turn/start')[1]!.params!.input).toEqual([textInput('/explore'), native('explore')])
  // The second input steers the active turn; after invalidation it is plain.
  harness.driver.send('/review')
  await until(() => harness!.sent.filter(message => message.method === 'turn/start').length === 3)
  expect(harness.sent.filter(message => message.method === 'turn/start')[2]!.params!.input).toEqual([textInput('/review')])
})

test('P2: 1000 seeded messages preserve text and attach only exact accepted identities', async () => {
  let state = 0xC0DE02
  const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state }
  const catalog = codexCommandCatalog(response('/project'), '/project')!
  const words = ['/explore', '/review', '/off', '/missing', '/explore,', 'x/explore', '/Explore', '/explore/more']
  let callbacks!: AppServerClientOptions
  const requests: Array<Record<string, unknown>> = []
  const driver = new CodexSessionDriver({
    sessionId: 'property', projectPath: '/tmp', executable: 'unused', codexHome: '/tmp/unused', network: true,
    withheldCredentials: () => new Set(), wire: { record() {} }, onEvent() {}, onStatus() {},
    createClient: options => {
      callbacks = options
      return { start() {}, end() {}, initialize: async () => ({}), request: async (method, params) => {
        if (method === 'skills/list') return response('/tmp')
        if (method === 'turn/start') { requests.push(params!); return { turn: { id: `t-${requests.length}` } } }
        return { thread: { id: 'thread' } }
      } }
    },
  })
  driver.start(); await until(() => driver.getCommandState().status === 'ready')
  try {
    for (let i = 0; i < 1000; i++) {
      const message = Array.from({ length: 1 + random() % 12 }, () => words[random() % words.length]!).join(i % 2 ? '\n' : ' ')
      const expected = [...new Set(message.split(/\s+/).filter(word => word === '/explore' || word === '/review'))].map(word => native(word.slice(1)))
      expect(codexSkillInputs(message, catalog)).toEqual(expected)
      expect(codexSkillInputs(message, null)).toEqual([])
      const peer: ChatPeerMessage = { messageId: `mail-${i}`, senderSession: 'sender', senderGroup: null,
        priority: 'normal', possibleDuplicate: false, originPath: '/project', threadId: 'peer-thread', tags: [], body: message }
      const isPeer = i % 3 === 0
      if (isPeer) driver.deliver(peer)
      else driver.send(message)
      for (let microtask = 0; microtask < 8; microtask++) await Promise.resolve()
      expect(requests.at(-1)!.input).toEqual([textInput(isPeer ? formatEnvelope(peer) : message), ...(isPeer ? [] : expected)])
      callbacks.onNotification('turn/completed', { turn: { id: `t-${requests.length}`, status: 'completed', items: [], error: null } })
    }
  } finally { driver.kill() }
})
