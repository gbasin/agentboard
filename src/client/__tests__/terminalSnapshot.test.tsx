import { afterEach, describe, expect, test } from 'bun:test'
import TestRenderer, { act } from 'react-test-renderer'
import type { ClientMessage, ServerMessage } from '@shared/types'
import { KEYBOARD_SETTLE_MS, shouldRejoinWrapped, useOpenSelectText, useTerminalSnapshot } from '../hooks/useTerminalSnapshot'
import TerminalSnapshotLayer from '../components/TerminalSnapshotLayer'

const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
afterEach(() => {
  if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument)
  else delete (globalThis as { document?: unknown }).document
})

function harness(sessionId: string | null, sendResult: boolean | void = true) {
  const sent: ClientMessage[] = []
  let listener: ((message: ServerMessage) => void) | null = null
  let api: ReturnType<typeof useTerminalSnapshot> | null = null
  const sendMessage = (message: ClientMessage) => { sent.push(message); return sendResult }
  const subscribe = (next: (message: ServerMessage) => void) => { listener = next; return () => { listener = null } }
  function Probe({ id }: { id: string | null }) {
    api = useTerminalSnapshot({ sessionId: id, sendMessage, subscribe })
    return null
  }
  let renderer!: TestRenderer.ReactTestRenderer
  act(() => { renderer = TestRenderer.create(<Probe id={sessionId} />) })
  return {
    sent,
    get api() { return api! },
    get listening() { return listener !== null },
    lastRequestId: () => (sent.at(-1) as { requestId: number }).requestId,
    reply: (requestId: number, extra: Partial<Extract<ServerMessage, { type: 'terminal-snapshot' }>> = {}) =>
      act(() => listener?.({ type: 'terminal-snapshot', sessionId: 's1', requestId, ok: true, text: 'hi', ...extra })),
    rerender: (id: string | null) => act(() => renderer.update(<Probe id={id} />)),
  }
}

describe('useTerminalSnapshot', () => {
  test('open requests a snapshot and only the matching reply makes it ready', () => {
    const h = harness('s1')
    expect(h.listening).toBe(false)
    act(() => h.api.open())
    expect(h.api.state.status).toBe('loading')
    expect(h.listening).toBe(true)
    expect(h.sent[0]).toMatchObject({ type: 'terminal-snapshot-request', sessionId: 's1' })
    h.reply(h.lastRequestId() - 1, { text: 'stale' })
    expect(h.api.state.status).toBe('loading')
    h.reply(h.lastRequestId(), { scrollPosition: 2, captureMs: 5 })
    expect(h.api.state).toEqual({ status: 'ready', text: 'hi', scrollPosition: 2, historyLines: 0, captureMs: 5, altScreen: false, refreshing: false })
    expect(h.listening).toBe(false)
    act(() => h.api.close())
    expect(h.api.state.status).toBe('closed')
  })

  test('refresh keeps the old text on screen until the new capture arrives', () => {
    const h = harness('s1')
    act(() => h.api.open())
    h.reply(h.lastRequestId(), { text: 'old' })
    act(() => h.api.refresh())
    expect(h.sent).toHaveLength(2)
    expect(h.api.state).toMatchObject({ status: 'ready', text: 'old', refreshing: true })
    h.reply(h.lastRequestId(), { text: 'new', scrollPosition: 3 })
    expect(h.api.state).toMatchObject({ status: 'ready', text: 'new', scrollPosition: 3, refreshing: false })
  })

  test('refresh from an error state shows progress again', () => {
    const h = harness('s1')
    act(() => h.api.open())
    h.reply(h.lastRequestId(), { ok: false, text: undefined })
    expect(h.api.state.status).toBe('error')
    act(() => h.api.refresh())
    expect(h.api.state.status).toBe('loading')
  })

  test('a delayed open shows progress at once and sends after the delay', async () => {
    const h = harness('s1')
    act(() => h.api.open(20))
    expect(h.api.state.status).toBe('loading')
    expect(h.sent).toHaveLength(0)
    await act(() => new Promise((resolve) => setTimeout(resolve, 40)))
    expect(h.sent).toHaveLength(1)
  })

  test('closing before a delayed open fires cancels the request', async () => {
    const h = harness('s1')
    act(() => h.api.open(20))
    act(() => h.api.close())
    await act(() => new Promise((resolve) => setTimeout(resolve, 40)))
    expect(h.sent).toHaveLength(0)
  })

  test('an unsent request shows an error', () => {
    const offline = harness('s1', false)
    act(() => offline.api.open())
    expect(offline.api.state.status).toBe('error')
  })

  test('switching sessions closes the snapshot and ignores the old reply', () => {
    const h = harness('s1')
    act(() => h.api.open())
    const requestId = h.lastRequestId()
    h.rerender('s2')
    expect(h.api.state.status).toBe('closed')
    h.reply(requestId, { text: 'old' })
    expect(h.api.state.status).toBe('closed')
  })

  test('open without a session does nothing', () => {
    const h = harness(null)
    act(() => h.api.open())
    expect(h.sent).toHaveLength(0)
  })
})

describe('useOpenSelectText', () => {
  function openerHarness() {
    const calls: number[] = []
    let cleared = 0
    let openSelect: (() => void) | null = null
    function Probe() {
      openSelect = useOpenSelectText((delay = 0) => { calls.push(delay) }, { current: () => { cleared += 1 } })
      return null
    }
    act(() => { TestRenderer.create(<Probe />) })
    return { calls, get cleared() { return cleared }, open: () => openSelect!() }
  }

  test('opens at once when the keyboard is down, after it settles when it was up', () => {
    let blurred = 0
    const textarea = { classList: { contains: (name: string) => name === 'xterm-helper-textarea' }, blur: () => { blurred += 1 } }
    Object.defineProperty(globalThis, 'document', { configurable: true, value: { activeElement: textarea } })
    const up = openerHarness()
    up.open()
    expect(up.calls).toEqual([KEYBOARD_SETTLE_MS])
    expect(blurred).toBe(1)
    expect(up.cleared).toBe(1)

    Object.defineProperty(globalThis, 'document', { configurable: true, value: { activeElement: null } })
    const down = openerHarness()
    down.open()
    expect(down.calls).toEqual([0])
  })
})

describe('TerminalSnapshotLayer', () => {
  const refs = { containerRef: { current: null }, terminalRef: { current: null } }

  function render(state: Parameters<typeof TerminalSnapshotLayer>[0]['state']) {
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(<TerminalSnapshotLayer state={state} {...refs} background="#000" foreground="#fff"
        rejoinWrapped onCopied={() => {}} />)
    })
    return renderer
  }

  test('shows progress and errors, and puts no controls over the text', () => {
    const loading = render({ status: 'loading' })
    expect(JSON.stringify(loading.toJSON())).toContain('Capturing text')
    expect(loading.root.findAllByType('button')).toHaveLength(0)
    const failed = render({ status: 'error' })
    expect(JSON.stringify(failed.toJSON())).toContain('Could not capture')
    const ready = render({ status: 'ready', text: 'a', scrollPosition: 0, historyLines: 0, captureMs: 1, altScreen: true, refreshing: false })
    expect(ready.root.findAllByType('button')).toHaveLength(0)
  })

  test('xterm takes no typed or pasted input while the layer is open', () => {
    const terminal = { options: { disableStdin: false } as { disableStdin?: boolean } }
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(<TerminalSnapshotLayer state={{ status: 'loading' }} containerRef={{ current: null }}
        terminalRef={{ current: terminal as never }} background="#000" foreground="#fff" rejoinWrapped={false} onCopied={() => {}} />)
    })
    expect(terminal.options.disableStdin).toBe(true)
    act(() => renderer.unmount())
    expect(terminal.options.disableStdin).toBe(false)
  })
})

describe('shouldRejoinWrapped', () => {
  const ready = (altScreen: boolean) => ({ status: 'ready' as const, text: '', scrollPosition: 0, historyLines: 0, captureMs: 0, altScreen, refreshing: false })

  test('rejoins on the alternate screen or for a known agent, never in a plain shell', () => {
    expect(shouldRejoinWrapped(ready(true), undefined)).toBe(true)
    expect(shouldRejoinWrapped(ready(false), 'claude')).toBe(true)
    expect(shouldRejoinWrapped(ready(false), undefined)).toBe(false)
    expect(shouldRejoinWrapped({ status: 'loading' }, null)).toBe(false)
  })
})
