import { afterEach, describe, expect, jest, test } from 'bun:test'
import TestRenderer, { act, type ReactTestInstance } from 'react-test-renderer'
import type { ChatActivity, ChatBackgroundTask, ChatCommandState, ChatContextUsage, ChatEvent, ChatNotification, ChatPendingRequest, ChatRuntime, ChatUsageReport, ChatWireFrame, ChatWorker } from '@shared/chat'
import type { ClientMessage, ServerMessage, Session } from '@shared/types'
import ChatRequests from '../components/chat/ChatRequests'
import ChatMessages from '../components/chat/ChatMessages'
import ChatDebugPanel from '../components/chat/ChatDebugPanel'
import ChatView from '../components/chat/ChatView'
import ChatActivityRow from '../components/chat/ChatActivityRow'
import ChatWorkersStrip from '../components/chat/ChatWorkersStrip'
import { formatContextTokens } from '../components/chat/ChatContextMeter'
import UsageBar from '../components/chat/UsageBar'
import NotificationStrip from '../components/chat/NotificationStrip'
import { closedDebugView, useChatDebugStore, type ChatDebugView } from '../stores/chatDebugStore'
import { emptyTranscript, useChatStore } from '../stores/chatStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useTeamTaskStore } from '../stores/teamTaskStore'
import { resetTeamLocationForTests, useTeamLocationStore } from '../hooks/useTeamLocation'
import { Switch } from '../components/Switch'
import { chooseSessionMenuEntry, sessionMenuEntry } from './support/sessionMenu'

describe('chat components', () => {
  test('the load-earlier control renders its states (chat-history-window 4.1)', () => {
    const message: ChatEvent[] = [
      { type: 'user_message', id: 'u1', sequence: 0, at: 'now', turnId: 't', text: 'hello' },
    ]
    // Older history exists: the button offers to load, disabled while
    // loading or disconnected.
    const offered = TestRenderer.create(<ChatMessages events={message} connected
      historyHasOlder historyLoading={false} onLoadEarlier={() => {}} />)
    const button = offered.root.findByProps({ 'data-testid': 'chat-load-earlier' })
    expect(button.props.disabled).toBe(false)
    expect(button.children).toEqual(['Load earlier messages'])
    offered.unmount()
    const loading = TestRenderer.create(<ChatMessages events={message} connected
      historyHasOlder historyLoading onLoadEarlier={() => {}} />)
    const loadingButton = loading.root.findByProps({ 'data-testid': 'chat-load-earlier' })
    expect(loadingButton.props.disabled).toBe(true)
    expect(loadingButton.children).toEqual(['Loading…'])
    loading.unmount()
    const offline = TestRenderer.create(<ChatMessages events={message} connected={false}
      historyHasOlder historyLoading={false} onLoadEarlier={() => {}} />)
    expect(offline.root.findByProps({ 'data-testid': 'chat-load-earlier' }).props.disabled).toBe(true)
    offline.unmount()
    // Nothing older: the start-of-conversation marker replaces the button.
    const start = TestRenderer.create(<ChatMessages events={message} connected
      historyHasOlder={false} historyLoading={false} onLoadEarlier={() => {}} />)
    expect(start.root.findByProps({ 'data-testid': 'chat-history-start' }).children).toEqual(['Beginning of conversation'])
    // The only button left is the message row's own copy control.
    expect(start.root.findAllByType('button').map(button => button.props['data-testid'])).toEqual(['chat-message-copy'])
    start.unmount()
    // No history at all: neither control nor marker.
    const empty = TestRenderer.create(<ChatMessages events={[]} connected
      historyHasOlder={false} historyLoading={false} onLoadEarlier={() => {}} />)
    expect(empty.root.findByProps({ 'data-testid': 'chat-transcript' }).children).toEqual([])
    empty.unmount()
    // A nested transcript (no onLoadEarlier) never renders the control.
    const nested = TestRenderer.create(<ChatMessages events={message} connected historyHasOlder />)
    expect(nested.root.findAllByProps({ 'data-testid': 'chat-history-top' })).toHaveLength(0)
    nested.unmount()
  })

  test('clicking the load-earlier control asks the view to page', () => {
    let clicked = 0
    const renderer = TestRenderer.create(<ChatMessages
      events={[{ type: 'user_message', id: 'u1', sequence: 0, at: 'now', turnId: 't', text: 'hello' }]}
      connected historyHasOlder historyLoading={false} onLoadEarlier={() => { clicked += 1 }} />)
    act(() => { renderer.root.findByProps({ 'data-testid': 'chat-load-earlier' }).props.onClick() })
    expect(clicked).toBe(1)
    renderer.unmount()
  })

  test('approval cards send allow and deny without hiding the pending request locally', () => {
    const sent: ClientMessage[] = []
    const renderer = TestRenderer.create(<ChatRequests sessionId="chat-1" disabled={false} sendMessage={message => sent.push(message)}
      requests={[{ kind: 'approval', requestId: 'r', tool: 'Bash', input: { command: 'ls' }, at: 'now' }]} />)
    const buttons = renderer.root.findAllByType('button')
    act(() => { buttons[0]!.props.onClick(); buttons[1]!.props.onClick() })
    expect(sent).toEqual([
      { type: 'chat-approval', sessionId: 'chat-1', requestId: 'r', decision: 'allow' },
      { type: 'chat-approval', sessionId: 'chat-1', requestId: 'r', decision: 'deny' },
    ])
    expect(renderer.root.findAllByType('section')).toHaveLength(1)
    renderer.unmount()
  })

  test('question forms submit multiple selections and free text', () => {
    const sent: ClientMessage[] = []
    const renderer = TestRenderer.create(<ChatRequests sessionId="chat-1" disabled={false} sendMessage={message => sent.push(message)}
      requests={[{ kind: 'question', requestId: 'q', at: 'now', questions: [{ question: 'Choose colors', header: 'Colors', multiSelect: true,
        options: [{ label: 'Blue' }, { label: 'Green' }] }] }]} />)
    expect(renderer.root.findByType('button').props.disabled).toBe(true)
    act(() => renderer.root.findAllByType('input')[0]!.props.onChange({ target: { checked: true } }))
    act(() => renderer.root.findAllByType('input')[1]!.props.onChange({ target: { checked: true } }))
    act(() => renderer.root.findAllByType('input')[2]!.props.onChange({ target: { value: 'and purple' } }))
    act(() => renderer.root.findByType('form').props.onSubmit({ preventDefault: () => {} }))
    expect(sent).toEqual([{ type: 'chat-answer', sessionId: 'chat-1', requestId: 'q', answers: {
      'Choose colors': { options: ['Blue', 'Green'], text: 'and purple' },
    } }])
    renderer.unmount()
  })

  test('single-select question forms keep one answer: an option or own text', () => {
    const sent: ClientMessage[] = []
    const renderer = TestRenderer.create(<ChatRequests sessionId="chat-1" disabled={false} sendMessage={message => sent.push(message)}
      requests={[{ kind: 'question', requestId: 'q', at: 'now', questions: [{ question: 'Pick', header: 'Pick', multiSelect: false,
        options: [{ label: 'A' }, { label: 'B' }] }] }]} />)
    const inputs = () => renderer.root.findAllByType('input')
    const submit = () => act(() => renderer.root.findByType('form').props.onSubmit({ preventDefault: () => {} }))
    act(() => inputs()[0]!.props.onChange({ target: { checked: true } }))
    act(() => inputs()[2]!.props.onChange({ target: { value: 'my own' } }))
    expect(inputs()[0]!.props.checked).toBe(false)
    submit()
    act(() => inputs()[1]!.props.onChange({ target: { checked: true } }))
    expect(inputs()[2]!.props.value).toBe('')
    submit()
    expect(sent).toEqual([
      { type: 'chat-answer', sessionId: 'chat-1', requestId: 'q', answers: { Pick: { text: 'my own' } } },
      { type: 'chat-answer', sessionId: 'chat-1', requestId: 'q', answers: { Pick: { options: ['B'] } } },
    ])
    renderer.unmount()
  })

  test('assistant markdown and tool activity render without executing raw HTML', () => {
    const renderer = TestRenderer.create(<ChatMessages events={[
      { type: 'assistant_text', id: 'a', sequence: 0, at: 'now', turnId: 't', messageId: 'm', text: '**Hello** <script>bad()</script>' },
      { type: 'tool_call', id: 'b', sequence: 0, at: 'now', turnId: 't', toolCallId: 'tool-1', tool: 'Read', input: { file_path: 'file.ts' } },
    ]} />)
    expect(renderer.root.findByType('strong').children).toEqual(['Hello'])
    expect(renderer.root.findAllByType('script')).toHaveLength(0)
    expect(textOf(renderer.root.findByType('summary'))).toBe('Read(file.ts)')
    renderer.unmount()
  })

  test('tool-call summaries show a project-relative detail that truncates with the full value on hover', () => {
    const command = 'bun run lint && bun run typecheck && bun run test --coverage --reporter=junit'
    const renderer = TestRenderer.create(<ChatMessages projectPath="/tmp/project" events={[
      { type: 'tool_call', id: 'r', sequence: 0, at: 'now', turnId: 't', toolCallId: 't1', tool: 'Read',
        input: { file_path: '/tmp/project/src/index.ts' } },
      { type: 'tool_call', id: 'b', sequence: 1, at: 'now', turnId: 't', toolCallId: 't2', tool: 'Bash',
        input: { command: 'bun run lint\nbun run test' } },
      { type: 'tool_call', id: 'l', sequence: 2, at: 'now', turnId: 't', toolCallId: 't3', tool: 'Bash',
        input: { command } },
    ]} />)
    const summaries = renderer.root.findAllByType('summary')
    expect(textOf(summaries[0]!)).toBe('Read(src/index.ts)')
    expect(textOf(summaries[1]!)).toBe('Bash(bun run lint bun run test)')
    // The full detail rides along on the truncating span for the hover tooltip.
    const detail = summaries[2]!.findByProps({ title: command })
    expect(detail.children).toEqual([command])
    expect(String(detail.props.className).split(' ')).toContain('truncate')
    // The JSON body keeps the full input for expanding.
    expect(renderer.root.findAllByType('pre')).toHaveLength(3)
    expect(textOf(renderer.root.findAllByType('pre')[2]!)).toBe(JSON.stringify({ command }, null, 2))
    renderer.unmount()
  })

  test('a tool with no usable detail field renders exactly the plain label', () => {
    const renderer = TestRenderer.create(<ChatMessages projectPath="/tmp/project" events={[
      { type: 'tool_call', id: 'm', sequence: 0, at: 'now', turnId: 't', toolCallId: 't1', tool: 'mcp__db__query',
        input: { sql: 'select 1' } },
    ]} />)
    const summary = renderer.root.findByType('summary')
    expect(textOf(summary)).toBe('mcp__db__query')
    expect(summary.findAll(node => node.props.title != null)).toHaveLength(0)
    renderer.unmount()
  })

  test('tool-call summaries show formatted details', () => {
    const renderer = TestRenderer.create(<ChatMessages projectPath="/tmp/project" events={[
      { type: 'tool_call', id: 'e', sequence: 0, at: 'now', turnId: 't', toolCallId: 't1', tool: 'Edit',
        input: { file_path: '/tmp/project/src/a.ts', old_string: 'a\nb\nc', new_string: '1\n2\n3\n4\n5' } },
      { type: 'tool_call', id: 'u', sequence: 1, at: 'now', turnId: 't', toolCallId: 't2', tool: 'TaskUpdate',
        input: { taskId: '2', status: 'completed' } },
    ]} />)
    const summaries = renderer.root.findAllByType('summary')
    expect(textOf(summaries[0]!)).toBe('Edit(src/a.ts)')
    expect(textOf(summaries[1]!)).toBe('TaskUpdate(Task 2 → completed)')
    renderer.unmount()
  })

  test('paired tools retain their row when results arrive, with input before output', () => {
    const call: ChatEvent = { type: 'tool_call', id: 'c', sequence: 0, at: 'now', turnId: 't',
      toolCallId: 't1', tool: 'Bash', input: { description: 'Run tests', command: 'bun test' } }
    const result: ChatEvent = { type: 'tool_result', id: 'r', sequence: 2, at: 'now', turnId: 't',
      toolCallId: 't1', output: 'All tests passed', isError: false }
    const message: ChatEvent = { type: 'assistant_text', id: 'a', sequence: 1, at: 'now', turnId: 't',
      messageId: 'm', text: 'Checking the output.' }
    const renderer = TestRenderer.create(<ChatMessages events={[call, message]} />)
    const row = renderer.root.findByType('details')
    expect(row.findAllByType('pre')).toHaveLength(1)
    act(() => renderer.update(<ChatMessages events={[call, message, result]} />))
    expect(renderer.root.findAllByType('details')).toHaveLength(1)
    expect(renderer.root.findByType('details')).toBe(row)
    expect(textOf(row.findByType('summary'))).toBe('Bash(Run tests)')
    expect(row.findAllByType('pre').map(textOf)).toEqual([JSON.stringify(call.input, null, 2), result.output])
    expect(row.findAllByProps({ 'aria-label': 'Tool failed' })).toHaveLength(0)
    renderer.unmount()
    // A reconnect snapshot produces the same single entry.
    const replay = TestRenderer.create(<ChatMessages events={[call, message, result]} />)
    expect(replay.root.findAllByType('details')).toHaveLength(1)
    replay.unmount()
  })

  test('parallel results pair by id rather than arrival order and failures stay outside truncation', () => {
    const command = 'long command '.repeat(50)
    const renderer = TestRenderer.create(<ChatMessages events={[
      { type: 'tool_call', id: 'a', sequence: 0, at: 'now', turnId: 't', toolCallId: 't1', tool: 'Bash', input: { command } },
      { type: 'tool_call', id: 'b', sequence: 1, at: 'now', turnId: 't', toolCallId: 't2', tool: 'Read', input: { file_path: 'a.ts' } },
      { type: 'tool_result', id: 'r2', sequence: 2, at: 'now', turnId: 't', toolCallId: 't2', output: 'file contents', isError: false },
      { type: 'tool_result', id: 'r1', sequence: 3, at: 'now', turnId: 't', toolCallId: 't1', output: 'Command failed', isError: true },
    ]} />)
    const rows = renderer.root.findAllByType('details')
    expect(rows).toHaveLength(2)
    expect(rows[0]!.findAllByType('pre').map(textOf)[1]).toBe('Command failed')
    expect(rows[1]!.findAllByType('pre').map(textOf)[1]).toBe('file contents')
    const summary = rows[0]!.findByType('summary')
    const mark = summary.findByProps({ 'aria-label': 'Tool failed' })
    expect(textOf(mark)).toBe('✗')
    expect(mark.props.className).toContain('shrink-0')
    expect(summary.findByProps({ title: command.trim() }).findAllByProps({ 'aria-label': 'Tool failed' })).toHaveLength(0)
    expect(rows[1]!.findAllByProps({ 'aria-label': 'Tool failed' })).toHaveLength(0)
    renderer.unmount()
  })

  test('orphan results retain their full output without result hints', () => {
    const output = 'Command failed: bun test\n    at test.ts:1:1'
    const renderer = TestRenderer.create(<ChatMessages events={[
      { type: 'tool_result', id: 'r', sequence: 0, at: 'now', turnId: 't', toolCallId: 't1', output, isError: true },
      { type: 'tool_result', id: 's', sequence: 1, at: 'now', turnId: 't', toolCallId: 't2', output: 'ok', isError: false },
    ]} />)
    expect(renderer.root.findAllByType('details')).toHaveLength(2)
    expect(renderer.root.findAllByType('summary').map(textOf)).toEqual(['Tool result✗', 'Tool result'])
    expect(renderer.root.findAllByType('pre').map(textOf)).toEqual([output, 'ok'])
    renderer.unmount()
  })

  test('command output renders as a muted markdown block', () => {
    const renderer = TestRenderer.create(<ChatMessages events={[
      { type: 'command_output', id: 'c', sequence: 0, at: 'now', turnId: 't', text: 'Context usage: **12%** of the window.' },
    ]} />)
    const block = renderer.root.findByProps({ 'data-testid': 'chat-command-output' })
    expect(block.props.className).toContain('text-secondary')
    expect(block.props.className).toContain('font-mono')
    expect(textOf(block)).toContain('Command output')
    // Markdown renders (bold), inside the monospace container.
    expect(renderer.root.findByType('strong').children).toEqual(['12%'])
    renderer.unmount()
  })

  test('assistant text renders headings, tables and strikethrough as elements', () => {
    const renderer = TestRenderer.create(<ChatMessages events={[
      { type: 'assistant_text', id: 'a', sequence: 0, at: 'now', turnId: 't', messageId: 'm',
        text: '## Heading\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\n~~gone~~' },
    ]} />)
    expect(renderer.root.findByType('h2').children).toEqual(['Heading'])
    expect(renderer.root.findByType('table')).toBeTruthy()
    expect(renderer.root.findByType('del').children).toEqual(['gone'])
    renderer.unmount()
  })

  test('user messages keep markdown syntax literal', () => {
    const renderer = TestRenderer.create(<ChatMessages events={[
      { type: 'user_message', id: 'u', sequence: 0, at: 'now', turnId: 't', text: '**not bold**' },
    ]} />)
    const html = JSON.stringify(renderer.toJSON())
    expect(html).toContain('**not bold**')
    expect(renderer.root.findAllByType('strong')).toHaveLength(0)
    renderer.unmount()
  })
})

const chatSession = { id: 'chat-1', name: 'Chat', projectPath: '/tmp/project', status: 'waiting', kind: 'chat' } as unknown as Session
const wireFrame = (seq: number, raw: string, dir: ChatWireFrame['dir'] = 'in'): ChatWireFrame => ({ seq, at: '2026-10-05T12:00:00.000Z', dir, raw })
const deltaFrame = (seq: number, dir: ChatWireFrame['dir'] = 'in'): ChatWireFrame =>
  wireFrame(seq, JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta' } }), dir)
const textOf = (node: ReactTestInstance): string =>
  node.children.map(child => typeof child === 'string' ? child : textOf(child)).join('')
const buttonNamed = (root: ReactTestInstance, name: string) =>
  root.findAllByType('button').find(button => textOf(button) === name)!
/** Runs `run` with a stubbed document capturing every copied string. */
const withClipboard = (run: () => void): string[] => {
  const copied: string[] = []
  const originalDocument = globalThis.document
  const textarea = { value: '', style: {}, focus: () => {}, select: () => {} }
  globalThis.document = {
    createElement: () => textarea,
    body: { appendChild: () => {}, removeChild: () => {} },
    execCommand: () => { copied.push(textarea.value); return true },
  } as unknown as Document
  try { run() } finally { globalThis.document = originalDocument }
  return copied
}

describe('chat approval policy', () => {
  afterEach(() => useChatDebugStore.setState({ views: {} }))

  // The rendered switch element (role="switch"), not the Switch component.
  const approvalSwitch = (renderer: TestRenderer.ReactTestRenderer) =>
    renderer.root.find(node => typeof node.type === 'string' && node.props['data-testid'] === 'chat-approval-policy')
  function renderPolicyView(session: Session) {
    const sent: ClientMessage[] = []
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(<ChatView
        session={session}
        sendMessage={message => { sent.push(message) }}
        connectionStatus="connected" connectionEpoch={0} error={null}
        onClose={() => {}} onKill={() => {}} />)
    })
    return { sent, renderer }
  }

  test('a manual session shows an unpressed toggle that switches to auto', () => {
    const { sent, renderer } = renderPolicyView(chatSession)
    const toggle = approvalSwitch(renderer)
    expect(toggle.props.role).toBe('switch')
    expect(toggle.props['aria-checked']).toBe(false)
    expect(toggle.props['aria-label']).toBe('Auto-approve')
    act(() => { renderer.root.findByType(Switch).props.onCheckedChange(true) })
    expect(sent).toContainEqual({ type: 'chat-set-approval-policy', sessionId: 'chat-1', policy: 'auto' })
    renderer.unmount()
  })

  test('an auto session shows a pressed, amber toggle that switches back', () => {
    const auto = { ...chatSession, approvalPolicy: 'auto' } as Session
    const { sent, renderer } = renderPolicyView(auto)
    const toggle = approvalSwitch(renderer)
    expect(toggle.props['aria-checked']).toBe(true)
    expect(toggle.props.className).toContain('data-[checked]:bg-approval')
    expect(renderer.root.findAll(node => node.type === 'label' && String(node.props.className).includes('text-approval'))).toHaveLength(1)
    act(() => { renderer.root.findByType(Switch).props.onCheckedChange(false) })
    expect(sent).toContainEqual({ type: 'chat-set-approval-policy', sessionId: 'chat-1', policy: 'manual' })
    renderer.unmount()
  })

  test('an archived chat hides the approval-policy control', () => {
    const archived = { ...chatSession, archivedAt: '2026-10-01T00:00:00.000Z' } as Session
    const { renderer } = renderPolicyView(archived)
    expect(renderer.root.findAllByType(Switch)).toHaveLength(0)
    renderer.unmount()
  })

  test('policy grants render as auto-approved; user decisions stay distinct', () => {
    const renderer = TestRenderer.create(<ChatMessages events={[
      { type: 'request_resolved', id: 'p', sequence: 0, at: 'now', requestId: 'r1', outcome: 'allowed', decidedBy: 'policy', tool: 'Bash' },
      { type: 'request_resolved', id: 'u', sequence: 1, at: 'now', requestId: 'r2', outcome: 'allowed', decidedBy: 'user' },
      { type: 'request_resolved', id: 'd', sequence: 2, at: 'now', requestId: 'r3', outcome: 'denied', decidedBy: 'user' },
      { type: 'request_resolved', id: 'c', sequence: 3, at: 'now', requestId: 'r4', outcome: 'cancelled' },
    ]} />)
    const paragraphTexts = renderer.root.findAllByType('p').map(node => textOf(node))
    expect(paragraphTexts).toContain('Auto-approved Bash')
    expect(paragraphTexts).toContain('Allowed by user')
    expect(paragraphTexts).toContain('Denied by user')
    expect(paragraphTexts).toContain('Request cancelled')
    renderer.unmount()
  })
})

describe('chat archive view', () => {
  // Loose holder so the confirm stub can replace `window` without matching
  // the full DOM Window type.
  const windowSlot = globalThis as { window?: unknown }
  const originalWindow = windowSlot.window
  let confirmResult = true
  const confirmCalls: string[] = []

  afterEach(() => {
    windowSlot.window = originalWindow
    useChatDebugStore.setState({ views: {} })
  })

  function renderArchiveView(session: Session) {
    confirmCalls.length = 0
    windowSlot.window = {
      confirm: (message?: string) => {
        confirmCalls.push(message ?? '')
        return confirmResult
      },
    }
    const sent: ClientMessage[] = []
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(<ChatView
        session={session}
        sendMessage={message => { sent.push(message) }}
        connectionStatus="connected" connectionEpoch={0} error={null}
        onClose={() => {}} onKill={() => {}} />)
    })
    return { sent, renderer }
  }

  test('archiving an idle chat sends chat-archive without confirmation', () => {
    const { sent, renderer } = renderArchiveView(chatSession)
    expect(confirmCalls).toHaveLength(0)
    act(() => { chooseSessionMenuEntry(renderer.root, 'archive') })
    expect(confirmCalls).toHaveLength(0)
    expect(sent).toContainEqual({ type: 'chat-archive', sessionId: 'chat-1' })
    renderer.unmount()
  })

  test('archiving a working chat asks first and sends on confirmation', () => {
    const working = { ...chatSession, status: 'working' } as Session
    confirmResult = true
    const { sent, renderer } = renderArchiveView(working)
    act(() => { chooseSessionMenuEntry(renderer.root, 'archive') })
    expect(confirmCalls).toHaveLength(1)
    expect(sent).toContainEqual({ type: 'chat-archive', sessionId: 'chat-1' })
    renderer.unmount()
  })

  test('declining the confirmation keeps the turn running', () => {
    const working = { ...chatSession, status: 'working' } as Session
    confirmResult = false
    const { sent, renderer } = renderArchiveView(working)
    act(() => { chooseSessionMenuEntry(renderer.root, 'archive') })
    expect(confirmCalls).toHaveLength(1)
    expect(sent.filter(message => message.type === 'chat-archive')).toEqual([])
    renderer.unmount()
  })

  test('an archived chat renders read-only with a Restore bar', () => {
    const archived = { ...chatSession, archivedAt: '2026-10-01T00:00:00.000Z' } as Session
    const { sent, renderer } = renderArchiveView(archived)

    // Attach still requests a snapshot; no agent is started for it.
    expect(sent).toContainEqual({ type: 'chat-attach', sessionId: 'chat-1' })
    // Read-only: no composer, Stop, Archive action, or request actions.
    expect(renderer.root.findAllByType('textarea')).toHaveLength(0)
    expect(renderer.root.findAllByType('form')).toHaveLength(0)
    expect(buttonNamed(renderer.root, 'Stop')).toBeUndefined()
    expect(sessionMenuEntry(renderer.root, 'archive')).toBeUndefined()
    expect(textOf(renderer.root.findByProps({ 'data-testid': 'chat-archived-bar' }))).toContain('Archived')
    expect(renderer.root.findByProps({ 'data-testid': 'chat-status' }).children).toContain('archived')
    // Kill stays available for archived chats.
    expect(sessionMenuEntry(renderer.root, 'kill')).toBeTruthy()

    // Restore sends chat-restore.
    act(() => { buttonNamed(renderer.root, 'Restore').props.onClick() })
    expect(sent).toContainEqual({ type: 'chat-restore', sessionId: 'chat-1' })
    renderer.unmount()
  })
})

describe('chat composer drafts', () => {
  afterEach(() => useChatStore.setState({ sessions: {}, drafts: {}, closedAccountNotices: {} }))

  const chatB = { ...chatSession, id: 'chat-2', name: 'Chat B' } as Session
  function renderComposerView(session: Session) {
    const sent: ClientMessage[] = []
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(<ChatView
        session={session}
        sendMessage={message => { sent.push(message) }}
        connectionStatus="connected" connectionEpoch={0} error={null}
        onClose={() => {}} onKill={() => {}} />)
    })
    return { sent, renderer }
  }
  // Prop-swap the shared ChatView, the way App.tsx switches selected chats.
  const switchTo = (renderer: TestRenderer.ReactTestRenderer, session: Session) => act(() => {
    renderer.update(<ChatView
      session={session}
      sendMessage={() => {}}
      connectionStatus="connected" connectionEpoch={0} error={null}
      onClose={() => {}} onKill={() => {}} />)
  })
  const composerOf = (renderer: TestRenderer.ReactTestRenderer) =>
    renderer.root.findByProps({ 'aria-label': 'Message Claude' })
  const type = (renderer: TestRenderer.ReactTestRenderer, value: string) =>
    act(() => { composerOf(renderer).props.onChange({ target: { value } }) })

  test('switching chats keeps each session draft separate', () => {
    const { renderer } = renderComposerView(chatSession)
    type(renderer, 'half-written for chat-1')
    // The other chat's composer starts empty — chat-1's text must not leak in.
    switchTo(renderer, chatB)
    expect(composerOf(renderer).props.value).toBe('')
    type(renderer, 'chat-2 note')
    // Switching back restores chat-1's draft untouched.
    switchTo(renderer, chatSession)
    expect(composerOf(renderer).props.value).toBe('half-written for chat-1')
    expect(useChatStore.getState().drafts).toEqual({
      'chat-1': 'half-written for chat-1', 'chat-2': 'chat-2 note',
    })
    renderer.unmount()
  })

  test('submitting clears only the submitting session draft', () => {
    useChatStore.setState({ drafts: { 'chat-1': 'send me', 'chat-2': 'keep me' } })
    const { sent, renderer } = renderComposerView(chatSession)
    expect(composerOf(renderer).props.value).toBe('send me')
    act(() => { renderer.root.findByType('form').props.onSubmit({ preventDefault: () => {} }) })
    expect(sent).toContainEqual({ type: 'chat-send', sessionId: 'chat-1', text: 'send me' })
    expect(useChatStore.getState().drafts).toEqual({ 'chat-2': 'keep me' })
    renderer.unmount()
  })

  test('an archived chat hides the composer but keeps its draft through restore', () => {
    useChatStore.setState({ drafts: { 'chat-1': 'after restore' } })
    const archived = { ...chatSession, archivedAt: '2026-10-01T00:00:00.000Z' } as Session
    const { renderer } = renderComposerView(archived)
    expect(renderer.root.findAllByType('textarea')).toHaveLength(0)
    expect(useChatStore.getState().drafts['chat-1']).toBe('after restore')
    // The server's unarchived Session re-renders the composer with the draft.
    switchTo(renderer, chatSession)
    expect(composerOf(renderer).props.value).toBe('after restore')
    renderer.unmount()
  })
})

describe('chat debug view', () => {
  afterEach(() => useChatDebugStore.setState({ views: {} }))

  test("ChatView hands the debug panel the record's runtime, not the live catalog's (N4)", () => {
    // The record is codex; the catalog holds no profile for the session's
    // id, so the catalog-lookup wiring this replaces read 'claude' here.
    useChatDebugStore.setState({
      views: {
        'chat-1': { ...closedDebugView(), open: true, frames: [wireFrame(1, '{"jsonrpc":"2.0","id":1,"method":"x"}', 'out')] },
      },
    })
    const codexSession = { ...chatSession, runtime: 'codex' } as unknown as Session
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(<ChatView
        session={codexSession} sendMessage={() => {}}
        connectionStatus="connected" connectionEpoch={0} error={null}
        onClose={() => {}} onKill={() => {}} />)
    })
    expect(renderer.root.findByType(ChatDebugPanel).props.runtime).toBe('codex')
    renderer.unmount()
  })

  function renderView(connectionEpoch = 0) {
    const sent: ClientMessage[] = []
    const props = {
      session: chatSession, sendMessage: (message: ClientMessage) => { sent.push(message) },
      connectionStatus: 'connected' as const, connectionEpoch, error: null, onClose: () => {}, onKill: () => {},
    }
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => { renderer = TestRenderer.create(<ChatView {...props} />) })
    return { sent, renderer, props }
  }
  const debugMessages = (sent: ClientMessage[]) => sent.filter(message => message.type.startsWith('chat-debug'))

  test('the Debug toggle opens and closes the panel and its subscription', () => {
    const { sent, renderer } = renderView()
    expect(renderer.root.findAllByProps({ 'data-testid': 'chat-debug-panel' })).toHaveLength(0)
    expect(debugMessages(sent)).toEqual([])
    act(() => chooseSessionMenuEntry(renderer.root, 'debug'))
    expect(sessionMenuEntry(renderer.root, 'debug')).toMatchObject({ kind: 'check', checked: true })
    expect(renderer.root.findAllByProps({ 'data-testid': 'chat-debug-panel' })).toHaveLength(1)
    expect(debugMessages(sent)).toEqual([{ type: 'chat-debug-open', sessionId: 'chat-1' }])
    act(() => chooseSessionMenuEntry(renderer.root, 'debug'))
    expect(renderer.root.findAllByProps({ 'data-testid': 'chat-debug-panel' })).toHaveLength(0)
    expect(debugMessages(sent)).toEqual([
      { type: 'chat-debug-open', sessionId: 'chat-1' }, { type: 'chat-debug-close', sessionId: 'chat-1' },
    ])
    // The conversation stays mounted throughout.
    expect(renderer.root.findAllByProps({ 'data-testid': 'chat-transcript' })).toHaveLength(1)
    renderer.unmount()
  })

  test('a reconnect re-opens the debug subscription and awaits a fresh page', () => {
    const { sent, renderer, props } = renderView()
    act(() => chooseSessionMenuEntry(renderer.root, 'debug'))
    act(() => { useChatDebugStore.getState().apply({ type: 'chat-debug-frames', sessionId: 'chat-1', frames: [], page: true, hasOlder: false }) })
    expect(useChatDebugStore.getState().views['chat-1']!.awaitingOpen).toBe(false)
    act(() => renderer.update(<ChatView {...props} connectionEpoch={1} />))
    expect(debugMessages(sent)).toEqual([
      { type: 'chat-debug-open', sessionId: 'chat-1' },
      { type: 'chat-debug-close', sessionId: 'chat-1' },
      { type: 'chat-debug-open', sessionId: 'chat-1' },
    ])
    expect(useChatDebugStore.getState().views['chat-1']!.awaitingOpen).toBe(true)
    renderer.unmount()
  })

  function renderPanel(view: ChatDebugView, runtime?: ChatRuntime) {
    const sent: ClientMessage[] = []
    let closed = 0
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(<ChatDebugPanel sessionId="chat-1" view={view} connected runtime={runtime}
        sendMessage={message => { sent.push(message) }} onClose={() => { closed += 1 }} />)
    })
    return { sent, renderer, closed: () => closed }
  }
  const openView = (frames: ChatWireFrame[], hasOlder = false): ChatDebugView => ({ ...closedDebugView(), open: true, frames, hasOlder })

  test('rows show direction, seq, and type; a row expands to pretty JSON', () => {
    const { renderer } = renderPanel(openView([
      wireFrame(1, '{"event":"spawn","command":"claude"}', 'lifecycle'),
      wireFrame(2, '{"type":"control_request","request":{"subtype":"can_use_tool"}}'),
    ]))
    const row = renderer.root.findByProps({ 'data-frame-seq': 2 })
    expect(textOf(row)).toContain('← Claude')
    expect(textOf(row)).toContain('#2')
    expect(textOf(row)).toContain('control_request · can_use_tool')
    expect(row.findAllByType('pre')).toHaveLength(0)
    act(() => row.findAllByType('button')[0]!.props.onClick())
    expect(row.findByType('pre').children.join('')).toBe(JSON.stringify(JSON.parse('{"type":"control_request","request":{"subtype":"can_use_tool"}}'), null, 2))
    act(() => row.findAllByType('button')[0]!.props.onClick())
    expect(row.findAllByType('pre')).toHaveLength(0)
    renderer.unmount()
  })

  test('direction labels name the session runtime and JSON-RPC frames label by shape', () => {
    const { renderer } = renderPanel(openView([
      wireFrame(1, '{"method":"initialize","params":{}}', 'out'),
      wireFrame(2, '{"id":0,"result":{"thread":{"id":"t1"}}}'),
    ]), 'codex')
    const request = renderer.root.findByProps({ 'data-frame-seq': 1 })
    const response = renderer.root.findByProps({ 'data-frame-seq': 2 })
    expect(textOf(request)).toContain('→ Codex')
    expect(textOf(response)).toContain('← Codex')
    expect(textOf(request)).toContain('initialize')
    expect(textOf(response)).toContain('response #0')
    renderer.unmount()
  })

  test('Copy copies the raw line exactly as exchanged', () => {
    const raw = '{"type":"user",  "message":{"content":"hi"}}'
    const { renderer } = renderPanel(openView([wireFrame(1, raw, 'out')]))
    const row = renderer.root.findByProps({ 'data-frame-seq': 1 })
    act(() => row.findAllByType('button')[0]!.props.onClick())
    const originalDocument = globalThis.document
    const copied: string[] = []
    const textarea = { value: '', style: {}, focus: () => {}, select: () => {} }
    globalThis.document = {
      createElement: () => textarea,
      body: { appendChild: () => {}, removeChild: () => {} },
      execCommand: () => { copied.push(textarea.value); return true },
    } as unknown as Document
    try {
      act(() => buttonNamed(row, 'Copy').props.onClick())
    } finally {
      globalThis.document = originalDocument
    }
    expect(copied).toEqual([raw])
    renderer.unmount()
  })

  test('a run of frames renders as one collapsed group row with count and ranges', () => {
    const frames = Array.from({ length: 20 }, (_, index) => deltaFrame(index + 1))
    const { renderer } = renderPanel(openView(frames))
    const group = renderer.root.findByProps({ 'data-group-seq': 1 })
    const text = textOf(group)
    expect(text).toContain('← Claude')
    expect(text).toContain('#1–#20')
    expect(text).toContain('stream_event · content_block_delta')
    expect(text).toContain('×20')
    expect(group.findAllByType('button')[0]!.props['aria-expanded']).toBe(false)
    // Collapsed: no member rows are rendered.
    expect(group.findAllByProps({ 'data-frame-seq': 1 })).toHaveLength(0)
    renderer.unmount()
  })

  test('expanding a group lists member rows with pretty JSON and Copy all joins raw lines', () => {
    const frames = [
      wireFrame(1, JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: 1 } })),
      wireFrame(2, JSON.stringify({ type: 'system', subtype: 'thinking_tokens' })),
      wireFrame(3, JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: 3 } })),
    ]
    const { renderer } = renderPanel(openView(frames))
    const group = renderer.root.findByProps({ 'data-group-seq': 1 })
    // ×N counts the run's delta frames; absorbed thinking_tokens report on top.
    expect(textOf(group)).toContain('×2')
    expect(textOf(group)).toContain('+1 thinking_tokens')
    act(() => { group.findAllByType('button')[0]!.props.onClick() })
    expect(group.findAllByType('button')[0]!.props['aria-expanded']).toBe(true)
    const members = frames.map((_, index) => group.findByProps({ 'data-frame-seq': index + 1 }))

    // A member expands to pretty JSON like an ungrouped row.
    act(() => { members[1]!.findAllByType('button')[0]!.props.onClick() })
    expect(members[1]!.findByType('pre').children.join('')).toBe(JSON.stringify(JSON.parse(frames[1]!.raw), null, 2))

    // A member copies its raw line; Copy all joins every member's raw line.
    let memberCopy: string[] = []
    let allCopy: string[] = []
    act(() => { memberCopy = withClipboard(() => buttonNamed(members[1]!, 'Copy').props.onClick()) })
    act(() => { allCopy = withClipboard(() => buttonNamed(group, 'Copy all').props.onClick()) })
    expect(memberCopy).toEqual([frames[1]!.raw])
    expect(allCopy).toEqual([frames.map(frame => frame.raw).join('\n')])
    renderer.unmount()
  })

  test('a group grows in place and stays expanded across live and older frames', () => {
    const { renderer } = renderPanel(openView([deltaFrame(1), deltaFrame(2)]))
    const group = renderer.root.findByProps({ 'data-group-seq': 1 })
    act(() => { group.findAllByType('button')[0]!.props.onClick() })
    const update = (frames: ChatWireFrame[]) => act(() => {
      renderer.update(<ChatDebugPanel sessionId="chat-1" view={openView(frames)} connected
        sendMessage={() => {}} onClose={() => {}} />)
    })

    // A live frame of the same type joins the expanded group; no new row.
    update([deltaFrame(1), deltaFrame(2), deltaFrame(3)])
    const grown = renderer.root.findByProps({ 'data-group-seq': 1 })
    expect(grown.findAllByType('button')[0]!.props['aria-expanded']).toBe(true)
    expect(textOf(grown)).toContain('×3')
    expect(grown.findAllByProps({ 'data-frame-seq': 3 })).toHaveLength(1)
    expect(renderer.root.findAllByProps({ 'data-group-seq': 1 })).toHaveLength(1)

    // An older page prepends members; the group stays expanded under a new first seq.
    update([deltaFrame(0), deltaFrame(1), deltaFrame(2), deltaFrame(3)])
    const older = renderer.root.findByProps({ 'data-group-seq': 0 })
    expect(older.findAllByType('button')[0]!.props['aria-expanded']).toBe(true)
    expect(textOf(older)).toContain('×4')

    // A different-type live frame starts its own row instead of joining.
    update([deltaFrame(0), deltaFrame(1), deltaFrame(2), deltaFrame(3), wireFrame(4, '{"type":"result","subtype":"success"}')])
    expect(renderer.root.findAllByProps({ 'data-group-seq': 0 })).toHaveLength(1)
    expect(textOf(renderer.root.findByProps({ 'data-frame-seq': 4 }))).toContain('result · success')
    renderer.unmount()
  })

  test('an expanded lone frame keeps its JSON open when a live frame groups it', () => {
    const { renderer } = renderPanel(openView([deltaFrame(1)]))
    const row = renderer.root.findByProps({ 'data-frame-seq': 1 })
    act(() => { row.findAllByType('button')[0]!.props.onClick() })
    expect(row.findByType('pre')).toBeTruthy()
    // A matching live frame turns the run into a group; the frame the user
    // expanded must not vanish into a collapsed row.
    act(() => {
      renderer.update(<ChatDebugPanel sessionId="chat-1" view={openView([deltaFrame(1), deltaFrame(2)])} connected
        sendMessage={() => {}} onClose={() => {}} />)
    })
    const group = renderer.root.findByProps({ 'data-group-seq': 1 })
    expect(group.findAllByType('button')[0]!.props['aria-expanded']).toBe(true)
    expect(group.findByProps({ 'data-frame-seq': 1 }).findAllByType('pre')).toHaveLength(1)
    // Collapsing the group folds the transferred JSON expansion away with it.
    act(() => { group.findAllByType('button')[0]!.props.onClick() })
    expect(group.findAllByType('button')[0]!.props['aria-expanded']).toBe(false)
    act(() => { group.findAllByType('button')[0]!.props.onClick() })
    expect(group.findByProps({ 'data-frame-seq': 1 }).findAllByType('pre')).toHaveLength(0)
    renderer.unmount()
  })

  test('an expanded group stays expanded after the frame cap trims its original members', () => {
    const { renderer } = renderPanel(openView([deltaFrame(10), deltaFrame(11)]))
    act(() => { renderer.root.findByProps({ 'data-group-seq': 10 }).findAllByType('button')[0]!.props.onClick() })
    const update = (frames: ChatWireFrame[]) => act(() => {
      renderer.update(<ChatDebugPanel sessionId="chat-1" view={openView(frames)} connected
        sendMessage={() => {}} onClose={() => {}} />)
    })
    // Live frames join the open group, then the 5000-frame cap trims the two
    // seqs that were members at toggle time — the group must stay expanded.
    update([deltaFrame(10), deltaFrame(11), deltaFrame(12), deltaFrame(13), deltaFrame(14)])
    update([deltaFrame(12), deltaFrame(13), deltaFrame(14)])
    const trimmed = renderer.root.findByProps({ 'data-group-seq': 12 })
    expect(trimmed.findAllByType('button')[0]!.props['aria-expanded']).toBe(true)
    expect(textOf(trimmed)).toContain('#12–#14')
    expect(trimmed.findAllByProps({ 'data-frame-seq': 12 })).toHaveLength(1)
    renderer.unmount()
  })

  test('Load older requests the page before the oldest loaded frame', () => {
    useChatDebugStore.getState().beginOpen('chat-1')
    const { sent, renderer } = renderPanel(openView([wireFrame(7, '{}'), wireFrame(8, '{}')], true))
    act(() => buttonNamed(renderer.root, 'Load older').props.onClick())
    expect(sent).toEqual([{ type: 'chat-debug-page', sessionId: 'chat-1', beforeSeq: 7 }])
    expect(useChatDebugStore.getState().views['chat-1']!.loadingOlder).toBe(true)
    renderer.unmount()
  })

  test('empty and loading states, and Close', () => {
    const empty = renderPanel(openView([]))
    expect(textOf(empty.renderer.root)).toContain('No protocol traffic recorded for this session yet.')
    act(() => buttonNamed(empty.renderer.root, 'Close').props.onClick())
    expect(empty.closed()).toBe(1)
    empty.renderer.unmount()
    const loading = renderPanel({ ...openView([]), awaitingOpen: true })
    expect(textOf(loading.renderer.root)).toContain('Loading…')
    expect(loading.renderer.root.findAllByType('button').map(textOf)).not.toContain('Load older')
    loading.renderer.unmount()
  })
})

describe('slash-command menu', () => {
  const READY_COMMANDS: ChatCommandState = {
    status: 'ready',
    commands: [
      { name: 'clear', description: 'Start a new session', argumentHint: '[name]', aliases: ['reset', 'new'], source: 'builtin' },
      { name: 'context', description: 'Show context usage', aliases: ['ctx'], source: 'builtin' },
      { name: 'compact', description: 'Compact the conversation', aliases: [], source: 'builtin' },
      { name: 'openspec-explore', description: 'Explore ideas', aliases: [], source: 'project' },
      { name: 'my-skill', description: 'A personal skill', aliases: [], source: 'user' },
    ],
  }

  afterEach(() => useChatStore.setState({ sessions: {}, drafts: {}, closedAccountNotices: {} }))

  function renderComposer(commands: ChatCommandState, session: Session = chatSession) {
    useChatStore.getState().setCommands({ type: 'chat-commands', sessionId: session.id, state: commands })
    const sent: ClientMessage[] = []
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(<ChatView
        session={session}
        sendMessage={message => { sent.push(message) }}
        connectionStatus="connected" connectionEpoch={0} error={null}
        onClose={() => {}} onKill={() => {}} />)
    })
    const type = (value: string) =>
      act(() => { renderer.root.findByType('textarea').props.onChange({ target: { value } }) })
    // Type with an explicit caret (collapsed at `caret`, or a selection).
    const typeAt = (value: string, caret: number, selectionEnd: number = caret) =>
      act(() => { renderer.root.findByType('textarea').props.onChange({
        target: { value, selectionStart: caret, selectionEnd } }) })
    // A caret move or selection without typing (arrows, clicks, dragging).
    const moveCaret = (caret: number, selectionEnd: number = caret) =>
      act(() => { renderer.root.findByType('textarea').props.onSelect({
        target: { selectionStart: caret, selectionEnd } }) })
    const key = (keyName: string) =>
      act(() => { renderer.root.findByType('textarea').props.onKeyDown({
        key: keyName, preventDefault: () => {}, currentTarget: { form: { requestSubmit: () => submit() } } }) })
    const submit = () =>
      act(() => { renderer.root.findByType('form').props.onSubmit({ preventDefault: () => {} }) })
    return { sent, renderer, type, typeAt, moveCaret, key, submit }
  }

  test('opens on a bare slash, filters, and stays closed otherwise', () => {
    const h = renderComposer(READY_COMMANDS)
    expect(h.renderer.root.findAllByProps({ 'data-testid': 'slash-command-menu' })).toHaveLength(0)
    h.type('/')
    expect(h.renderer.root.findAllByProps({ 'data-testid': 'slash-command-menu' })).toHaveLength(1)
    h.type('/co')
    const menu = h.renderer.root.findByProps({ 'data-testid': 'slash-command-menu' })
    expect(menu.findAllByProps({ role: 'option' }).map(option => option.props['data-command-name']))
      .toEqual(['context', 'compact'])
    h.type('/context arg') // args started: the menu closes
    expect(h.renderer.root.findAllByProps({ 'data-testid': 'slash-command-menu' })).toHaveLength(0)
    h.renderer.unmount()
  })

  test('shows loading while the list is not ready, and nothing when unavailable', () => {
    const loading = renderComposer({ status: 'loading', commands: [] })
    loading.type('/')
    expect(loading.renderer.root.findByProps({ 'data-testid': 'slash-command-loading' })).toBeDefined()
    loading.renderer.unmount()
    const unavailable = renderComposer({ status: 'unavailable', commands: [] })
    unavailable.type('/')
    expect(unavailable.renderer.root.findAllByProps({ 'data-testid': 'slash-command-menu' })).toHaveLength(0)
    unavailable.renderer.unmount()
  })

  test('keyboard: Up/Down move, Enter inserts with the hint, nothing is sent', () => {
    const h = renderComposer(READY_COMMANDS)
    h.type('/c')
    h.key('ArrowDown') // clear -> context
    h.key('ArrowDown') // context -> compact
    h.key('ArrowUp')   // compact -> context
    h.key('Enter')
    expect(h.renderer.root.findByType('textarea').props.value).toBe('/context ')
    expect(useChatStore.getState().drafts['chat-1']).toBe('/context ')
    // The argument hint shows for a command that has one…
    h.type('/clear ')
    expect(h.renderer.root.findByProps({ 'data-testid': 'command-argument-hint' }).children)
      .toEqual(['/', 'clear', ' ', '[name]'])
    // …and typing arguments replaces it.
    h.type('/clear demo')
    expect(h.renderer.root.findAllByProps({ 'data-testid': 'command-argument-hint' })).toHaveLength(0)
    // No message went to the agent while choosing.
    expect(h.sent.filter(message => message.type === 'chat-send')).toEqual([])
    h.renderer.unmount()
  })

  test('the highlighted option carries the accent mark; others lift on hover', () => {
    const h = renderComposer(READY_COMMANDS)
    h.type('/c')
    const option = (index: number) =>
      h.renderer.root.findByProps({ 'data-testid': 'slash-command-menu' })
        .findAllByProps({ role: 'option' })[index]!
    // Exact tokens: `hover:bg-hover` contains `bg-hover` as a substring.
    const classesOf = (node: ReactTestInstance) => String(node.props.className).split(' ')
    // The first match starts marked — lifted off the surface, accent text…
    expect(option(0).props['aria-selected']).toBe(true)
    expect(classesOf(option(0))).toContain('bg-hover')
    expect(classesOf(option(0))).toContain('text-accent')
    expect(classesOf(option(0))).not.toContain('hover:bg-hover')
    // …and the rest sit on the menu surface until hovered.
    expect(option(1).props['aria-selected']).toBe(false)
    expect(classesOf(option(1))).toContain('hover:bg-hover')
    // The mark follows the arrow keys.
    h.key('ArrowDown')
    expect(option(1).props['aria-selected']).toBe(true)
    expect(classesOf(option(1))).toContain('text-accent')
    expect(classesOf(option(0))).toContain('hover:bg-hover')
    h.renderer.unmount()
  })

  test('choosing mid-message replaces only the /word and sends nothing', () => {
    const h = renderComposer(READY_COMMANDS)
    // Caret just after `/re` inside `please run /re on this`.
    h.typeAt('please run /re on this', 13)
    expect(h.renderer.root.findAllByProps({ 'data-testid': 'slash-command-menu' })).toHaveLength(1)
    h.key('Enter')
    expect(h.renderer.root.findByType('textarea').props.value).toBe('please run /clear on this')
    expect(useChatStore.getState().drafts['chat-1']).toBe('please run /clear on this')
    expect(h.renderer.root.findAllByProps({ 'data-testid': 'slash-command-menu' })).toHaveLength(0)
    expect(h.sent.filter(message => message.type === 'chat-send')).toEqual([])
    h.renderer.unmount()
  })

  test('the argument hint follows a mid-message insertion and hides once args are typed', () => {
    const h = renderComposer(READY_COMMANDS)
    // Inserting mid-message leaves the caret just after `/clear ` — the only
    // position where the hint may show (design D4).
    h.typeAt('please run /cl later', 13)
    h.key('Enter')
    expect(h.renderer.root.findByType('textarea').props.value).toBe('please run /clear later')
    expect(h.renderer.root.findByProps({ 'data-testid': 'command-argument-hint' }).children)
      .toEqual(['/', 'clear', ' ', '[name]'])
    // Typing arguments moves the caret past the inserted space: hint gone.
    h.typeAt('please run /clear demo later', 19)
    expect(h.renderer.root.findAllByProps({ 'data-testid': 'command-argument-hint' })).toHaveLength(0)
    h.renderer.unmount()
  })

  test('opens mid-message and at the start of a later line', () => {
    const h = renderComposer(READY_COMMANDS)
    h.typeAt('please run /co', 14)
    const menu = h.renderer.root.findByProps({ 'data-testid': 'slash-command-menu' })
    expect(menu.findAllByProps({ role: 'option' }).map(option => option.props['data-command-name']))
      .toEqual(['context', 'compact'])
    // A `/` word on the second line lists everything, like a leading one.
    h.typeAt('first line\n/', 12)
    expect(h.renderer.root.findByProps({ 'data-testid': 'slash-command-menu' })
      .findAllByProps({ role: 'option' })).toHaveLength(READY_COMMANDS.commands.length)
    h.renderer.unmount()
  })

  test('stays closed for and/or and /usr/bin', () => {
    const h = renderComposer(READY_COMMANDS)
    h.typeAt('check and/or maybe', 11)
    expect(h.renderer.root.findAllByProps({ 'data-testid': 'slash-command-menu' })).toHaveLength(0)
    h.typeAt('look at /usr/bin now', 15)
    expect(h.renderer.root.findAllByProps({ 'data-testid': 'slash-command-menu' })).toHaveLength(0)
    h.renderer.unmount()
  })

  test('moving the caret out of the word or selecting text closes; returning reopens', () => {
    const h = renderComposer(READY_COMMANDS)
    h.typeAt('please run /re on this', 13)
    expect(h.renderer.root.findAllByProps({ 'data-testid': 'slash-command-menu' })).toHaveLength(1)
    // Arrow keys / a click move the caret into another word: closed.
    h.moveCaret(17)
    expect(h.renderer.root.findAllByProps({ 'data-testid': 'slash-command-menu' })).toHaveLength(0)
    // Back into the `/` word: open again, filtered the same.
    h.moveCaret(13)
    expect(h.renderer.root.findAllByProps({ 'data-testid': 'slash-command-menu' })).toHaveLength(1)
    // A selection (even inside the word) has no single caret: closed.
    h.moveCaret(11, 13)
    expect(h.renderer.root.findAllByProps({ 'data-testid': 'slash-command-menu' })).toHaveLength(0)
    h.renderer.unmount()
  })

  test('a mid-message /clear is sent as typed without creating a new chat', () => {
    const h = renderComposer(READY_COMMANDS)
    h.type('please run /clear later')
    h.submit()
    expect(h.sent.filter(message => message.type === 'chat-send')).toEqual([
      { type: 'chat-send', sessionId: 'chat-1', text: 'please run /clear later' },
    ])
    expect(h.sent.filter(message => message.type === 'session-create')).toEqual([])
    h.renderer.unmount()
  })

  test('choosing the command already spelled out keeps the text and closes the menu', () => {
    const h = renderComposer(READY_COMMANDS)
    // Caret back inside the complete `/context ` word: choosing `context`
    // reproduces the value exactly — no text commit may be needed for the
    // caret to land after the inserted command.
    h.typeAt('please run /context ', 15)
    expect(h.renderer.root.findAllByProps({ 'data-testid': 'slash-command-menu' })).toHaveLength(1)
    h.key('Enter')
    expect(h.renderer.root.findByType('textarea').props.value).toBe('please run /context ')
    expect(useChatStore.getState().drafts['chat-1']).toBe('please run /context ')
    expect(h.renderer.root.findAllByProps({ 'data-testid': 'slash-command-menu' })).toHaveLength(0)
    // Typing continues from the restored caret without a jump or corruption.
    h.typeAt('please run /context x', 21)
    expect(h.renderer.root.findByType('textarea').props.value).toBe('please run /context x')
    h.renderer.unmount()
  })

  test('Tab also chooses; Escape closes without changing the text', () => {
    const h = renderComposer(READY_COMMANDS)
    h.type('/com')
    h.key('Tab')
    expect(h.renderer.root.findByType('textarea').props.value).toBe('/compact ')
    expect(h.renderer.root.findAllByProps({ 'data-testid': 'slash-command-menu' })).toHaveLength(0)
    h.type('/c')
    h.key('Escape')
    expect(h.renderer.root.findByType('textarea').props.value).toBe('/c')
    expect(h.renderer.root.findAllByProps({ 'data-testid': 'slash-command-menu' })).toHaveLength(0)
    h.renderer.unmount()
  })

  test('Enter without matches is not captured: the typed command submits', () => {
    const h = renderComposer(READY_COMMANDS)
    h.type('/zzz')
    expect(h.renderer.root.findAllByProps({ 'data-testid': 'slash-command-menu' })).toHaveLength(1)
    h.submit()
    expect(h.sent.filter(message => message.type === 'chat-send')).toEqual([
      { type: 'chat-send', sessionId: 'chat-1', text: '/zzz' },
    ])
    h.renderer.unmount()
  })

  test('pointer selection chooses on click; project and user commands are tagged', () => {
    const h = renderComposer(READY_COMMANDS)
    h.type('/')
    const options = h.renderer.root.findByProps({ 'data-testid': 'slash-command-menu' })
      .findAllByProps({ role: 'option' })
    const explore = options.find(option => option.props['data-command-name'] === 'openspec-explore')!
    expect(explore.findByProps({ 'data-testid': 'command-source-tag' }).children).toEqual(['project'])
    const skill = options.find(option => option.props['data-command-name'] === 'my-skill')!
    expect(skill.findByProps({ 'data-testid': 'command-source-tag' }).children).toEqual(['user'])
    act(() => { explore.props.onClick() })
    expect(h.renderer.root.findByType('textarea').props.value).toBe('/openspec-explore ')
    h.renderer.unmount()
  })

  test('archived chats have no composer and no menu', () => {
    const archived = { ...chatSession, archivedAt: '2026-10-01T00:00:00.000Z' } as Session
    const h = renderComposer(READY_COMMANDS, archived)
    expect(h.renderer.root.findAllByType('textarea')).toHaveLength(0)
    expect(h.renderer.root.findAllByProps({ 'data-testid': 'slash-command-menu' })).toHaveLength(0)
    h.renderer.unmount()
  })

  // Regression guard for the invisible-highlight bug: `bg-primary-accent`
  // names no Tailwind color, so the "selected" row styled with it produced no
  // CSS at all. Every bg-*/text-* color utility in the menu must resolve to a
  // theme color in tailwind.config.js or to a default Tailwind palette color.
  test('every bg-*/text-* color utility in the menu resolves to a defined token', async () => {
    const component = await Bun.file(new URL('../components/chat/SlashCommandMenu.tsx', import.meta.url)).text()
    const config = await Bun.file(new URL('../../../tailwind.config.js', import.meta.url)).text()
    // The colors block is flat (`base: 'var(--bg-base)'`, `'border-subtle': …`),
    // so its keys are every quoted or bare identifier followed by a colon.
    const colorsBlock = config.match(/\bcolors:\s*\{([^}]*)\}/)?.[1] ?? ''
    const themeColors = new Set([...colorsBlock.matchAll(/(?:'([^']+)'|([A-Za-z][\w-]*))\s*:/g)]
      .map(match => match[1] ?? match[2]!))
    // Default Tailwind palette hues (sky-400, red-50, …) and bare black/white.
    const palette = 'slate gray zinc neutral stone red orange amber yellow lime green emerald teal cyan sky blue indigo violet purple fuchsia pink rose black white'.split(' ')
    // text-* utilities that size or align text rather than color it.
    const notColors = new Set(['xs', 'sm', 'base', 'lg', 'xl', '2xl', '3xl', '4xl', '5xl', '6xl', '7xl', '8xl', '9xl',
      'left', 'center', 'right', 'justify'])
    const utilities = [...component.matchAll(/\b(?:bg|text)-[a-z0-9/-]+/g)].map(match => match[0])
    expect(utilities).not.toEqual([])
    const unresolved = utilities.filter(utility => {
      const color = utility.replace(/^(?:bg|text)-/, '').split('/')[0]!
      if (utility.startsWith('text-') && notColors.has(color)) return false
      return !themeColors.has(color) && !palette.some(hue => color === hue || color.startsWith(`${hue}-`))
    })
    expect(unresolved).toEqual([])
  })
})

describe('/clear, /reset, /new', () => {
  afterEach(() => useChatStore.setState({ sessions: {}, drafts: {}, closedAccountNotices: {} }))

  function renderClearable(session: Session = chatSession) {
    const sent: ClientMessage[] = []
    const listeners: Array<(message: ServerMessage) => void> = []
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(<ChatView
        session={session}
        sendMessage={message => { sent.push(message) }}
        subscribe={listener => { listeners.push(listener); return () => {} }}
        connectionStatus="connected" connectionEpoch={0} error={null}
        onClose={() => {}} onKill={() => {}} />)
    })
    const type = (value: string) =>
      act(() => { renderer.root.findByType('textarea').props.onChange({ target: { value } }) })
    const submit = () =>
      act(() => { renderer.root.findByType('form').props.onSubmit({ preventDefault: () => {} }) })
    const deliver = (message: ServerMessage) =>
      act(() => { for (const listener of listeners) listener(message) })
    return { sent, renderer, type, submit, deliver }
  }

  const newChatCreated = (id: string, name?: string): ServerMessage => ({
    type: 'session-created',
    session: {
      id, name: name ?? 'New chat', kind: 'chat', projectPath: '/tmp/project',
      status: 'waiting', lastActivity: 'now', createdAt: 'now', source: 'managed',
    },
  })

  test.each(['/clear', '/reset', '/new'])('%s creates a chat and archives the old one', (command) => {
    const h = renderClearable()
    h.type(command)
    h.submit()
    expect(h.sent.filter(message => message.type === 'session-create')).toEqual([{
      type: 'session-create', projectPath: '/tmp/project', kind: 'chat', claudeProfileId: 'default',
      approvalPolicy: 'manual',
    }])
    expect(useChatStore.getState().drafts).not.toHaveProperty('chat-1')
    // The command itself never reaches the agent, and the composer cleared.
    expect(h.sent.filter(message => message.type === 'chat-send')).toEqual([])
    expect(h.renderer.root.findByType('textarea').props.value).toBe('')
    // The composer text is gone but nothing is archived yet.
    expect(h.sent.filter(message => message.type === 'chat-archive')).toEqual([])
    h.deliver(newChatCreated('chat-new'))
    expect(h.sent.filter(message => message.type === 'chat-archive')).toEqual([
      { type: 'chat-archive', sessionId: 'chat-1' },
    ])
    h.renderer.unmount()
  })

  test('/new with a name names the created chat', () => {
    const h = renderClearable()
    h.type('/new release notes')
    h.submit()
    expect(h.sent.filter(message => message.type === 'session-create')).toEqual([{
      type: 'session-create', projectPath: '/tmp/project', kind: 'chat',
      claudeProfileId: 'default', name: 'release notes', approvalPolicy: 'manual',
    }])
    h.deliver(newChatCreated('chat-named', 'release notes'))
    expect(h.sent.filter(message => message.type === 'chat-archive')).toEqual([
      { type: 'chat-archive', sessionId: 'chat-1' },
    ])
    h.renderer.unmount()
  })

  test.each(['manual', 'auto'] as const)('%s policy carries over to the new chat', (policy) => {
    const h = renderClearable({ ...chatSession, approvalPolicy: policy })
    h.type('/clear')
    h.submit()
    expect(h.sent.filter(message => message.type === 'session-create')).toEqual([{
      type: 'session-create', projectPath: '/tmp/project', kind: 'chat',
      claudeProfileId: 'default', approvalPolicy: policy,
    }])
    h.renderer.unmount()
  })

  test('the team group carries over to the new chat', () => {
    const h = renderClearable({ ...chatSession, groupId: 'devs' } as Session)
    h.type('/clear')
    h.submit()
    expect(h.sent.filter(message => message.type === 'session-create')).toEqual([{
      type: 'session-create', projectPath: '/tmp/project', kind: 'chat',
      claudeProfileId: 'default', approvalPolicy: 'manual', groupId: 'devs', cloneFromSessionId: 'chat-1',
    }])
    h.renderer.unmount()
  })

  test.each(['/clear', '/reset', '/new'])('%s clones the stored role when its group file is missing', (command) => {
    const h = renderClearable({ ...chatSession, groupId: 'devs', groupMissing: true } as Session)
    h.type(command); h.submit()
    expect(h.sent.find(message => message.type === 'session-create')).toMatchObject({ groupId: 'devs', cloneFromSessionId: 'chat-1' })
    h.deliver(newChatCreated('chat-clone'))
    expect(h.sent.filter(message => message.type === 'chat-archive')).toEqual([{ type: 'chat-archive', sessionId: 'chat-1' }])
    h.renderer.unmount()
  })

  test('a creation error leaves the previous chat untouched', () => {
    const h = renderClearable()
    h.type('/clear')
    h.submit()
    h.deliver({ type: 'error', message: 'Claude Agent SDK is unavailable.' })
    expect(h.sent.filter(message => message.type === 'chat-archive')).toEqual([])
    // The failure also cancels the pending archive for later creations.
    h.deliver(newChatCreated('chat-late'))
    expect(h.sent.filter(message => message.type === 'chat-archive')).toEqual([])
    h.renderer.unmount()
  })

  test('a session created in another project does not archive this chat', () => {
    const h = renderClearable()
    h.type('/clear')
    h.submit()
    h.deliver({
      type: 'session-created',
      session: {
        id: 'chat-elsewhere', name: 'Elsewhere', kind: 'chat', projectPath: '/other/project',
        status: 'waiting', lastActivity: 'now', createdAt: 'now', source: 'managed',
      },
    })
    expect(h.sent.filter(message => message.type === 'chat-archive')).toEqual([])
    h.renderer.unmount()
  })
})

describe('chat palette', () => {
  const classOf = (node: ReactTestInstance) => String(node.props.className ?? '')

  test('the chat view opts into the palette and errors use the danger token', () => {
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(<ChatView session={chatSession} sendMessage={() => {}} connectionStatus="connected"
        connectionEpoch={0} error="Connection lost" onClose={() => {}} onKill={() => {}} />)
    })
    expect(classOf(renderer.root.findByProps({ 'data-testid': 'chat-view' })).split(' ')).toContain('chat-palette')
    const banner = renderer.root.findByProps({ role: 'alert' })
    expect(classOf(banner)).toContain('text-chat-danger')
    expect(classOf(banner)).not.toContain('red-400')
    renderer.unmount()

    const messages = TestRenderer.create(<ChatMessages events={[
      { type: 'error', id: 'e', sequence: 0, at: 'now', message: 'Agent crashed' },
    ] as ChatEvent[]} />)
    const error = messages.root.findByProps({ role: 'alert' })
    expect(classOf(error)).toContain('text-chat-danger')
    expect(classOf(error)).not.toContain('red-400')
    messages.unmount()
  })

  test('Debug panel direction labels use the palette tokens', () => {
    const frames = (['out', 'in', 'stderr', 'lifecycle'] as const).map((dir, index) => wireFrame(index + 1, '{"type":"x"}', dir))
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(<ChatDebugPanel sessionId="chat-1" view={{ ...closedDebugView(), open: true, frames }}
        connected sendMessage={() => {}} onClose={() => {}} />)
    })
    const labelClass = (seq: number) => classOf(renderer.root.findByProps({ 'data-frame-seq': seq }).findAllByType('span')[0]!)
    expect(labelClass(1)).toContain('text-chat-wire-out')
    expect(labelClass(2)).toContain('text-chat-wire-in')
    expect(labelClass(3)).toContain('text-chat-wire-stderr')
    expect(labelClass(4)).toContain('text-secondary')
    for (const seq of [1, 2, 3, 4]) expect(labelClass(seq)).not.toMatch(/(sky|emerald|amber)-400/)
    renderer.unmount()
  })
})

describe('chat font size', () => {
  const classOf = (node: ReactTestInstance) => String(node.props.className ?? '')
  const remSized = (node: ReactTestInstance) => /\btext-(xs|sm|base)\b/.test(classOf(node))

  afterEach(() => useSettingsStore.setState({ chatFontSize: 15 }))

  test('the chat root carries the chat font size and the composer uses chat sizing', () => {
    useSettingsStore.setState({ chatFontSize: 18 })
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(<ChatView session={chatSession} sendMessage={() => {}} connectionStatus="connected"
        connectionEpoch={0} error="Connection lost" onClose={() => {}} onKill={() => {}} />)
    })
    const root = renderer.root.findByProps({ 'data-testid': 'chat-view' })
    expect(classOf(root).split(' ')).toContain('chat-root')
    expect(root.props.style['--chat-font-size']).toBe('18px')
    const composer = renderer.root.findByProps({ 'aria-label': 'Message Claude' })
    expect(classOf(composer)).toContain('chat-composer')
    expect(classOf(composer)).toContain('text-chat-body')
    const header = renderer.root.findByType('header')
    expect(header.findAll(node => typeof node.type === 'string' && remSized(node))).toHaveLength(0)
    expect(classOf(renderer.root.findByProps({ role: 'alert' }))).toContain('text-chat-body')
    renderer.unmount()
  })

  test('transcript and request elements use em-based chat sizes, never rem sizes', () => {
    const events = [
      { type: 'user_message', id: 'u', sequence: 0, at: 'now', text: 'hi' },
      { type: 'assistant_text', id: 'a', sequence: 1, at: 'now', text: '# Title\n\nbody' },
      { type: 'tool_call', id: 't', sequence: 2, at: 'now', tool: 'Read', input: {} },
      { type: 'tool_result', id: 'r', sequence: 3, at: 'now', output: 'ok', isError: false },
      { type: 'notice', id: 'n', sequence: 4, at: 'now', text: 'note' },
      { type: 'turn_completed', id: 'c', sequence: 5, at: 'now', subtype: 'success' },
    ] as unknown as ChatEvent[]
    const messages = TestRenderer.create(<ChatMessages events={events} />)
    const transcript = messages.root.findByProps({ 'data-testid': 'chat-transcript' })
    expect(transcript.findAll(node => typeof node.type === 'string' && remSized(node))).toHaveLength(0)
    const user = messages.root.findByProps({ 'data-chat-role': 'user' })
    expect(classOf(user.findAllByType('div')[0]!)).toContain('text-chat-meta')
    expect(classOf(user.findByType('p'))).toContain('text-chat-body')
    messages.unmount()

    const requests = TestRenderer.create(<ChatRequests sessionId="chat-1" sendMessage={() => {}} disabled={false} requests={[
      { kind: 'approval', requestId: 'p', tool: 'Bash', input: { command: 'ls' } },
      { kind: 'question', requestId: 'q', questions: [{ question: 'Pick?', header: 'Pick', multiSelect: false,
        options: [{ label: 'A', description: 'first' }] }] },
    ] as never} />)
    const container = requests.root.findByProps({ 'data-testid': 'chat-requests' })
    expect(container.findAll(node => typeof node.type === 'string' && remSized(node))).toHaveLength(0)
    requests.unmount()
  })
})

describe('chat activity row', () => {
  function renderRow(activity: ChatActivity, phaseStartedAt = Date.now()) {
    let renderer!: TestRenderer.ReactTestRenderer
    // act so the interval effect is registered before timers advance.
    act(() => {
      renderer = TestRenderer.create(
        <ChatActivityRow activity={activity} phaseStartedAt={phaseStartedAt} />
      )
    })
    const row = renderer.root.findByProps({ 'data-testid': 'chat-activity' })
    return { renderer, row, text: textOf(row) }
  }

  test('each phase renders its label', () => {
    const cases: Array<[ChatActivity, string]> = [
      [{ phase: 'requesting', elapsedMs: 0 }, 'Waiting for model…'],
      [{ phase: 'thinking', elapsedMs: 0 }, 'Thinking…'],
      [{ phase: 'preparing_tool', elapsedMs: 0, tool: 'Edit' }, 'Writing Edit input…'],
      [{ phase: 'running_tools', elapsedMs: 0, tool: 'Bash', count: 1 }, 'Running Bash…'],
      [{ phase: 'running_tools', elapsedMs: 0, tool: 'Bash', count: 3 }, 'Running 3 tools…'],
      [{ phase: 'retrying', elapsedMs: 0, attempt: 2, maxRetries: 10, errorStatus: 504 }, 'Retrying (2/10, 504)…'],
      [{ phase: 'retrying', elapsedMs: 0, attempt: 1, maxRetries: 1 }, 'Retrying (1/1)…'],
    ]
    for (const [activity, label] of cases) {
      const { renderer, row, text } = renderRow(activity)
      expect(row.props['data-phase']).toBe(activity.phase)
      expect(text).toContain(label)
      renderer.unmount()
    }
  })

  test('the elapsed time ticks once per second on the client clock', async () => {
    jest.useFakeTimers()
    try {
      const { renderer, row } = renderRow({ phase: 'thinking', elapsedMs: 0 }, Date.now())
      const elapsed = () => textOf(row.findByProps({ 'data-testid': 'chat-activity-elapsed' }))
      expect(elapsed()).toBe('0s')
      await act(async () => { jest.advanceTimersByTime(2_000) })
      expect(elapsed()).toBe('2s')
      await act(async () => { jest.advanceTimersByTime(59_000) })
      expect(elapsed()).toBe('1m 01s')
      renderer.unmount()
    } finally {
      jest.useRealTimers()
    }
  })

  test('ChatView hides the row for responding phases, pending requests, and archived chats', () => {
    const seed = (activity: ChatActivity | null, pendingRequests: ChatPendingRequest[] = []) => {
      useChatStore.setState({ sessions: { 'chat-1': { ...emptyTranscript(), activity: activity
        ? { value: activity, phaseStartedAt: Date.now() - activity.elapsedMs }
        : null, pendingRequests } } })
    }
    const render = (session: Session) => {
      let renderer!: TestRenderer.ReactTestRenderer
      act(() => {
        renderer = TestRenderer.create(<ChatView
          session={session}
          sendMessage={() => {}}
          connectionStatus="connected" connectionEpoch={0} error={null}
          onClose={() => {}} onKill={() => {}} />)
      })
      return renderer
    }
    const rows = (renderer: TestRenderer.ReactTestRenderer) =>
      renderer.root.findAllByProps({ 'data-testid': 'chat-activity' })

    // Positive control: an in-flight thinking turn shows the row.
    seed({ phase: 'thinking', elapsedMs: 4_000 })
    let renderer = render(chatSession)
    expect(rows(renderer)).toHaveLength(1)
    renderer.unmount()

    // Streaming text is its own visible progress (design D4).
    seed({ phase: 'responding', elapsedMs: 1_000 })
    renderer = render(chatSession)
    expect(rows(renderer)).toHaveLength(0)
    renderer.unmount()

    // A pending approval owns the footer.
    seed({ phase: 'running_tools', elapsedMs: 1_000, tool: 'Bash', count: 1 }, [
      { kind: 'approval', requestId: 'r', tool: 'Bash', input: {}, at: 'now' },
    ])
    renderer = render(chatSession)
    expect(rows(renderer)).toHaveLength(0)
    renderer.unmount()

    // Archived chats are read-only.
    const archived = { ...chatSession, archivedAt: '2026-10-01T00:00:00.000Z' } as Session
    seed({ phase: 'thinking', elapsedMs: 4_000 })
    renderer = render(archived)
    expect(rows(renderer)).toHaveLength(0)
    renderer.unmount()
    useChatStore.setState({ sessions: {}, closedAccountNotices: {} })
  })
})

describe('chat usage bar', () => {
  const NOW = Date.parse('2026-10-07T13:00:00.000Z')
  const report = (overrides: Partial<ChatUsageReport> = {}): ChatUsageReport => ({
    status: 'allowed',
    windows: [
      { key: 'five_hour', label: '5-hour window', percentUsed: 22.4, resetsAt: '2026-10-07T18:11:04.000Z' },
      { key: 'seven_day', label: '7-day window', percentUsed: 17.12, resetsAt: '2026-10-12T09:00:00.000Z' },
    ],
    receivedAt: '2026-10-07T13:00:00.000Z',
    ...overrides,
  })
  const meters = (renderer: TestRenderer.ReactTestRenderer) =>
    renderer.root.findAllByProps({ 'data-testid': 'chat-usage-window' })
  const renderBar = (usage: ChatUsageReport | null) => {
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(<UsageBar report={usage} />)
    })
    return renderer
  }

  afterEach(() => {
    useChatStore.setState({ usage: {} })
    jest.useRealTimers()
  })

  test('renders one labeled meter per window with rounded percents', () => {
    jest.useFakeTimers()
    jest.setSystemTime(NOW)
    const renderer = renderBar(report())
    const bar = renderer.root.findByProps({ 'data-testid': 'chat-usage' })
    expect(bar.props['data-status']).toBe('allowed')
    expect(bar.props.className).not.toContain('chat-usage-warning')
    expect(meters(renderer).map((meter) => meter.props['data-key'])).toEqual([
      'five_hour',
      'seven_day',
    ])
    expect(
      meters(renderer).map((meter) =>
        textOf(meter.findByProps({ 'data-testid': 'chat-usage-percent' }))
      )
    ).toEqual(['22%', '17%'])
    renderer.unmount()
  })

  test('a scoped weekly window renders as its own labelled entry', () => {
    const renderer = renderBar(
      report({
        windows: [
          ...report().windows,
          { key: 'model_scoped:Opus', label: 'Opus', percentUsed: 42.5, resetsAt: '2026-10-12T09:00:00.000Z' },
        ],
      })
    )
    const scoped = meters(renderer).find(
      (meter) => meter.props['data-key'] === 'model_scoped:Opus'
    )!
    expect(textOf(scoped.findByProps({ 'data-testid': 'chat-usage-label' }))).toBe('Opus')
    expect(textOf(scoped.findByProps({ 'data-testid': 'chat-usage-percent' }))).toBe('43%')
    renderer.unmount()
  })

  test('a single window renders one meter; none renders nothing at all', () => {
    const one = renderBar(
      report({ windows: [{ key: 'five_hour', label: '5-hour window', percentUsed: 9, resetsAt: null }] })
    )
    expect(meters(one)).toHaveLength(1)
    // No reset time is known: no reset label, no placeholder.
    expect(one.root.findAllByProps({ 'data-testid': 'chat-usage-reset' })).toHaveLength(0)
    one.unmount()

    for (const empty of [null, report({ windows: [] })]) {
      const none = renderBar(empty)
      expect(none.root.findAllByProps({ 'data-testid': 'chat-usage' })).toHaveLength(0)
      none.unmount()
    }
  })

  test('warning and limited reports tint the bar', () => {
    const warning = renderBar(report({ status: 'warning' }))
    expect(
      warning.root.findByProps({ 'data-testid': 'chat-usage' }).props.className
    ).toContain('chat-usage-warning')
    warning.unmount()

    const limited = renderBar(report({ status: 'limited' }))
    const bar = limited.root.findByProps({ 'data-testid': 'chat-usage' })
    expect(bar.props.className).toContain('chat-usage-limited')
    expect(bar.props['data-status']).toBe('limited')
    limited.unmount()
  })

  test('reset times show the weekday only more than a day away', () => {
    jest.useFakeTimers()
    jest.setSystemTime(NOW)
    const renderer = renderBar(report())
    const resets = meters(renderer).map((meter) =>
      textOf(meter.findByProps({ 'data-testid': 'chat-usage-reset' }))
    )
    // 5h window resets today: time only. 7-day window resets Monday: weekday.
    expect(resets[0]).toMatch(/\d{1,2}:\d{2}/)
    expect(resets[0]).not.toMatch(/Mon|Tue|Wed|Thu|Fri|Sat|Sun/)
    expect(resets[1]).toMatch(/Mon|Tue|Wed|Thu|Fri|Sat|Sun/)
    expect(resets[1]).toMatch(/\d{1,2}:\d{2}/)
    renderer.unmount()
  })
})

describe('ChatView usage bar', () => {
  afterEach(() => useChatStore.setState({ usage: {} }))

  function renderView(session: Session) {
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(<ChatView
        session={session}
        sendMessage={() => {}}
        connectionStatus="connected" connectionEpoch={0} error={null}
        onClose={() => {}} onKill={() => {}} />)
    })
    return renderer
  }

  test('shows the profile report under the header and nothing without windows', () => {
    useChatStore.setState({
      usage: {
        default: {
          status: 'allowed',
          windows: [
            { key: 'five_hour', label: '5-hour window', percentUsed: 22.4, resetsAt: '2026-10-07T18:11:04.000Z' },
          ],
          receivedAt: '2026-10-07T13:00:00.000Z',
        },
      },
    })
    let renderer = renderView(chatSession)
    const bar = renderer.root.findByProps({ 'data-testid': 'chat-usage' })
    // Directly under the header, above the transcript column.
    expect(bar.parent?.parent?.props.className).toContain('chat-palette')
    renderer.unmount()

    // A session of a profile with no data (GLM) shows no bar.
    const glm = { ...chatSession, id: 'chat-glm', claudeProfileId: 'glm' } as Session
    renderer = renderView(glm)
    expect(renderer.root.findAllByProps({ 'data-testid': 'chat-usage' })).toHaveLength(0)
    renderer.unmount()
  })
})

describe('chat header rename', () => {
  afterEach(() => { useChatDebugStore.setState({ views: {} }) })

  function renderNameView(session: Session) {
    const sent: ClientMessage[] = []
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(<ChatView
        session={session}
        sendMessage={message => { sent.push(message) }}
        connectionStatus="connected" connectionEpoch={0} error={null}
        onClose={() => {}} onKill={() => {}} />)
    })
    return { sent, renderer }
  }

  const renamesOf = (sent: ClientMessage[]): ClientMessage[] =>
    sent.filter(message => message.type === 'session-rename')

  test('shows the name; clicking it opens an input that submits a rename', () => {
    const { sent, renderer } = renderNameView(chatSession)
    const title = renderer.root.findByProps({ 'data-testid': 'chat-name' })
    expect(textOf(title)).toBe('Chat')
    act(() => { title.props.onClick() })
    const input = renderer.root.findByProps({ 'data-testid': 'chat-name-input' })
    act(() => { input.props.onChange({ target: { value: 'Claude Code Chat subscription usage metrics spec' } }) })
    act(() => { input.props.onKeyDown({ key: 'Enter', preventDefault: () => {} }) })
    expect(renamesOf(sent)).toEqual([{
      type: 'session-rename',
      sessionId: 'chat-1',
      newName: 'Claude Code Chat subscription usage metrics spec',
    }])
    // Editing ended; the title shows the broadcast name once it arrives.
    expect(renderer.root.findAllByProps({ 'data-testid': 'chat-name-input' })).toHaveLength(0)
    renderer.unmount()
  })

  test('an empty name exits editing without sending', () => {
    const { sent, renderer } = renderNameView(chatSession)
    act(() => { renderer.root.findByProps({ 'data-testid': 'chat-name' }).props.onClick() })
    const input = renderer.root.findByProps({ 'data-testid': 'chat-name-input' })
    act(() => { input.props.onChange({ target: { value: '   ' } }) })
    act(() => { input.props.onBlur() })
    expect(renamesOf(sent)).toEqual([])
    expect(renderer.root.findAllByProps({ 'data-testid': 'chat-name-input' })).toHaveLength(0)
    renderer.unmount()
  })

  test('Escape reverts the draft and sends nothing; a broadcast rename shows without a reload', () => {
    const { sent, renderer } = renderNameView(chatSession)
    act(() => { renderer.root.findByProps({ 'data-testid': 'chat-name' }).props.onClick() })
    const input = renderer.root.findByProps({ 'data-testid': 'chat-name-input' })
    act(() => { input.props.onChange({ target: { value: 'discarded' } }) })
    act(() => { input.props.onKeyDown({ key: 'Escape', preventDefault: () => {} }) })
    expect(renamesOf(sent)).toEqual([])
    // The unedited header follows a session-update the way App delivers it:
    // a new session prop with the broadcast name.
    act(() => { renderer.update(<ChatView
      session={{ ...chatSession, name: 'renamed elsewhere' } as Session}
      sendMessage={message => { sent.push(message) }}
      connectionStatus="connected" connectionEpoch={0} error={null}
      onClose={() => {}} onKill={() => {}} />) })
    expect(textOf(renderer.root.findByProps({ 'data-testid': 'chat-name' }))).toBe('renamed elsewhere')
    renderer.unmount()
  })
})

describe('chat context meter', () => {
  afterEach(() => useChatStore.setState({ sessions: {}, usage: {}, drafts: {} }))

  const READING: ChatContextUsage = {
    usedTokens: 157_900,
    thresholdTokens: 167_000,
    percentage: 94.6,
    at: '2026-10-10T12:00:00.000Z',
  }

  function renderView(session: Session = chatSession) {
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(<ChatView
        session={session}
        sendMessage={() => {}}
        connectionStatus="connected" connectionEpoch={0} error={null}
        onClose={() => {}} onKill={() => {}} />)
    })
    return renderer
  }

  test('the header shows the percentage and used / threshold counts beside the status', () => {
    act(() => { useChatStore.getState().setContextUsage('chat-1', READING) })
    const renderer = renderView()
    const meter = renderer.root.findByProps({ 'data-testid': 'chat-context-meter' })
    expect(textOf(meter)).toBe('Context 94.6% · 157.9k / 167k')
    expect(meter.props.title).toContain('157900 of 167000 tokens')
    renderer.unmount()
  })

  test('a coalesced push updates the rendered meter in place', () => {
    act(() => { useChatStore.getState().setContextUsage('chat-1', READING) })
    const renderer = renderView()
    act(() => {
      useChatStore.getState().setContextUsage('chat-1', {
        usedTokens: 8_200, thresholdTokens: 167_000, percentage: 4.9, at: '2026-10-10T12:05:00.000Z',
      })
    })
    expect(textOf(renderer.root.findByProps({ 'data-testid': 'chat-context-meter' }))).toBe('Context 4.9% · 8.2k / 167k')
    renderer.unmount()
  })

  test('no reading renders no meter', () => {
    act(() => { useChatStore.setState({ sessions: {}, closedAccountNotices: {} }) })
    const renderer = renderView()
    expect(renderer.root.findAllByProps({ 'data-testid': 'chat-context-meter' })).toHaveLength(0)
    renderer.unmount()
  })

  test('an archived chat shows the stored reading with no refresh affordance', () => {
    act(() => { useChatStore.getState().setContextUsage('chat-1', READING) })
    const archived = { ...chatSession, archivedAt: '2026-10-01T00:00:00.000Z' } as Session
    const renderer = renderView(archived)
    expect(renderer.root.findByProps({ 'data-testid': 'chat-status' }).children).toContain('archived')
    const meter = renderer.root.findByProps({ 'data-testid': 'chat-context-meter' })
    expect(textOf(meter)).toBe('Context 94.6% · 157.9k / 167k')
    // Inert text beside the archived status — no button, nothing to click.
    expect(meter.findAllByType('button')).toHaveLength(0)
    expect(renderer.root.findByProps({ 'data-testid': 'chat-archived-bar' })).toBeTruthy()
    renderer.unmount()
  })

  test('an approximate threshold is marked, not claimed as the compaction threshold', () => {
    act(() => {
      useChatStore.getState().setContextUsage('chat-1', {
        ...READING, thresholdTokens: 200_000, percentage: 79, thresholdApproximate: true,
      })
    })
    const renderer = renderView()
    const meter = renderer.root.findByProps({ 'data-testid': 'chat-context-meter' })
    expect(textOf(meter)).toBe('Context 79% · 157.9k / 200k~')
    expect(meter.props.title).toContain('standing in for the compaction threshold')
    renderer.unmount()
  })

  test('a null push clears the meter', () => {
    act(() => { useChatStore.getState().setContextUsage('chat-1', READING) })
    const renderer = renderView()
    expect(renderer.root.findByProps({ 'data-testid': 'chat-context-meter' })).toBeTruthy()
    act(() => { useChatStore.getState().setContextUsage('chat-1', null) })
    expect(renderer.root.findAllByProps({ 'data-testid': 'chat-context-meter' })).toHaveLength(0)
    renderer.unmount()
  })
})

describe('chat model badge', () => {
  afterEach(() => useChatStore.setState({ sessions: {}, usage: {}, drafts: {} }))

  function renderView(session: Session = chatSession) {
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(<ChatView
        session={session}
        sendMessage={() => {}}
        connectionStatus="connected" connectionEpoch={0} error={null}
        onClose={() => {}} onKill={() => {}} />)
    })
    return renderer
  }

  test('no badge before the agent reports a model', () => {
    act(() => { useChatStore.setState({ sessions: {}, closedAccountNotices: {} }) })
    const renderer = renderView()
    expect(renderer.root.findAllByProps({ 'data-testid': 'chat-model' })).toHaveLength(0)
    renderer.unmount()
  })

  test('a reported model renders verbatim beside the status', () => {
    act(() => { useChatStore.getState().setModel('chat-1', 'claude-sonnet-5-5') })
    const renderer = renderView()
    const badge = renderer.root.findByProps({ 'data-testid': 'chat-model' })
    expect(textOf(badge)).toBe('claude-sonnet-5-5')
    expect(badge.props.title).toContain('claude-sonnet-5-5')
    // The header keeps its neighbors: status and profile stay present.
    expect(renderer.root.findByProps({ 'data-testid': 'chat-status' })).toBeTruthy()
    expect(renderer.root.findByProps({ 'data-testid': 'chat-profile' })).toBeTruthy()
    renderer.unmount()
  })

  test('a changed model push updates the badge in place', () => {
    act(() => { useChatStore.getState().setModel('chat-1', 'claude-sonnet-5-5') })
    const renderer = renderView()
    act(() => { useChatStore.getState().setModel('chat-1', 'sonnet') })
    expect(textOf(renderer.root.findByProps({ 'data-testid': 'chat-model' }))).toBe('sonnet')
    renderer.unmount()
  })

  test('an archived chat shows the stored model as inert text', () => {
    act(() => { useChatStore.getState().setModel('chat-1', 'claude-sonnet-5-5') })
    const archived = { ...chatSession, archivedAt: '2026-10-01T00:00:00.000Z' } as Session
    const renderer = renderView(archived)
    const badge = renderer.root.findByProps({ 'data-testid': 'chat-model' })
    expect(textOf(badge)).toBe('claude-sonnet-5-5')
    // Inert text beside the archived status — no control to press.
    expect(badge.findAllByType('button')).toHaveLength(0)
    renderer.unmount()
  })
})

describe('formatContextTokens', () => {
  test('rounds to one decimal of the larger unit and promotes at the boundary', () => {
    expect(formatContextTokens(900)).toBe('900')
    expect(formatContextTokens(1_050)).toBe('1.1k')
    expect(formatContextTokens(157_900)).toBe('157.9k')
    expect(formatContextTokens(167_000)).toBe('167k')
    // 999.95k rounds to 1000k — which is 1M, not a four-digit k count.
    expect(formatContextTokens(999_950)).toBe('1M')
    expect(formatContextTokens(1_000_000)).toBe('1M')
    expect(formatContextTokens(1_500_000)).toBe('1.5M')
  })
})

describe('chat workers', () => {
  const SESSION = 'chat-workers-1'
  const agentCall = (toolCallId: string): ChatEvent => ({
    type: 'tool_call', id: `event-${toolCallId}`, sequence: 0, at: 'now', turnId: 'turn-1',
    toolCallId, tool: 'Agent', input: {},
  })
  const rosterWorker = (workerId: string, overrides: Partial<ChatWorker> = {}): ChatWorker => ({
    workerId,
    taskId: `task-${workerId}`,
    agentType: 'Explore',
    description: 'Map the workspace',
    depth: 1,
    status: 'running',
    live: true,
    lastTool: 'Grep',
    elapsedMs: 4_000,
    ...overrides,
  })
  const seedWorkers = (workers: ChatWorker[]) => {
    act(() => { useChatStore.getState().setWorkers(SESSION, workers) })
  }
  afterEach(() => useChatStore.setState({ sessions: {}, workerBodies: {}, closedAccountNotices: {} }))

  test('an Agent call with a roster entry renders the worker summary row', () => {
    seedWorkers([rosterWorker('toolu_w1')])
    const renderer = TestRenderer.create(
      <ChatMessages sessionId={SESSION} events={[agentCall('toolu_w1')]} />
    )
    const summary = renderer.root.findByType('summary')
    const text = textOf(summary)
    expect(text).toContain('Agent · Explore')
    expect(text).toContain('Map the workspace')
    expect(text).toContain('· Grep')
    // Live elapsed anchors on the client clock; only its shape is stable.
    expect(renderer.root.findByProps({ 'data-testid': 'chat-worker-elapsed' })).toBeDefined()
    renderer.unmount()
  })

  test('a worker row absorbs its paired tool result like any other tool', () => {
    seedWorkers([rosterWorker('toolu_w1', { status: 'completed', live: false })])
    const renderer = TestRenderer.create(
      <ChatMessages sessionId={SESSION} events={[agentCall('toolu_w1'), {
        type: 'tool_result', id: 'r-w1', sequence: 1, at: 'now', turnId: 'turn-1',
        toolCallId: 'toolu_w1', output: 'Found three packages.', isError: false,
      }]} />
    )
    expect(renderer.root.findAllByProps({ 'data-testid': 'chat-worker-row' })).toHaveLength(1)
    expect(renderer.root.findAllByType('summary')).toHaveLength(1)
    renderer.unmount()
  })

  test('a roster-less Agent call falls back to the plain tool card', () => {
    const renderer = TestRenderer.create(
      <ChatMessages sessionId={SESSION} events={[agentCall('toolu_unknown')]} />
    )
    expect(textOf(renderer.root.findByType('summary'))).toBe('Agent')
    expect(renderer.root.findAllByProps({ 'data-testid': 'chat-worker-row' })).toHaveLength(0)
    // A non-Agent tool call never becomes a worker row even with a session.
    const plain = TestRenderer.create(<ChatMessages sessionId={SESSION} events={[{
      type: 'tool_call', id: 'e-b', sequence: 0, at: 'now', turnId: 'turn-1',
      toolCallId: 'toolu_b', tool: 'Bash', input: { command: 'ls' },
    }]} />)
    expect(textOf(plain.root.findByType('summary'))).toBe('Bash(ls)')
    renderer.unmount()
    plain.unmount()
  })

  test('the depth badge marks nested spawns only', () => {
    seedWorkers([
      rosterWorker('toolu_top', { depth: 1 }),
      rosterWorker('toolu_nested', { depth: 2 }),
      rosterWorker('toolu_unknown', { depth: undefined }),
    ])
    const renderer = TestRenderer.create(<ChatMessages sessionId={SESSION} events={[
      agentCall('toolu_top'), agentCall('toolu_nested'), agentCall('toolu_unknown'),
    ]} />)
    const badges = renderer.root.findAllByProps({ 'data-testid': 'chat-worker-depth' })
    expect(badges).toHaveLength(1)
    expect(badges[0]!.children).toEqual(['depth 2'])
    renderer.unmount()
  })

  test('the strip lists each live worker with its own tool and elapsed, and hides when none', () => {
    // Created inside act(): later store updates must still re-render it.
    let renderer: TestRenderer.ReactTestRenderer
    act(() => { renderer = TestRenderer.create(<ChatWorkersStrip sessionId={SESSION} />) })
    // Nothing live yet: the strip renders nothing at all.
    expect(renderer!.toJSON()).toBeNull()
    seedWorkers([
      rosterWorker('toolu_w1', { lastTool: 'Grep', description: 'Map the workspace' }),
      rosterWorker('toolu_w2', { lastTool: 'Read', description: 'Index the API' }),
    ])
    const rows = renderer!.root.findAllByProps({ 'data-testid': 'chat-worker-strip-row' })
    expect(rows).toHaveLength(2)
    expect(textOf(rows[0]!)).toContain('Explore')
    expect(textOf(rows[0]!)).toContain('Map the workspace')
    expect(textOf(rows[0]!)).toContain('· Grep')
    expect(textOf(rows[1]!)).toContain('· Read')
    expect(renderer!.root.findAllByProps({ 'data-testid': 'chat-worker-strip-elapsed' })).toHaveLength(2)
    // Settling every worker empties the strip again.
    act(() => {
      useChatStore.getState().setWorkers(SESSION, [
        rosterWorker('toolu_w1', { status: 'completed', live: false }),
        rosterWorker('toolu_w2', { status: 'completed', live: false }),
      ])
    })
    expect(renderer!.toJSON()).toBeNull()
    renderer!.unmount()
  })

  test('the strip mixes live workers with Shell and Monitor task rows, and a settling task leaves it', () => {
    const sent: ClientMessage[] = []
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => { renderer = TestRenderer.create(<ChatWorkersStrip sessionId={SESSION} sendMessage={m => sent.push(m)} connected />) })
    expect(renderer.toJSON()).toBeNull()
    act(() => {
      useChatStore.getState().setWorkers(SESSION, [rosterWorker('toolu_w1', { lastTool: 'Grep' })])
      useChatStore.getState().setBackgroundTasks(SESSION, [
        { taskId: 'b-shell', kind: 'shell', description: 'Wait for CI', status: 'running', live: true, startedAtMs: Date.now() - 4_000, elapsedMs: 4_000 },
        { taskId: 'b-mon', kind: 'monitor', description: 'Watch deploy.log', status: 'running', live: true, startedAtMs: Date.now() - 1_000, elapsedMs: 1_000 },
        { taskId: 'b-done', kind: 'shell', status: 'completed', live: false, startedAtMs: 1, endedAtMs: 2, elapsedMs: 1 },
      ])
    })
    expect(renderer.root.findAllByProps({ 'data-testid': 'chat-worker-strip-row' })).toHaveLength(1)
    const taskRows = renderer.root.findAllByProps({ 'data-testid': 'chat-task-strip-row' })
    expect(taskRows.map(row => row.props['data-task-id'])).toEqual(['b-shell', 'b-mon'])
    expect(textOf(taskRows[0]!)).toContain('Shell')
    expect(textOf(taskRows[0]!)).toContain('Wait for CI')
    expect(textOf(taskRows[1]!)).toContain('Monitor')
    // Each task row carries its own elapsed and its own Stop.
    expect(renderer.root.findAllByProps({ 'data-testid': 'chat-task-strip-elapsed' })).toHaveLength(2)
    const stops = renderer.root.findAllByProps({ 'data-testid': 'chat-task-strip-stop' })
    act(() => { stops[0]!.props.onClick() })
    expect(sent).toEqual([{ type: 'chat-task-stop', sessionId: SESSION, taskId: 'b-shell' }])
    // The CI task settles: its row leaves, the monitor stays, the strip holds.
    act(() => {
      useChatStore.getState().setBackgroundTasks(SESSION, [
        { taskId: 'b-shell', kind: 'shell', status: 'completed', live: false, startedAtMs: 1, endedAtMs: 2, elapsedMs: 1, summary: 'done' },
        { taskId: 'b-mon', kind: 'monitor', description: 'Watch deploy.log', status: 'running', live: true, startedAtMs: Date.now() - 1_000, elapsedMs: 1_000 },
        { taskId: 'b-done', kind: 'shell', status: 'completed', live: false, startedAtMs: 1, endedAtMs: 2, elapsedMs: 1 },
      ])
    })
    expect(renderer.root.findAllByProps({ 'data-testid': 'chat-task-strip-row' })).toHaveLength(1)
    // Everything settles: the strip hides again.
    act(() => {
      useChatStore.getState().setWorkers(SESSION, [rosterWorker('toolu_w1', { status: 'completed', live: false })])
      useChatStore.getState().setBackgroundTasks(SESSION, [
        { taskId: 'b-mon', kind: 'monitor', status: 'completed', live: false, startedAtMs: 1, endedAtMs: 2, elapsedMs: 1 },
      ])
    })
    expect(renderer.toJSON()).toBeNull()
    renderer.unmount()
  })

  test('expanding fetches the body once and renders it; a missing file reports unavailable', () => {
    seedWorkers([rosterWorker('toolu_w1')])
    const sent: ClientMessage[] = []
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(
        <ChatMessages sessionId={SESSION} events={[agentCall('toolu_w1')]}
          sendMessage={message => sent.push(message)} connected />
      )
    })
    const row = renderer.root.findByProps({ 'data-testid': 'chat-worker-row' })
    // Opening fetches; re-toggles and re-renders never re-send (design D5).
    act(() => { row.props.onToggle({ currentTarget: { open: true } }) })
    act(() => { row.props.onToggle({ currentTarget: { open: false } }) })
    act(() => { row.props.onToggle({ currentTarget: { open: true } }) })
    expect(sent).toEqual([
      { type: 'chat-worker-transcript', sessionId: SESSION, workerId: 'toolu_w1' },
    ])
    expect(textOf(renderer.root.findByProps({ 'data-testid': 'chat-worker-body-status' }))).toBe('Loading…')
    act(() => {
      useChatStore.getState().setWorkerBody({
        type: 'chat-worker-transcript', sessionId: SESSION, workerId: 'toolu_w1',
        status: 'ok',
        events: [
          { type: 'user_message', id: 'w1', sequence: 0, at: 'now', turnId: 't', text: 'map the workspace' },
          { type: 'assistant_text', id: 'w2', sequence: 1, at: 'now', turnId: 't', messageId: 'm', text: 'mapped 14 files' },
        ],
      })
    })
    const body = renderer.root.findByProps({ 'data-testid': 'chat-worker-body' })
    expect(textOf(body)).toContain('map the workspace')
    expect(textOf(body)).toContain('mapped 14 files')
    renderer.unmount()

    // A worker whose file is missing reports the body unavailable.
    seedWorkers([rosterWorker('toolu_missing')])
    let missing: TestRenderer.ReactTestRenderer
    act(() => {
      missing = TestRenderer.create(
        <ChatMessages sessionId={SESSION} events={[agentCall('toolu_missing')]}
          sendMessage={message => sent.push(message)} connected />
      )
    })
    act(() => {
      missing!.root.findByProps({ 'data-testid': 'chat-worker-row' }).props.onToggle({ currentTarget: { open: true } })
    })
    act(() => {
      useChatStore.getState().setWorkerBody({
        type: 'chat-worker-transcript', sessionId: SESSION, workerId: 'toolu_missing',
        status: 'unavailable', events: [],
      })
    })
    expect(textOf(missing!.root.findByProps({ 'data-testid': 'chat-worker-body-status' })))
      .toContain('Body unavailable')
    missing!.unmount()
  })

  test('a fetch stranded by a dead socket does not burn its one-shot marker; reconnect retries it', () => {
    seedWorkers([rosterWorker('toolu_w1')])
    const sent: ClientMessage[] = []
    let renderer!: TestRenderer.ReactTestRenderer
    const render = (connected: boolean) => {
      const element = (
        <ChatMessages sessionId={SESSION} events={[agentCall('toolu_w1')]}
          sendMessage={message => sent.push(message)} connected={connected} />
      )
      if (renderer) renderer.update(element)
      else renderer = TestRenderer.create(element)
    }
    act(() => { render(false) })
    // Expanding while offline sends nothing and shows the reconnect notice.
    act(() => {
      renderer.root.findByProps({ 'data-testid': 'chat-worker-row' }).props.onToggle({ currentTarget: { open: true } })
    })
    expect(sent).toEqual([])
    expect(textOf(renderer.root.findByProps({ 'data-testid': 'chat-worker-body-status' })))
      .toBe('Body unavailable — reconnect to load it.')
    // The socket returns: the still-open row fetches at last.
    act(() => { render(true) })
    expect(sent).toEqual([
      { type: 'chat-worker-transcript', sessionId: SESSION, workerId: 'toolu_w1' },
    ])
    expect(useChatStore.getState().workerBodies[SESSION]!.toolu_w1).toEqual({ status: 'fetching' })
    // The socket dies mid-fetch: the marker rolls back instead of stranding…
    act(() => { render(false) })
    expect(useChatStore.getState().workerBodies[SESSION]!.toolu_w1).toBeUndefined()
    // …so the next reconnect can request the body again.
    act(() => { render(true) })
    expect(sent).toEqual([
      { type: 'chat-worker-transcript', sessionId: SESSION, workerId: 'toolu_w1' },
      { type: 'chat-worker-transcript', sessionId: SESSION, workerId: 'toolu_w1' },
    ])
    renderer.unmount()
  })

  test('a settled worker renders its outcome and summary, as archived chats do', () => {
    seedWorkers([rosterWorker('toolu_done', {
      status: 'completed', live: false, summary: 'Mapped 14 files',
    })])
    const sent: ClientMessage[] = []
    const renderer = TestRenderer.create(
      <ChatMessages sessionId={SESSION} events={[agentCall('toolu_done')]}
        sendMessage={message => sent.push(message)} connected />
    )
    const row = renderer.root.findByProps({ 'data-testid': 'chat-worker-row' })
    expect(row.props['data-status']).toBe('completed')
    expect(textOf(renderer.root.findByType('summary'))).toContain('done')
    expect(textOf(renderer.root.findByProps({ 'data-testid': 'chat-worker-summary' }))).toBe('Mapped 14 files')
    // Expand stays available on the settled row.
    act(() => { row.props.onToggle({ currentTarget: { open: true } }) })
    expect(sent).toEqual([
      { type: 'chat-worker-transcript', sessionId: SESSION, workerId: 'toolu_done' },
    ])
    renderer.unmount()
  })

  test('an archived ChatView shows persisted outcomes with no strip or running state', () => {
    const archived = { ...chatSession, archivedAt: '2026-10-01T00:00:00.000Z' } as Session
    const render = (session: Session) => {
      let renderer!: TestRenderer.ReactTestRenderer
      act(() => {
        renderer = TestRenderer.create(<ChatView
          session={session}
          sendMessage={() => {}}
          connectionStatus="connected" connectionEpoch={0} error={null}
          onClose={() => {}} onKill={() => {}} />)
      })
      return renderer
    }
    const seed = (workers: ChatWorker[]) => {
      useChatStore.getState().snapshot({
        type: 'chat-snapshot', sessionId: chatSession.id, profileId: 'default',
        events: [agentCall('toolu_done'), agentCall('toolu_live')],
        pendingRequests: [], status: 'waiting', throughSequence: 0,
        commands: { status: 'unavailable', commands: [] }, activity: null,
        contextUsage: null, usage: null, workers, backgroundTasks: [], notifications: [], model: null,
      })
    }
    const workers = [
      rosterWorker('toolu_done', { status: 'failed', live: false, summary: 'Ran out of budget' }),
      rosterWorker('toolu_live'),
    ]

    // Positive control: a live chat shows the strip for the live worker.
    seed(workers)
    let renderer = render(chatSession)
    expect(renderer.root.findAllByProps({ 'data-testid': 'chat-workers-strip' })).toHaveLength(1)
    renderer.unmount()

    // Archived: settled rows only (the server stops every worker on archive).
    seed([workers[0]!, rosterWorker('toolu_live', { status: 'stopped', live: false })])
    renderer = render(archived)
    expect(renderer.root.findAllByProps({ 'data-testid': 'chat-workers-strip' })).toHaveLength(0)
    const rows = renderer.root.findAllByProps({ 'data-testid': 'chat-worker-row' })
    expect(rows.map(row => row.props['data-status'])).toEqual(['failed', 'stopped'])
    expect(renderer.root.findAllByProps({ 'data-testid': 'chat-worker-elapsed' })).toHaveLength(0)
    expect(textOf(renderer.root.findByProps({ 'data-testid': 'chat-worker-summary' }))).toBe('Ran out of budget')
    renderer.unmount()
    useChatStore.setState({ sessions: {}, closedAccountNotices: {} })
  })
})

describe('chat notification strip', () => {
  const notice = (overrides: Partial<ChatNotification> = {}): ChatNotification => ({
    key: 'model-context-window',
    source: 'agent',
    severity: 'warning',
    priority: 'high',
    text: 'Context left: less than 20%',
    receivedAt: '2026-10-12T00:00:00.000Z',
    ...overrides,
  })
  const closed: ChatNotification[] = []
  function renderStrip(notifications: ChatNotification[]) {
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(
        <NotificationStrip notifications={notifications} onClose={n => closed.push(n)} />
      )
    })
    return renderer
  }
  const rows = (renderer: TestRenderer.ReactTestRenderer) =>
    renderer.root.findAllByProps({ 'data-testid': 'chat-notification' })

  test('renders nothing when the session has no active notices', () => {
    const renderer = renderStrip([])
    expect(renderer.root.children).toEqual([])
    renderer.unmount()
  })

  test('warning and error notices style by severity; a hint renders dimmed', () => {
    const renderer = renderStrip([
      notice({ severity: 'warning', hint: undefined }),
      notice({ key: 'error-compacting-conversation', severity: 'error', text: 'Error compacting conversation' }),
      notice({ key: 'memory-paused', severity: 'info', text: 'Memory is paused' }),
    ])
    const styled = rows(renderer)
    expect(styled.map(row => row.props['data-severity'])).toEqual(['warning', 'error', 'info'])
    expect(styled[0]!.props.className).toContain('text-approval')
    expect(styled[1]!.props.className).toContain('text-chat-danger')
    expect(styled[2]!.props.className).toContain('text-primary')
    renderer.unmount()
  })

  test('the login notice shows its text with the dimmed renewal hint', () => {
    const renderer = renderStrip([
      notice({
        key: 'login-expiry',
        source: 'account',
        severity: 'warning',
        priority: 'high',
        text: 'Your login expires in 2 days',
        hint: 'run /login in a Claude terminal to renew',
      }),
    ])
    const row = rows(renderer)[0]!
    expect(textOf(row)).toContain('Your login expires in 2 days')
    expect(textOf(row)).toContain('run /login in a Claude terminal to renew')
    renderer.unmount()
  })

  test('rows render in the delivered (priority-sorted) order', () => {
    const renderer = renderStrip([
      notice({ key: 'urgent', priority: 'immediate', severity: 'error', text: 'now' }),
      notice({ key: 'low', priority: 'low', severity: 'info', text: 'meh' }),
    ])
    expect(rows(renderer).map(row => row.props['data-key'])).toEqual(['urgent', 'low'])
    renderer.unmount()
  })

  test('close buttons call onClose with their own notice', () => {
    const list = [
      notice({ key: 'a', text: 'first' }),
      notice({ key: 'login-expiry', source: 'account', text: 'Your login expires in 2 days', hint: 'run /login in a Claude terminal to renew' }),
    ]
    const renderer = renderStrip(list)
    const buttons = renderer.root.findAllByProps({ 'data-testid': 'chat-notification-close' })
    act(() => buttons[0]!.props.onClick())
    act(() => buttons[1]!.props.onClick())
    expect(closed).toEqual([list[0], list[1]])
    renderer.unmount()
  })
})

describe('chat task header (the Team page owns the tasks view)', () => {
  afterEach(() => {
    useTeamTaskStore.setState({ views: {} })
    resetTeamLocationForTests()
  })

  test('the header names the task; clicking opens the Team page on it; no tasks view mounts in the chat', () => {
    const sent: ClientMessage[] = []
    const session = { ...chatSession, spawned: true, taskId: 'task-1', taskTitle: 'Export' } as Session
    const props = { session, sendMessage: (message: ClientMessage) => { sent.push(message) }, connectionStatus: 'connected' as const, error: null, onClose: () => {}, onKill: () => {} }
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => { renderer = TestRenderer.create(<ChatView {...props} connectionEpoch={0}
      onOpenTeam={teamKey => useTeamLocationStore.getState().navigate({ teamKey, tab: 'tasks' })}
      onOpenTask={(teamKey, taskId) => useTeamLocationStore.getState().navigate({ teamKey, tab: 'tasks', id: taskId })} />) })
    const link = renderer.root.findByProps({ 'data-testid': 'chat-task' })
    expect(textOf(link.parent!)).toBe('Spawned for task Export')
    act(() => link.props.onClick())
    // The chip routes to the Team page's Tasks tab with that task; the chat
    // itself never mounts a team view (4.2) nor sends a team message.
    expect(useTeamLocationStore.getState().location).toEqual({ teamKey: '/tmp/project', tab: 'tasks', id: 'task-1' })
    expect(renderer.root.findAllByProps({ 'data-testid': 'team-tasks' })).toHaveLength(0)
    expect(sent.filter(message => message.type.startsWith('team-'))).toHaveLength(0)
    act(() => renderer.unmount())
  })

  test('a paused chat names its reason and resume time in the header', () => {
    jest.useFakeTimers()
    // Keep the resume within the same local day even when tests run near midnight.
    jest.setSystemTime(new Date(2026, 9, 12, 12, 0))
    try {
      const until = new Date(Date.now() + 40 * 60_000).toISOString()
      const session = { ...chatSession, parked: { messageId: 'm1', until, profileId: 'glm', reason: 'Provider limit on glm' } } as Session
      let renderer!: TestRenderer.ReactTestRenderer
      act(() => { renderer = TestRenderer.create(<ChatView session={session} sendMessage={() => {}} connectionStatus="connected" connectionEpoch={0} error={null} onClose={() => {}} onKill={() => {}} />) })
      const time = new Date(until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      expect(textOf(renderer.root.findByProps({ 'data-testid': 'chat-paused' }))).toBe(`Paused: Provider limit on glm · resumes ${time}`)
      act(() => renderer.update(<ChatView session={{ ...session, parked: null }} sendMessage={() => {}} connectionStatus="connected" connectionEpoch={0} error={null} onClose={() => {}} onKill={() => {}} />))
      expect(renderer.root.findAllByProps({ 'data-testid': 'chat-paused' })).toHaveLength(0)
      act(() => renderer.unmount())
    } finally { jest.useRealTimers() }
  })

  test('a chat without a task shows no task line', () => {
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => { renderer = TestRenderer.create(<ChatView session={chatSession} sendMessage={() => {}} connectionStatus="connected" connectionEpoch={0} error={null} onClose={() => {}} onKill={() => {}} />) })
    expect(renderer.root.findAllByProps({ 'data-testid': 'chat-task' })).toHaveLength(0)
    act(() => renderer.unmount())
  })
})

describe('agent-started turn trigger lines (background tasks D5)', () => {
  test('a task trigger lists each task summary in place of a user bubble', () => {
    const renderer = TestRenderer.create(<ChatMessages events={[
      { type: 'turn_started', id: 'ts', sequence: 0, at: 'now', turnId: 't1', trigger: { kind: 'task', tasks: [
        { taskId: 'b1', toolCallId: 'call_1', status: 'completed', summary: 'Background command "Wait for CI" completed (exit code 0)' },
        { taskId: 'b2', status: 'failed' },
      ] } },
      { type: 'assistant_text', id: 'a', sequence: 1, at: 'now', turnId: 't1', messageId: 'm', text: 'CI passed.' },
    ]} />)
    const trigger = renderer.root.findByProps({ 'data-testid': 'turn-trigger' })
    const lines = trigger.findAllByType('span').map(span => textOf(span))
    expect(lines).toEqual([
      '⟲ Background command "Wait for CI" completed (exit code 0)',
      '⟲ Task b2 failed',
    ])
    // No user bubble for an agent-started turn, and the reply streams after it.
    expect(renderer.root.findAllByProps({ 'data-chat-role': 'user' })).toHaveLength(0)
    expect(renderer.root.findAllByProps({ 'data-chat-role': 'assistant' })).toHaveLength(1)
    expect(JSON.stringify(renderer.toJSON())).not.toContain('<task-notification>')
    renderer.unmount()
  })

  // @covers: chat-sessions › Turns the agent starts on its own are shown › Trigger without a known cause
  test('repeated resumed triggers draw no rows while every output still renders', () => {
    const renderer = TestRenderer.create(<ChatMessages events={[
      { type: 'turn_started', id: 'ts1', sequence: 0, at: 'now', turnId: 't1', trigger: { kind: 'resumed' } },
      { type: 'assistant_text', id: 'a1', sequence: 1, at: 'now', turnId: 't1', messageId: 'm1', text: 'First resumed turn.' },
      { type: 'turn_started', id: 'ts2', sequence: 2, at: 'now', turnId: 't2', trigger: { kind: 'resumed' } },
      { type: 'assistant_text', id: 'a2', sequence: 3, at: 'now', turnId: 't2', messageId: 'm2', text: 'Second resumed turn.' },
    ]} />)
    expect(renderer.root.findAllByProps({ 'data-testid': 'turn-trigger' })).toHaveLength(0)
    expect(textOf(renderer.root)).not.toContain('Continued on its own')
    expect(renderer.root.findAllByProps({ 'data-chat-role': 'assistant' })).toHaveLength(2)
    renderer.unmount()
  })

  // @covers: chat-sessions › Turns the agent starts on its own are shown › Trigger without a known cause
  test('an empty task-list trigger draws no row and no blank aside', () => {
    const renderer = TestRenderer.create(<ChatMessages events={[
      { type: 'turn_started', id: 'ts', sequence: 0, at: 'now', turnId: 't1', trigger: { kind: 'task', tasks: [] } },
      { type: 'assistant_text', id: 'a1', sequence: 1, at: 'now', turnId: 't1', messageId: 'm', text: 'Done anyway.' },
    ]} />)
    expect(renderer.root.findAllByProps({ 'data-testid': 'turn-trigger' })).toHaveLength(0)
    expect(renderer.root.findAllByProps({ 'data-chat-role': 'assistant' })).toHaveLength(1)
    renderer.unmount()
  })

  // @covers: chat-sessions › Turns the agent starts on its own are shown › Trigger without a known cause
  test('a transcript opening with a hidden marker renders its first row plain', () => {
    const renderer = TestRenderer.create(<ChatMessages events={[
      { type: 'turn_started', id: 'ts', sequence: 0, at: 'now', turnId: 't1' },
      { type: 'user_message', id: 'u1', sequence: 1, at: 'now', turnId: 't1', text: 'hello' },
      { type: 'user_message', id: 'u2', sequence: 2, at: 'now', turnId: 't2', text: 'again' },
    ]} />)
    const articles = renderer.root.findAllByType('article')
    // The hidden leading marker must not give the first visible row turn
    // spacing; a later real turn still separates.
    expect(articles[0]!.props.className).toBe('chat-row')
    expect(articles[1]!.props.className).toBe('chat-row chat-row-turn')
    renderer.unmount()
  })

  // @covers: chat-sessions › Turns the agent starts on its own are shown › Trigger without a known cause
  test('a leading resumed trigger leaves the first output row plain', () => {
    const renderer = TestRenderer.create(<ChatMessages events={[
      { type: 'turn_started', id: 'tr', sequence: 0, at: 'now', turnId: 't1', trigger: { kind: 'resumed' } },
      { type: 'assistant_text', id: 'a1', sequence: 1, at: 'now', turnId: 't1', messageId: 'm', text: 'Continued on its own.' },
    ]} />)
    const articles = renderer.root.findAllByType('article')
    expect(articles).toHaveLength(1)
    expect(articles[0]!.props.className).toBe('chat-row')
    renderer.unmount()
  })

  // @covers: chat-sessions › Turns the agent starts on its own are shown › Trigger without a known cause
  test('several leading hidden markers still render the first row plain', () => {
    const renderer = TestRenderer.create(<ChatMessages events={[
      { type: 'turn_started', id: 'ts', sequence: 0, at: 'now', turnId: 't1' },
      { type: 'turn_started', id: 'tr', sequence: 1, at: 'now', turnId: 't1', trigger: { kind: 'resumed' } },
      { type: 'turn_started', id: 'te', sequence: 2, at: 'now', turnId: 't1', trigger: { kind: 'task', tasks: [] } },
      { type: 'user_message', id: 'u1', sequence: 3, at: 'now', turnId: 't1', text: 'hello' },
    ]} />)
    expect(renderer.root.findAllByProps({ 'data-testid': 'turn-trigger' })).toHaveLength(0)
    expect(renderer.root.findAllByType('article')[0]!.props.className).toBe('chat-row')
    renderer.unmount()
  })

  test('the quoted generic phrase stays ordinary content inside real messages', () => {
    const renderer = TestRenderer.create(<ChatMessages events={[
      { type: 'user_message', id: 'u', sequence: 0, at: 'now', turnId: 't1', text: 'Stop showing "Continued on its own" after every turn.' },
      { type: 'assistant_text', id: 'a', sequence: 1, at: 'now', turnId: 't1', messageId: 'm', text: 'Understood — "Continued on its own" was only a notice line.' },
    ]} />)
    // No filtering of message text: the literal appears in both rows.
    expect(textOf(renderer.root).split('Continued on its own')).toHaveLength(3)
    expect(renderer.root.findAllByProps({ 'data-testid': 'turn-trigger' })).toHaveLength(0)
    renderer.unmount()
  })

  // @covers: chat-sessions › Turns the agent starts on its own are shown › Replayed history shows the trigger, not raw markup
  // @covers: chat-sessions › Transcript layout preserves rich event information and controls › Turn and request information
  test('replayed mixed turns keep their order and authors with a hidden resumed trigger', () => {
    const renderer = TestRenderer.create(<ChatMessages events={[
      { type: 'turn_started', id: 'ts1', sequence: 0, at: '2026-10-15T23:00:00Z', turnId: 't1', trigger: { kind: 'resumed' } },
      { type: 'assistant_text', id: 'a1', sequence: 1, at: '2026-10-15T23:00:05Z', turnId: 't1', messageId: 'm1', text: 'night work' },
      { type: 'user_message', id: 'u1', sequence: 2, at: '2026-10-16T08:00:00Z', turnId: 't2', text: 'morning question' },
      { type: 'tool_call', id: 'c1', sequence: 3, at: '2026-10-16T08:00:10Z', turnId: 't2', toolCallId: 'call_1', tool: 'Read', input: {} },
      { type: 'peer_message', id: 'p1', sequence: 4, at: '2026-10-16T08:00:20Z', turnId: 't2', messageId: 'p1',
        senderSession: 's-9', senderGroup: 'reviewers', priority: 'normal', tags: [], originPath: '/repo',
        threadId: 'th', body: 'peer note', possibleDuplicate: false },
      { type: 'turn_started', id: 'ts2', sequence: 5, at: '2026-10-16T08:01:00Z', turnId: 't3', trigger: { kind: 'task', tasks: [{ taskId: 'b7', status: 'completed', summary: 'CI finished' }] } },
      { type: 'assistant_text', id: 'a2', sequence: 6, at: '2026-10-16T08:01:10Z', turnId: 't3', messageId: 'm2', text: 'after CI' },
    ]} />)
    // The hidden resumed trigger leaves no row and no gap; the named task
    // trigger still names its task, and every real row keeps its order.
    expect(renderer.root.findAllByProps({ 'data-testid': 'turn-trigger' }).map(node => textOf(node)))
      .toEqual(['⟲ CI finished'])
    const anchors = renderer.root
      .findAll(node => Boolean(node.props) && 'data-anchor-id' in node.props)
      .map(node => node.props['data-anchor-id'])
    expect(anchors.filter(id => ['a1', 'u1', 'tool:call_1', 'p1', 'a2'].includes(id)))
      .toEqual(['a1', 'u1', 'tool:call_1', 'p1', 'a2'])
    const text = textOf(renderer.root)
    expect(text).toContain('You')
    expect(text).toContain('Claude')
    expect(text).toContain('Peer')
    renderer.unmount()
  })

  test('a user-started turn_started renders no trigger line', () => {
    const renderer = TestRenderer.create(<ChatMessages events={[
      { type: 'turn_started', id: 'ts', sequence: 0, at: 'now', turnId: 't1' },
      { type: 'user_message', id: 'u', sequence: 1, at: 'now', turnId: 't1', text: 'hello' },
    ]} />)
    expect(renderer.root.findAllByProps({ 'data-testid': 'turn-trigger' })).toHaveLength(0)
    expect(renderer.root.findAllByProps({ 'data-chat-role': 'user' })).toHaveLength(1)
    renderer.unmount()
  })
})

describe('chat task rows (background tasks)', () => {
  const bashCall = {
    type: 'tool_call' as const, id: 't1', sequence: 0, at: 'now', turnId: 'turn-1',
    toolCallId: 'call_1', tool: 'Bash', input: { command: 'sleep 20; echo done', run_in_background: true },
  }
  const monitorCall = {
    type: 'tool_call' as const, id: 't2', sequence: 0, at: 'now', turnId: 'turn-1',
    toolCallId: 'call_m', tool: 'Monitor', input: { command: 'tail -f build.log' },
  }

  const seedTasks = (tasks: ChatBackgroundTask[]) => {
    useChatStore.getState().snapshot({
      type: 'chat-snapshot', sessionId: 'chat-1', profileId: 'default',
      events: [], pendingRequests: [], status: 'waiting', throughSequence: 0,
      commands: { status: 'unavailable', commands: [] }, activity: null,
      contextUsage: null, usage: null, workers: [], backgroundTasks: tasks, notifications: [], model: null,
    })
  }
  const liveTask = (overrides: Partial<ChatBackgroundTask> = {}): ChatBackgroundTask => ({
    taskId: 'b1', toolCallId: 'call_1', kind: 'shell', description: 'Wait for CI',
    status: 'running', live: true, startedAtMs: Date.now() - 5_000, elapsedMs: 5_000, ...overrides,
  })

  afterEach(() => useChatStore.setState({ sessions: {}, workerBodies: {}, taskOutputs: {}, closedAccountNotices: {} }))

  const rowOf = (renderer: TestRenderer.ReactTestRenderer) =>
    renderer.root.findByProps({ 'data-testid': 'chat-task-row' })
  const open = (renderer: TestRenderer.ReactTestRenderer, state: boolean) => {
    act(() => { rowOf(renderer).props.onToggle({ currentTarget: { open: state } }) })
  }

  test('a live task shows the running mark, ticking elapsed, and Stop', () => {
    const sent: unknown[] = []
    seedTasks([liveTask()])
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => { renderer = TestRenderer.create(<ChatMessages events={[bashCall]} sessionId="chat-1" sendMessage={m => sent.push(m)} connected />) })
    const row = rowOf(renderer)
    expect(row.props['data-status']).toBe('running')
    expect(renderer.root.findByProps({ 'data-testid': 'chat-task-elapsed' }).children.join('')).toMatch(/5s/)
    expect(renderer.root.findByProps({ 'data-testid': 'chat-task-stop' })).toBeDefined()
    // No roster-driven fetch happened: expanding is what asks for the tail.
    expect(sent).toEqual([])
    act(() => renderer.unmount())
  })

  test('expanding fetches the tail, strips ANSI, and re-polls only while live and open', () => {
    jest.useFakeTimers()
    try {
      const sent: unknown[] = []
      seedTasks([liveTask()])
      let renderer!: TestRenderer.ReactTestRenderer
      act(() => { renderer = TestRenderer.create(<ChatMessages events={[bashCall]} sessionId="chat-1" sendMessage={m => sent.push(m)} connected />) })
      open(renderer, true)
      expect(sent).toEqual([{ type: 'chat-task-output', sessionId: 'chat-1', taskId: 'b1' }])
      act(() => { useChatStore.getState().setTaskOutput({
        type: 'chat-task-output', sessionId: 'chat-1', taskId: 'b1', state: 'ok',
        output: '\u001b[32mbuilding\u001b[0m 42%\n', totalBytes: 99, truncated: false,
      }) })
      const outputPre = renderer.root.findByProps({ 'data-testid': 'chat-task-output' }).findByType('pre')
      expect(outputPre.children.join('')).toContain('building 42%')
      expect(JSON.stringify(renderer.toJSON())).not.toContain('\\u001b')
      // The reply landed: the next interval tick re-fetches while open+live…
      act(() => { jest.advanceTimersByTime(2_000) })
      expect(sent.length).toBe(2)
      // The poll's reply must land, or its in-flight marker blocks re-fetches.
      act(() => { useChatStore.getState().setTaskOutput({
        type: 'chat-task-output', sessionId: 'chat-1', taskId: 'b1', state: 'ok',
        output: 'building 90%\n', totalBytes: 120, truncated: false,
      }) })
      // …collapsing stops the requests (openRef gates the tick)…
      open(renderer, false)
      act(() => { jest.advanceTimersByTime(6_000) })
      expect(sent.length).toBe(2)
      // …and settling stops them outright: the roster going not-live removes
      // the interval and a new expand fetches exactly once.
      act(() => { useChatStore.getState().setBackgroundTasks('chat-1', [liveTask({ status: 'completed', live: false, endedAtMs: Date.now(), summary: 'done (exit code 0)' })]) })
      open(renderer, true)
      expect(sent.length).toBe(3)
      act(() => { jest.advanceTimersByTime(6_000) })
      expect(sent.length).toBe(3)
      act(() => renderer.unmount())
    } finally {
      jest.useRealTimers()
    }
  })

  test('a settled task shows its outcome, ✗ on failed, and no Stop; truncation and unavailable notes', () => {
    seedTasks([
      liveTask({ taskId: 'bf', status: 'failed', live: false, endedAtMs: Date.now(), summary: 'exit 1' }),
      liveTask({ taskId: 'bt', toolCallId: 'call_m', kind: 'monitor', status: 'completed', live: false, endedAtMs: Date.now(), summary: 'Monitor "tail" stream ended' }),
    ])
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => { renderer = TestRenderer.create(<ChatMessages events={[bashCall, monitorCall]} sessionId="chat-1" connected />) })
    const rows = renderer.root.findAllByProps({ 'data-testid': 'chat-task-row' })
    expect(rows[0]!.props['data-status']).toBe('failed')
    const labels = renderer.root.findAllByProps({ 'data-testid': 'chat-task-status' }).map(node => node.children.join(''))
    expect(labels.some(text => text.includes('✗'))).toBe(true)
    expect(labels.some(text => text.includes('done') || text === '')).toBe(true)
    expect(renderer.root.findAllByProps({ 'data-testid': 'chat-task-stop' })).toHaveLength(0)
    expect(rows[1]!.props['data-kind']).toBe('monitor')
    // A truncated tail notes the omission; unavailable says so.
    act(() => { useChatStore.getState().setTaskOutput({ type: 'chat-task-output', sessionId: 'chat-1', taskId: 'bt', state: 'ok', output: 'x'.repeat(10), totalBytes: 9_000, truncated: true }) })
    expect(renderer.root.findByProps({ 'data-testid': 'chat-task-output-truncated' })).toBeDefined()
    act(() => { useChatStore.getState().setTaskOutput({ type: 'chat-task-output', sessionId: 'chat-1', taskId: 'bf', state: 'unavailable' }) })
    const statuses = renderer.root.findAllByProps({ 'data-testid': 'chat-task-output-status' }).map(node => node.children.join(''))
    expect(statuses.some(text => text.includes('unavailable'))).toBe(true)
    act(() => renderer.unmount())
  })

  test('archived chats and unknown calls never offer Stop or a task row', () => {
    seedTasks([liveTask()])
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => { renderer = TestRenderer.create(<ChatMessages events={[bashCall]} sessionId="chat-1" archived connected />) })
    expect(renderer.root.findAllByProps({ 'data-testid': 'chat-task-stop' })).toHaveLength(0)
    act(() => renderer.unmount())
    // No roster entry (a foreground call): the plain tool card renders.
    seedTasks([])
    act(() => { renderer = TestRenderer.create(<ChatMessages events={[bashCall]} sessionId="chat-1" connected />) })
    expect(renderer.root.findAllByProps({ 'data-testid': 'chat-task-row' })).toHaveLength(0)
    expect(renderer.root.findAllByType('details').length).toBeGreaterThan(0)
    act(() => renderer.unmount())
  })

  test('a row still open when the task settles fetches the final tail once', () => {
    jest.useFakeTimers()
    try {
      const sent: ClientMessage[] = []
      seedTasks([liveTask()])
      let renderer!: TestRenderer.ReactTestRenderer
      act(() => { renderer = TestRenderer.create(<ChatMessages events={[bashCall]} sessionId="chat-1" sendMessage={m => sent.push(m)} connected />) })
      open(renderer, true)
      expect(sent.length).toBe(1)
      act(() => { useChatStore.getState().setTaskOutput({ type: 'chat-task-output', sessionId: 'chat-1', taskId: 'b1', state: 'ok', output: 'building…\n', totalBytes: 20, truncated: false }) })
      // The task settles while the row stays open: one more fetch replaces
      // the last running snapshot with the final output.
      act(() => { useChatStore.getState().setBackgroundTasks('chat-1', [liveTask({ status: 'completed', live: false, endedAtMs: Date.now(), summary: 'done (exit code 0)' })]) })
      expect(sent.length).toBe(2)
      act(() => { useChatStore.getState().setTaskOutput({ type: 'chat-task-output', sessionId: 'chat-1', taskId: 'b1', state: 'ok', output: 'fixture-shell-done\n', totalBytes: 40, truncated: false }) })
      const outputPre = renderer.root.findByProps({ 'data-testid': 'chat-task-output' }).findByType('pre')
      expect(outputPre.children.join('')).toContain('fixture-shell-done')
      // And no interval keeps firing after the settle.
      act(() => { jest.advanceTimersByTime(6_000) })
      expect(sent.length).toBe(2)
      act(() => renderer.unmount())
    } finally {
      jest.useRealTimers()
    }
  })

  test('a settle during an in-flight poll still refreshes the final output', () => {
    jest.useFakeTimers()
    try {
      const sent: ClientMessage[] = []
      seedTasks([liveTask()])
      let renderer!: TestRenderer.ReactTestRenderer
      act(() => { renderer = TestRenderer.create(<ChatMessages events={[bashCall]} sessionId="chat-1" sendMessage={m => sent.push(m)} connected />) })
      open(renderer, true)
      expect(sent.length).toBe(1)
      // The task settles while that poll is still in flight: the settle-time
      // fetch is blocked by the in-flight marker and must queue, not drop.
      act(() => { useChatStore.getState().setBackgroundTasks('chat-1', [liveTask({ status: 'completed', live: false, endedAtMs: Date.now(), summary: 'done (exit code 0)' })]) })
      expect(sent.length).toBe(1)
      // The stale running-time reply lands — and flushes the queued refresh.
      act(() => { useChatStore.getState().setTaskOutput({ type: 'chat-task-output', sessionId: 'chat-1', taskId: 'b1', state: 'ok', output: 'building…\n', totalBytes: 20, truncated: false }) })
      expect(sent.length).toBe(2)
      // The final reply renders; nothing further fires.
      act(() => { useChatStore.getState().setTaskOutput({ type: 'chat-task-output', sessionId: 'chat-1', taskId: 'b1', state: 'ok', output: 'fixture-shell-done\n', totalBytes: 40, truncated: false }) })
      const outputPre = renderer.root.findByProps({ 'data-testid': 'chat-task-output' }).findByType('pre')
      expect(outputPre.children.join('')).toContain('fixture-shell-done')
      expect(outputPre.children.join('')).not.toContain('building')
      act(() => { jest.advanceTimersByTime(6_000) })
      expect(sent.length).toBe(2)
      act(() => renderer.unmount())
    } finally {
      jest.useRealTimers()
    }
  })

  test('collapsing cancels a final refresh queued behind an in-flight poll', () => {
    const sent: ClientMessage[] = []
    seedTasks([liveTask()])
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => { renderer = TestRenderer.create(<ChatMessages events={[bashCall]} sessionId="chat-1" sendMessage={m => sent.push(m)} connected />) })
    open(renderer, true)
    act(() => { useChatStore.getState().setBackgroundTasks('chat-1', [liveTask({ status: 'completed', live: false, endedAtMs: Date.now() })]) })
    expect(sent.length).toBe(1)
    open(renderer, false)
    act(() => { useChatStore.getState().setTaskOutput({ type: 'chat-task-output', sessionId: 'chat-1', taskId: 'b1', state: 'ok', output: 'building…', totalBytes: 20, truncated: false }) })
    expect(sent.length).toBe(1)
    open(renderer, true)
    expect(sent.length).toBe(2)
    act(() => renderer.unmount())
  })

  test('polling resumes after a reconnect', () => {
    jest.useFakeTimers()
    try {
      const sent: ClientMessage[] = []
      seedTasks([liveTask()])
      let renderer!: TestRenderer.ReactTestRenderer
      // Mounted while disconnected: expanding sends nothing.
      act(() => { renderer = TestRenderer.create(<ChatMessages events={[bashCall]} sessionId="chat-1" sendMessage={m => sent.push(m)} connected={false} />) })
      open(renderer, true)
      expect(sent).toEqual([])
      // The socket comes back: the reconnect effect fetches once, and the
      // interval's callback must see the new connection state too.
      act(() => { renderer.update(<ChatMessages events={[bashCall]} sessionId="chat-1" sendMessage={m => sent.push(m)} connected />) })
      expect(sent.length).toBe(1)
      act(() => { useChatStore.getState().setTaskOutput({ type: 'chat-task-output', sessionId: 'chat-1', taskId: 'b1', state: 'ok', output: 'ok\n', totalBytes: 3, truncated: false }) })
      act(() => { jest.advanceTimersByTime(2_000) })
      expect(sent.length).toBe(2)
      act(() => renderer.unmount())
    } finally {
      jest.useRealTimers()
    }
  })

  test('Stop sends the stop message once and re-arms after the settle', () => {
    const sent: unknown[] = []
    seedTasks([liveTask()])
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => { renderer = TestRenderer.create(<ChatMessages events={[bashCall]} sessionId="chat-1" sendMessage={m => sent.push(m)} connected />) })
    const button = renderer.root.findByProps({ 'data-testid': 'chat-task-stop' })
    act(() => { button.props.onClick({ stopPropagation: () => {} }) })
    act(() => { button.props.onClick({ stopPropagation: () => {} }) })
    expect(sent).toEqual([{ type: 'chat-task-stop', sessionId: 'chat-1', taskId: 'b1' }])
    act(() => renderer.unmount())
  })
})
