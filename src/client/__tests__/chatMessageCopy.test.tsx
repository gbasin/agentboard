// Message copy control (copy-chat-message-markdown): the copy-source table
// S1–S4 and the feedback table F1–F5, run through the production composition
// (events merged by applyChatEvents, rendered by ChatMessages/ChatView, the
// real button clicked) per oracle hazard M1. Browser globals are stubbed:
// a secure context whose clipboard records writes, or an insecure one whose
// `copy`-event fallback records them (or refuses).
import { afterEach, describe, expect, jest, test } from 'bun:test'
import TestRenderer, { act, type ReactTestInstance } from 'react-test-renderer'
import type { ChatEvent } from '@shared/chat'
import type { WorkspaceMessageContext } from '@shared/planWorkspace'
import type { Session } from '@shared/types'
import ChatMessages from '../components/chat/ChatMessages'
import ChatView from '../components/chat/ChatView'
import { COPY_FEEDBACK_MS } from '../components/chat/MessageCopyButton'
import { useChatStore } from '../stores/chatStore'
import { applyChatEvents, emptyTranscript } from '../stores/chatTranscript'

const SESSION = 'chat-copy-1'
const at = (minute: number) => `2026-10-16T10:${String(minute).padStart(2, '0')}:00.000Z`
const user = (id: string, text: string, extra: Partial<Extract<ChatEvent, { type: 'user_message' }>> = {}): ChatEvent =>
  ({ id, sequence: 0, at: at(0), type: 'user_message', turnId: 't1', text, ...extra })
const delta = (id: string, messageId: string, text: string): ChatEvent =>
  ({ id, sequence: 0, at: at(1), type: 'assistant_delta', turnId: 't1', messageId, delta: text })
const assistant = (id: string, messageId: string, text: string): ChatEvent =>
  ({ id, sequence: 0, at: at(1), type: 'assistant_text', turnId: 't1', messageId, text })
const tool = (id: string): ChatEvent =>
  ({ type: 'tool_call', id, sequence: 0, at: at(1), turnId: 't1', toolCallId: `call_${id}`, tool: 'Read', input: {} })
const peer: ChatEvent = {
  type: 'peer_message', id: 'peer-1', sequence: 0, at: at(2), turnId: 't-peer', messageId: 'pm1',
  senderSession: 'chat-other', senderGroup: 'devs', priority: 'urgent', originPath: '/repo/.worktrees/a',
  tags: ['review'], threadId: 'pm0', body: 'Please **review** `x.ts`\n- one', possibleDuplicate: false,
  thread: [{ messageId: 'pm0', senderSession: 'chat-me', senderKind: 'agent', body: 'earlier body' }],
  task: { id: 'task-1', title: 'Export', status: 'active', revision: 2, direction: 'Do it', acceptance: 'Done', journal: [] },
} as unknown as ChatEvent

const MARKDOWN = '# Heading\n\n- item one\n- item two\n\n```ts\nconst x = 1\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n[docs](https://example.com)\r\n'

/** Merged as the store merges them (chat-transcript-layout D5). */
const merged = (events: ChatEvent[]) => applyChatEvents(emptyTranscript(), events).events

// ---- browser stubs --------------------------------------------------------
const slots = ['window', 'navigator', 'document'] as const
const originals = Object.fromEntries(slots.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
const define = (key: string, value: unknown) => Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
afterEach(() => {
  for (const key of slots) {
    const descriptor = originals[key]
    if (descriptor) Object.defineProperty(globalThis, key, descriptor)
    else delete (globalThis as Record<string, unknown>)[key]
  }
  useChatStore.setState({ sessions: {}, workerBodies: {}, taskOutputs: {}, closedAccountNotices: {} })
  jest.useRealTimers()
})

/** A secure context: the async clipboard records (or refuses) each write. */
function secureClipboard(refuse = false): string[] {
  const writes: string[] = []
  define('window', { isSecureContext: true, confirm: () => true })
  define('navigator', { clipboard: { writeText: (text: string) => {
    if (refuse) return Promise.reject(new Error('NotAllowedError'))
    writes.push(text)
    return Promise.resolve()
  } } })
  define('document', { addEventListener: () => {}, removeEventListener: () => {}, execCommand: () => false })
  return writes
}

/** An insecure context (plain HTTP): only the `copy`-event fallback exists. */
function insecureClipboard(): string[] {
  const writes: string[] = []
  let listener: ((event: ClipboardEvent) => void) | null = null
  define('window', { isSecureContext: false })
  define('navigator', {})
  define('document', {
    addEventListener: (_: string, fn: (event: ClipboardEvent) => void) => { listener = fn },
    removeEventListener: () => { listener = null },
    execCommand: () => {
      listener?.({ clipboardData: { setData: (_: string, value: string) => writes.push(value) }, preventDefault: () => {} } as unknown as ClipboardEvent)
      return listener !== null
    },
  })
  return writes
}

// ---- rendering helpers ----------------------------------------------------
const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve() }
const copyButtons = (root: ReactTestInstance) => root.findAll(node => node.type === 'button' && node.props['data-testid'] === 'chat-message-copy')
const statusOf = (button: ReactTestInstance) => {
  const span = button.findByProps({ 'data-testid': 'chat-message-copy-status' })
  return { role: span.props.role, text: span.children.join(''), state: button.props['data-copy-state'] as string }
}
function render(events: ChatEvent[]) {
  let renderer!: TestRenderer.ReactTestRenderer
  act(() => { renderer = TestRenderer.create(<ChatMessages agentLabel="Claude" events={events} />) })
  return renderer
}
async function click(button: ReactTestInstance) {
  await act(async () => { button.props.onClick(); await flush() })
}
/** Each article's role and the clipboard text its copy control writes. */
async function copiedByRow(events: ChatEvent[]) {
  const writes = secureClipboard()
  const renderer = render(events)
  const rows: Array<{ role: string; copied: string | null }> = []
  for (const article of renderer.root.findAllByType('article')) {
    const [button] = copyButtons(article)
    if (!button) { rows.push({ role: article.props['data-chat-role'], copied: null }); continue }
    const before = writes.length
    await click(button)
    rows.push({ role: article.props['data-chat-role'], copied: writes.length > before ? writes.at(-1)! : null })
  }
  return { renderer, rows }
}

describe('copy source (S1–S4)', () => {
  // Design table "Copy source", verbatim.
  const SOURCE: Array<[id: string, kind: string, controlRendered: boolean, clipboardText: string]> = [
    ['S1', 'user_message', true, 'event.text, with no workspace-context label'],
    ['S2', 'assistant_text (merged entry)', true, "the merged entry's event.text, Markdown source"],
    ['S3', 'peer_message', true, 'event.body only'],
    ['S4', 'any other type', false, '—'],
  ]
  test('the table rows are the design table', () => {
    expect(SOURCE.map(([id, , rendered]) => [id, rendered])).toEqual([['S1', true], ['S2', true], ['S3', true], ['S4', false]])
  })

  // @covers: chat-sessions › Transcript messages can be copied as their original text › User message is copied literally
  test('S1: a user row copies its literal text without the workspace-context line', async () => {
    const text = '  keep  **stars**\n\tand tabs  '
    const workspaceContext: WorkspaceMessageContext = { teamId: 't', planId: 'p1', planTitle: 'Plan One',
      version: { kind: 'revision', revision: 3, contentHash: 'h' }, executionId: null, changeName: 'api', documentRefId: null }
    const { renderer, rows } = await copiedByRow([user('u1', text, { workspaceContext })])
    expect(rows).toEqual([{ role: 'user', copied: text }])
    // The context line is shown in the row, yet not copied.
    expect(renderer.root.findAllByProps({ 'data-testid': 'message-workspace-context' })).toHaveLength(1)
  })

  // @covers: chat-sessions › Transcript messages can be copied as their original text › Assistant Markdown is copied as source
  test('S2: an assistant row copies its Markdown source, not the rendered text', async () => {
    const events = merged([delta('d1', 'm1', MARKDOWN.slice(0, 20)), delta('d2', 'm1', MARKDOWN.slice(20))])
    const { renderer, rows } = await copiedByRow(events)
    expect(rows).toEqual([{ role: 'assistant', copied: MARKDOWN }])
    // The body really is rendered (a heading element), so the source is not the DOM text.
    expect(renderer.root.findAllByType('h1').length).toBe(1)
  })

  // @covers: chat-sessions › Transcript messages can be copied as their original text › Each assistant row copies its own text
  test('S2: text → tool → text in one message copies each row on its own', async () => {
    const events = merged([delta('d1', 'm1', 'First '), delta('d2', 'm1', 'block'), tool('c1'), delta('d3', 'm1', 'Second '), delta('d4', 'm1', 'block')])
    const { rows } = await copiedByRow(events)
    expect(rows).toEqual([{ role: 'assistant', copied: 'First block' }, { role: 'assistant', copied: 'Second block' }])
  })

  // @covers: chat-sessions › Transcript messages can be copied as their original text › Peer message copies its body only
  test('S3: a peer row copies only its body, not tags, origin, task, or thread', async () => {
    const { rows } = await copiedByRow([peer])
    expect(rows).toEqual([{ role: 'peer', copied: 'Please **review** `x.ts`\n- one' }])
  })

  // @covers: chat-sessions › Transcript messages can be copied as their original text › Aside rows have no copy control
  test('S4: tool, result, command output, notice, error, and turn rows have no copy control', () => {
    secureClipboard()
    const asides: ChatEvent[] = [
      tool('c2'),
      { type: 'tool_result', id: 'r2', sequence: 0, at: at(1), turnId: 't1', toolCallId: 'call_c2', output: 'out', isError: false },
      { id: 'cmd', sequence: 0, at: at(1), type: 'command_output', turnId: 't1', text: 'Context: 12k' },
      { id: 'note', sequence: 0, at: at(1), type: 'notice', text: 'Context compacted' },
      { id: 'err', sequence: 0, at: at(1), type: 'error', message: 'Overloaded' },
      { id: 'stop', sequence: 0, at: at(1), type: 'turn_interrupted', turnId: 't1' },
    ] as ChatEvent[]
    const renderer = render(asides)
    expect(copyButtons(renderer.root)).toHaveLength(0)
    // One message row among them gets exactly one control.
    const mixed = render([...asides, user('u9', 'hi')])
    expect(copyButtons(mixed.root)).toHaveLength(1)
  })

  // @covers: chat-sessions › Transcript messages can be copied as their original text › Streaming message
  test('a streaming row copies the text received so far, then the grown text', async () => {
    const writes = secureClipboard()
    let events = merged([delta('d1', 'm1', 'Hello ')])
    const renderer = render(events)
    await click(copyButtons(renderer.root)[0]!)
    events = applyChatEvents(applyChatEvents(emptyTranscript(), events), [delta('d2', 'm1', 'world')]).events
    act(() => renderer.update(<ChatMessages agentLabel="Claude" events={events} />))
    await click(copyButtons(renderer.root)[0]!)
    expect(writes).toEqual(['Hello ', 'Hello world'])
  })
})

describe('copy control in a chat view', () => {
  const session = (archived: boolean) => ({
    id: SESSION, name: 'Copy', projectPath: '/repo', status: 'waiting', kind: 'chat', agentType: 'claude',
    ...(archived ? { archivedAt: '2026-10-01T00:00:00.000Z' } : {}),
  }) as unknown as Session
  const viewCopies = async (archived: boolean) => {
    const writes = secureClipboard()
    act(() => {
      useChatStore.getState().snapshot({
        type: 'chat-snapshot', sessionId: SESSION, profileId: 'default', status: 'waiting', throughSequence: 0,
        events: [user('u1', 'go'), assistant('a1', 'm1', MARKDOWN)], pendingRequests: [],
        commands: { status: 'unavailable', commands: [] }, activity: null,
        contextUsage: null, usage: null, workers: [], notifications: [], model: null, backgroundTasks: [],
      } as never)
    })
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(<ChatView session={session(archived)} sendMessage={() => {}}
        connectionStatus="connected" connectionEpoch={0} error={null} onClose={() => {}} onKill={() => {}} />)
    })
    const transcript = renderer.root.findByProps({ 'data-testid': 'chat-transcript' })
    for (const button of copyButtons(transcript)) await click(button)
    act(() => renderer.unmount())
    return writes
  }

  // @covers: chat-sessions › Transcript messages can be copied as their original text › Archived chat
  test('an archived chat offers the same controls and copies the same text as a live one', async () => {
    const live = await viewCopies(false)
    const archived = await viewCopies(true)
    expect(live).toEqual(['go', MARKDOWN])
    expect(archived).toEqual(live)
  })
})

describe('copy feedback (F1–F5)', () => {
  // @covers: chat-sessions › Message copy control is accessible and unobtrusive › Keyboard user
  test('the control is a named button with a status region', () => {
    secureClipboard()
    const renderer = render([user('u1', 'hi')])
    const [button] = copyButtons(renderer.root)
    expect(button!.props.type).toBe('button')
    expect(button!.props['aria-label']).toBe('Copy message')
    expect(button!.props.tabIndex).toBeUndefined()
    expect(button!.props.className).toContain('chat-row-copy')
    expect(statusOf(button!)).toEqual({ role: 'status', text: '', state: 'idle' })
    // It shares the time's line in the metadata slot, never the body.
    const hostAncestors: ReactTestInstance[] = []
    for (let node = button!.parent; node; node = node.parent) if (typeof node.type === 'string') hostAncestors.push(node)
    expect(hostAncestors[0]!.props.className).toBe('chat-row-stamp')
    expect(hostAncestors[1]!.props['data-testid']).toBe('chat-row-meta')
  })

  // Design table "Feedback timing", verbatim: [id, sequence, expected state].
  const FEEDBACK: Array<[id: string, sequence: string, state: string]> = [
    ['F1', 'success, then +1999 ms', 'copied'],
    ['F2', 'success, then +2000 ms', 'idle'],
    ['F3', 'success, click again at +1500 ms, success, then +1999 ms from the second click', 'copied'],
    ['F4', 'failure, then +2000 ms', 'idle'],
    ['F5', 'success, then unmount before 2000 ms', 'no timer fires and no state update after unmount'],
  ]
  test('the table rows are the design table', () => {
    expect(FEEDBACK.map(([id]) => id)).toEqual(['F1', 'F2', 'F3', 'F4', 'F5'])
    expect(COPY_FEEDBACK_MS).toBe(2000)
  })

  const setup = (fail = false) => {
    jest.useFakeTimers()
    if (fail) secureClipboard(true)
    else secureClipboard()
    const renderer = render([user('u1', 'hi')])
    return { renderer, button: () => copyButtons(renderer.root)[0]! }
  }
  const advance = (ms: number) => act(() => { jest.advanceTimersByTime(ms) })

  // @covers: chat-sessions › Message copy reports its outcome › Successful copy
  test('F1: success shows and announces Copied until 1999 ms', async () => {
    const { button } = setup()
    await click(button())
    expect(statusOf(button())).toEqual({ role: 'status', text: 'Copied', state: 'copied' })
    advance(1999)
    expect(statusOf(button()).state).toBe('copied')
  })

  test('F2: success returns to idle at 2000 ms', async () => {
    const { button } = setup()
    await click(button())
    advance(2000)
    expect(statusOf(button())).toEqual({ role: 'status', text: '', state: 'idle' })
  })

  test('F3: a second click restarts the timer', async () => {
    const { button } = setup()
    await click(button())
    advance(1500)
    await click(button())
    advance(1999)
    expect(statusOf(button()).state).toBe('copied')
    advance(1)
    expect(statusOf(button()).state).toBe('idle')
  })

  // @covers: chat-sessions › Message copy reports its outcome › Clipboard refused
  test('F4: a refused copy shows and announces Copy failed, then returns to idle', async () => {
    const { renderer, button } = setup(true)
    await click(button())
    expect(statusOf(button())).toEqual({ role: 'status', text: 'Copy failed', state: 'failed' })
    advance(2000)
    expect(statusOf(button()).state).toBe('idle')
    // The transcript keeps working.
    expect(renderer.root.findAllByType('article')).toHaveLength(1)
  })

  test('F5: unmounting before the reset leaves no timer and no late update', async () => {
    const { renderer, button } = setup()
    await click(button())
    expect(jest.getTimerCount()).toBe(1)
    const errors: unknown[] = []
    const originalError = console.error
    console.error = (...args: unknown[]) => { errors.push(args) }
    try {
      act(() => renderer.unmount())
      expect(jest.getTimerCount()).toBe(0)
      advance(5000)
    } finally {
      console.error = originalError
    }
    expect(errors).toEqual([])
  })

  // @covers: chat-sessions › Message copy reports its outcome › Insecure context
  test('in an insecure context the copy-event fallback copies the text and shows Copied', async () => {
    const writes = insecureClipboard()
    const renderer = render([assistant('a1', 'm1', MARKDOWN)])
    const [button] = copyButtons(renderer.root)
    await click(button!)
    expect(writes).toEqual([MARKDOWN])
    expect(statusOf(button!).text).toBe('Copied')
  })
})
