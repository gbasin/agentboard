import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import TestRenderer, { act } from 'react-test-renderer'
import type { AgentSession } from '@shared/types'

const globalAny = globalThis as typeof globalThis & {
  fetch?: typeof fetch
  window?: Window & typeof globalThis
}

const originalFetch = globalAny.fetch
const originalWindow = globalAny.window
let SessionPreviewModal: typeof import('../components/SessionPreviewModal').default

let keyHandlers = new Map<string, EventListener>()

function setupWindow() {
  keyHandlers = new Map()
  globalAny.window = {
    addEventListener: (event: string, handler: EventListener) => {
      keyHandlers.set(event, handler)
    },
    removeEventListener: (event: string) => {
      keyHandlers.delete(event)
    },
  } as unknown as Window & typeof globalThis
}

function createJsonResponse(payload: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(payload), {
    status: init?.status ?? 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

function flushPromises() {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

function renderedText(value: unknown): string {
  if (value === null || value === undefined || typeof value === 'boolean') return ''
  if (typeof value === 'string' || typeof value === 'number') return String(value)
  if (Array.isArray(value)) return value.map(renderedText).join('')
  if (typeof value === 'object' && 'props' in value) {
    const props = (value as { props?: { children?: unknown }, children?: unknown }).props
    const children = (value as { children?: unknown }).children
    return renderedText(props?.children) || renderedText(children)
  }
  return ''
}

async function flushUpdates() {
  await flushPromises()
  await flushPromises()
}

async function createModal(element: JSX.Element) {
  let renderer!: TestRenderer.ReactTestRenderer
  await act(async () => {
    renderer = TestRenderer.create(element)
    await flushUpdates()
  })
  return renderer
}

async function resolveAndFlush(controller: { resolveNext: () => void }) {
  await act(async () => {
    controller.resolveNext()
    await flushUpdates()
  })
}

function clickButton(renderer: TestRenderer.ReactTestRenderer, label: string) {
  const button = renderer.root
    .findAllByType('button')
    .find((candidate) => renderedText(candidate.props.children).includes(label))

  if (!button) {
    throw new Error(`Expected ${label} button`)
  }

  act(() => {
    button.props.onClick()
  })
}

async function cleanup(renderer: TestRenderer.ReactTestRenderer) {
  await act(async () => {
    renderer.unmount()
    await flushUpdates()
  })
}

function createFetchController(responses: Response[], calls: string[] = []) {
  const pending: Array<(value: Response) => void> = []
  const fetchImpl = (input: RequestInfo | URL, init?: RequestInit) => {
    let url: string
    if (typeof input === 'string') {
      url = input
    } else if (input instanceof URL) {
      url = input.toString()
    } else {
      url = input.url
    }
    if (url.startsWith('/api/session-preview/')) {
      calls.push(url)
      return new Promise<Response>((resolve) => {
        pending.push(resolve)
      })
    }
    if (typeof originalFetch === 'function') {
      return originalFetch(input as RequestInfo, init as RequestInit)
    }
    return Promise.reject(new Error('fetch is not available'))
  }
  globalAny.fetch = fetchImpl as unknown as typeof fetch

  const resolveNext = () => {
    const resolve = pending.shift()
    const response = responses.shift()
    if (!resolve || !response) {
      throw new Error('Unexpected fetch resolution')
    }
    resolve(response)
  }

  return { calls, resolveNext }
}

const baseSession: AgentSession = {
  sessionId: 'session-12345678',
  logFilePath: '/tmp/session.jsonl',
  projectPath: '/projects/alpha',
  agentType: 'claude',
  displayName: '',
  createdAt: '2024-01-01T00:00:00.000Z',
  lastActivityAt: new Date(Date.now() - 120000).toISOString(),
  isActive: false,
}

beforeEach(async () => {
  setupWindow()
  if (!SessionPreviewModal) {
    SessionPreviewModal = (await import('../components/SessionPreviewModal')).default
  }
})

afterEach(() => {
  globalAny.fetch = originalFetch
  globalAny.window = originalWindow
  keyHandlers.clear()
})

describe('SessionPreviewModal', () => {
  test('loads preview, shows parsed entries, pages earlier history, toggles events, and resumes', async () => {
    const longToolResult = `Done ${'tool-output '.repeat(30)}`
    const previewData = {
      sessionId: baseSession.sessionId,
      displayName: 'Alpha',
      projectPath: baseSession.projectPath,
      agentType: 'claude',
      lastActivityAt: baseSession.lastActivityAt,
      totalLines: 13,
      startLine: 2,
      endLine: 13,
      hasMoreBefore: true,
      lines: [
        JSON.stringify({
          type: 'user',
          timestamp: '2026-06-15T14:01:00.000Z',
          message: { content: 'Hello' },
        }),
        JSON.stringify({
          type: 'assistant',
          timestamp: '2026-06-15T14:02:00.000Z',
          message: { content: [{ type: 'text', text: 'World' }] },
        }),
        JSON.stringify({
          type: 'response_item',
          timestamp: '2026-06-15T14:03:00.000Z',
          payload: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'From response item' }],
          },
        }),
        JSON.stringify({
          type: 'event_msg',
          payload: {
            type: 'user_message',
            timestamp: '2026-06-15T14:04:00.000Z',
            message: 'From event msg',
          },
        }),
        JSON.stringify({
          type: 'event_msg',
          payload: {
            type: 'user_message',
            timestamp: '2026-06-15T14:05:00.000Z',
            message: {
              role: 'user',
              content: [{ type: 'input_text', text: 'From structured event msg' }],
            },
          },
        }),
        JSON.stringify({
          type: 'assistant',
          message: {
            content: [
              { type: 'thinking', thinking: 'Hidden thinking block' },
              { type: 'text', text: 'Visible assistant text' },
            ],
          },
        }),
        JSON.stringify({
          type: 'event_msg',
          payload: { type: 'assistant_message', message: 'Assistant from event msg' },
        }),
        JSON.stringify({ type: 'tool_use', name: 'search' }),
        JSON.stringify({ type: 'result', result: longToolResult }),
        JSON.stringify({ type: 'assistant', message: { content: 'x'.repeat(650) } }),
        'plain text line',
      ],
    }
    const middleData = {
      ...previewData,
      totalLines: 13,
      startLine: 1,
      endLine: 2,
      hasMoreBefore: true,
      lines: [
        JSON.stringify({
          type: 'assistant',
          timestamp: '2026-06-15T14:00:30.000Z',
          message: { content: 'Middle message' },
        }),
      ],
    }
    const earliestData = {
      ...previewData,
      totalLines: 13,
      startLine: 0,
      endLine: 1,
      hasMoreBefore: false,
      lines: [
        JSON.stringify({
          type: 'user',
          timestamp: '2026-06-15T14:00:00.000Z',
          message: { content: 'Earlier message' },
        }),
      ],
    }

    const controller = createFetchController([
      createJsonResponse(previewData),
      createJsonResponse(middleData),
      createJsonResponse(earliestData),
    ])
    let resumed: string[] = []

    const renderer = await createModal(
      <SessionPreviewModal
        session={baseSession}
        onClose={() => {}}
        onResume={(sessionId) => {
          resumed.push(sessionId)
        }}
      />
    )

    let html = JSON.stringify(renderer.toJSON())
    expect(html).toContain('Loading preview...')

    await resolveAndFlush(controller)

    html = JSON.stringify(renderer.toJSON())
    expect(html).toContain('Hello')
    expect(html).toContain('World')
    expect(html).toContain('From response item')
    expect(html).toContain('From event msg')
    expect(html).toContain('From structured event msg')
    expect(html).toContain('Assistant from event msg')
    expect(html).toContain('[Tool: search]')
    expect(html).toContain('Result')
    expect(html).not.toContain('Done')
    expect(html).toContain('x'.repeat(650))
    expect(html).toContain('plain text line')
    expect(html).toContain('Showing 11 of 13 log entries')
    expect(html).toContain('2026-06-15T14:01:00.000Z')
    expect(renderedText(renderer.toJSON())).not.toContain('Line 3Hello')

    clickButton(renderer, 'Result')

    html = JSON.stringify(renderer.toJSON())
    expect(html).toContain('Done')
    expect(html).toContain('tool-output')

    clickButton(renderer, 'Load earlier')
    await resolveAndFlush(controller)

    html = JSON.stringify(renderer.toJSON())
    expect(html).toContain('Middle message')
    expect(html).toContain('Showing 12 of 13 log entries')
    expect(controller.calls[1]).toBe('/api/session-preview/session-12345678?limit=200&beforeLine=2')

    clickButton(renderer, 'Load earlier')
    await resolveAndFlush(controller)

    html = JSON.stringify(renderer.toJSON())
    expect(html).toContain('Earlier message')
    expect(html).toContain('Showing 13 of 13 log entries')
    expect(controller.calls[2]).toBe('/api/session-preview/session-12345678?limit=200&beforeLine=1')

    // Reverse-chronological: newest at top, oldest at the bottom.
    expect(html.indexOf('Hello')).toBeLessThan(html.indexOf('Middle message'))
    expect(html.indexOf('Middle message')).toBeLessThan(html.indexOf('Earlier message'))

    clickButton(renderer, 'Events')

    html = JSON.stringify(renderer.toJSON())
    expect(html).toContain('claude')
    expect(html).toContain('codex')
    expect(html).toContain('event_msg')
    expect(html).toContain('From structured event msg')
    expect(html).toContain('Visible assistant text')
    expect(html).not.toContain('Hidden thinking block')
    expect(html).toContain('Plain text')
    expect(html).toContain('payload')
    expect(html).toContain('Output')
    expect(html).not.toContain('tool-output')
    expect(html).toContain('Messages')

    clickButton(renderer, 'Output')

    html = JSON.stringify(renderer.toJSON())
    expect(html).toContain('tool-output')

    clickButton(renderer, 'Wake')

    expect(resumed).toEqual([baseSession.sessionId])

    const handler = keyHandlers.get('keydown')
    if (!handler) {
      throw new Error('Expected keydown handler')
    }

    const enterEvent = { key: 'Enter', preventDefault: () => {} } as KeyboardEvent
    act(() => {
      handler(enterEvent)
    })

    expect(resumed).toEqual([baseSession.sessionId, baseSession.sessionId])

    await cleanup(renderer)
  })

  test('pages large transcript previews with byte cursors', async () => {
    const previewData = {
      sessionId: baseSession.sessionId,
      displayName: 'Alpha',
      projectPath: baseSession.projectPath,
      agentType: 'codex',
      lastActivityAt: baseSession.lastActivityAt,
      totalLines: null,
      startLine: 0,
      endLine: 2,
      startByte: 1200,
      endByte: 1400,
      hasMoreBefore: true,
      lineKeys: ['b:1200', 'b:1300'],
      lines: [
        JSON.stringify({ type: 'user', message: { content: 'Recent one' } }),
        JSON.stringify({ type: 'assistant', message: { content: 'Recent two' } }),
      ],
    }
    const earlierData = {
      ...previewData,
      startByte: 1000,
      endByte: 1200,
      hasMoreBefore: false,
      lineKeys: ['b:1000', 'b:1100'],
      lines: [
        JSON.stringify({ type: 'user', message: { content: 'Earlier one' } }),
        JSON.stringify({ type: 'assistant', message: { content: 'Earlier two' } }),
      ],
    }

    const controller = createFetchController([
      createJsonResponse(previewData),
      createJsonResponse(earlierData),
    ])

    const renderer = await createModal(
      <SessionPreviewModal
        session={baseSession}
        onClose={() => {}}
        onResume={() => {}}
      />
    )

    await resolveAndFlush(controller)

    let html = JSON.stringify(renderer.toJSON())
    expect(html).toContain('Recent one')
    expect(html).toContain('Recent two')
    expect(html).toContain('Showing 2 recent log entries')
    expect(html).not.toContain('Line 1')

    clickButton(renderer, 'Load earlier')
    await resolveAndFlush(controller)

    html = JSON.stringify(renderer.toJSON())
    expect(html).toContain('Earlier one')
    expect(html).toContain('Recent two')
    expect(html).toContain('Showing 4 recent log entries')
    expect(controller.calls[1]).toBe('/api/session-preview/session-12345678?limit=200&beforeByte=1200')

    await cleanup(renderer)
  })

  test('renders message content as markdown', async () => {
    const controller = createFetchController([
      createJsonResponse({
        sessionId: baseSession.sessionId,
        displayName: 'Alpha',
        projectPath: baseSession.projectPath,
        agentType: 'claude',
        lastActivityAt: baseSession.lastActivityAt,
        totalLines: 1,
        startLine: 0,
        endLine: 1,
        hasMoreBefore: false,
        lines: [
          JSON.stringify({
            type: 'assistant',
            message: {
              content: '## Heading\n\nSome **bold** text and `inline code`.\n\n- one\n- two',
            },
          }),
        ],
      }),
    ])

    const renderer = await createModal(
      <SessionPreviewModal
        session={baseSession}
        onClose={() => {}}
        onResume={() => {}}
      />
    )

    await resolveAndFlush(controller)

    const html = JSON.stringify(renderer.toJSON())
    // Markdown syntax is parsed into elements rather than shown literally.
    expect(html).not.toContain('**bold**')
    expect(html).toContain('bold')
    expect(html).toContain('Heading')
    expect(html).toContain('"type":"strong"')
    expect(html).toContain('"type":"ul"')
    expect(html).toContain('"type":"code"')

    await cleanup(renderer)
  })

  test('shows a stable label for empty transcripts', async () => {
    const controller = createFetchController([
      createJsonResponse({
        sessionId: baseSession.sessionId,
        displayName: 'Alpha',
        projectPath: baseSession.projectPath,
        agentType: 'claude',
        lastActivityAt: baseSession.lastActivityAt,
        totalLines: 0,
        startLine: 0,
        endLine: 0,
        hasMoreBefore: false,
        lines: [],
      }),
    ])

    const renderer = await createModal(
      <SessionPreviewModal
        session={baseSession}
        onClose={() => {}}
        onResume={() => {}}
      />
    )

    await resolveAndFlush(controller)

    const html = JSON.stringify(renderer.toJSON())
    expect(html).toContain('No transcript entries')
    expect(html).not.toContain('Showing 0 of 0 log entries')

    await cleanup(renderer)
  })

  test('handles errors, closes on escape and backdrop, and keeps wake enabled', async () => {
    const controller = createFetchController([
      createJsonResponse({ error: 'No preview available' }, { status: 500 }),
    ])

    let closed = 0
    let resumed = 0

    const renderer = await createModal(
      <SessionPreviewModal
        session={baseSession}
        onClose={() => {
          closed += 1
        }}
        onResume={() => {
          resumed += 1
        }}
      />
    )

    await resolveAndFlush(controller)

    const html = JSON.stringify(renderer.toJSON())
    expect(html).toContain('No preview available')

    const resumeButton = renderer.root
      .findAllByType('button')
      .find((button) => button.props.children === 'Wake')

    if (!resumeButton) {
      throw new Error('Expected resume button')
    }

    // Preview failure must NOT block wake — the log file may be missing or
    // rotated, but the session itself can still be resumed.
    expect(resumeButton.props.disabled).toBe(false)

    const handler = keyHandlers.get('keydown')
    if (!handler) {
      throw new Error('Expected keydown handler')
    }

    const enterEvent = { key: 'Enter', preventDefault: () => {} } as KeyboardEvent
    act(() => {
      handler(enterEvent)
    })

    expect(resumed).toBe(1)

    let stopped = 0
    const escapeEvent = {
      key: 'Escape',
      stopPropagation: () => {
        stopped += 1
      },
    } as KeyboardEvent

    act(() => {
      handler(escapeEvent)
    })

    expect(closed).toBe(1)
    expect(stopped).toBe(1)

    const overlay = renderer.root.findByProps({ role: 'dialog' })
    act(() => {
      overlay.props.onClick({ target: overlay, currentTarget: overlay })
    })

    expect(closed).toBe(2)

    await cleanup(renderer)
  })
})
