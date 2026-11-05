// Shared composer acceptance rows W2-W4/W6 on both runtime fixtures.
import { afterEach, expect, test } from 'bun:test'
import TestRenderer, { act } from 'react-test-renderer'
import type { ClientMessage, ServerMessage, Session } from '../../shared/types'
import ChatView from '../components/chat/ChatView'
import { useChatStore } from '../stores/chatStore'

// Table W2-W4/W6 verbatim: [Id, Input / seam, Observable result].
const oracles = [
  ['W2', 'Codex composer: name/description filter, Up/Down then Tab/Enter; pointer hover/click', 'Visible selection follows choice; replaces only caret word with slash name and space; sends nothing'],
  ['W3', 'Codex composer: later line, path, Escape, no-match Enter', 'Later line opens; paths do not; Escape preserves draft; no-match sends text'],
  ['W4', 'Local /clear, /reset, /new versus middle-of-message /clear', 'Local commands keep profile/policy and create/archive as before; middle word goes unchanged with no skill'],
  ['W6', 'Claude composer and driver regression fixture', 'Existing command discovery, insertion, and submission unchanged'],
] as const
afterEach(() => useChatStore.setState({ sessions: {}, drafts: {}, closedAccountNotices: {} }))

function composer(runtime: 'codex' | 'claude') {
  const session = { id: 'chat-autocomplete', kind: 'chat', name: 'Test', runtime,
    projectPath: '/project', status: 'waiting', claudeProfileId: `${runtime}-profile`, approvalPolicy: 'auto' } as Session
  useChatStore.getState().setCommands({ type: 'chat-commands', sessionId: session.id, state: { status: 'ready', commands: [
    { name: 'explore', description: 'Investigate code', source: 'project', aliases: [] },
    { name: 'review', description: 'Find defects', source: 'user', aliases: [] },
  ] } })
  const sent: ClientMessage[] = []
  const listeners: Array<(message: ServerMessage) => void> = []
  let renderer!: TestRenderer.ReactTestRenderer
  act(() => { renderer = TestRenderer.create(<ChatView session={session}
    sendMessage={message => sent.push(message)} subscribe={listener => { listeners.push(listener); return () => {} }}
    connectionStatus="connected" connectionEpoch={0} error={null} onClose={() => {}} onKill={() => {}} />) })
  const textarea = () => renderer.root.findByType('textarea')
  const type = (value: string, caret = value.length) => act(() => textarea().props.onChange({ target: { value, selectionStart: caret, selectionEnd: caret } }))
  const submit = () => act(() => renderer.root.findByType('form').props.onSubmit({ preventDefault() {} }))
  const key = (key: string) => act(() => textarea().props.onKeyDown({ key, preventDefault() {}, currentTarget: { form: { requestSubmit: submit } } }))
  const options = () => renderer.root.findAllByProps({ role: 'option' })
  return { renderer, session, sent, listeners, textarea, type, submit, key, options }
}

for (const runtime of ['codex', 'claude'] as const) {
  // @covers: codex-chat-sessions › Codex autocomplete uses the shared composer interactions › Choose a skill in the middle of a message
  // @covers: codex-chat-sessions › Codex autocomplete uses the shared composer interactions › Pointer selection and dismissal
  test(`W2/W6: ${runtime} filters, highlights and inserts at the caret by keyboard and pointer without sending`, () => {
    expect(oracles.map(row => row[0])).toContain('W2')
    const h = composer(runtime)
    h.type('please /invest on this', 14)
    expect(h.options().map(option => option.props['data-command-name'])).toEqual(['explore'])
    h.key('Tab')
    expect(h.textarea().props.value).toBe('please /explore on this')
    h.type('please / on this', 8)
    h.key('ArrowDown')
    expect(h.options()[1]!.props['aria-selected']).toBe(true)
    expect(h.options()[1]!.props.className).toContain('bg-hover')
    h.key('ArrowUp'); h.key('Enter')
    expect(h.textarea().props.value).toBe('please /explore on this')
    h.type('/'); act(() => h.options()[1]!.props.onPointerEnter())
    expect(h.options()[1]!.props['aria-selected']).toBe(true)
    act(() => h.options()[1]!.props.onClick())
    expect(h.textarea().props.value).toBe('/review ')
    expect(h.sent.filter(message => message.type === 'chat-send')).toEqual([])
    h.renderer.unmount()
  })

  // @covers: codex-chat-sessions › Codex autocomplete uses the shared composer interactions › Paths and unknown names
  test(`W3/W6: ${runtime} later lines, paths, Escape and unknown-command sending retain existing behavior`, () => {
    const h = composer(runtime)
    h.type('first\n/exp'); expect(h.options()).toHaveLength(1)
    h.key('Escape'); expect(h.options()).toHaveLength(0)
    expect(h.textarea().props.value).toBe('first\n/exp')
    for (const value of ['https://example', '/usr/bin']) {
      h.type(value)
      expect(h.renderer.root.findAllByProps({ role: 'listbox' })).toHaveLength(0)
    }
    h.type('/missing'); h.key('Enter')
    expect(h.sent.filter(message => message.type === 'chat-send')).toEqual([{ type: 'chat-send', sessionId: h.session.id, text: '/missing' }])
    h.renderer.unmount()
  })
}

for (const command of ['/clear', '/reset', '/new']) {
  test(`W4: Codex ${command} keeps the profile and policy, archives after creation, and middle /clear stays text`, () => {
    const h = composer('codex')
    h.type('please /clear later'); h.submit()
    expect(h.sent.find(message => message.type === 'chat-send')).toMatchObject({ text: 'please /clear later' })
    h.sent.length = 0
    h.type(command); h.submit()
    expect(h.sent.find(message => message.type === 'session-create')).toMatchObject({ claudeProfileId: 'codex-profile', approvalPolicy: 'auto', projectPath: '/project' })
    expect(h.sent.some(message => message.type === 'chat-send' || message.type === 'chat-archive')).toBe(false)
    const next = { ...h.session, id: 'next' }
    act(() => h.listeners.forEach(listener => listener({ type: 'session-created', session: next })))
    expect(h.sent.find(message => message.type === 'chat-archive')).toEqual({ type: 'chat-archive', sessionId: h.session.id })
    h.renderer.unmount()
  })
}
