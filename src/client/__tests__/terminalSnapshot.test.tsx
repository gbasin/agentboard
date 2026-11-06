import { describe, expect, test } from 'bun:test'
import TestRenderer, { act } from 'react-test-renderer'
import type { ClientMessage, ServerMessage } from '@shared/types'
import { cleanSnapshotText, displaySnapshotText } from '../utils/snapshotText'
import { useTerminalSnapshot } from '../hooks/useTerminalSnapshot'
import TerminalSnapshotLayer from '../components/TerminalSnapshotLayer'

describe('snapshotText', () => {
  test('display text strips trailing whitespace but keeps every line', () => {
    expect(displaySnapshotText('a  \n\t\n b  \n')).toBe('a\n\n b\n')
  })

  test('clean text also drops trailing blank lines', () => {
    expect(cleanSnapshotText('  keep indent  \n\nnext\n   \n\n')).toBe('  keep indent\n\nnext')
    expect(cleanSnapshotText('\n \n')).toBe('')
  })
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
    emit: (message: ServerMessage) => act(() => listener?.(message)),
    rerender: (id: string | null) => act(() => renderer.update(<Probe id={id} />)),
  }
}

describe('useTerminalSnapshot', () => {
  test('open requests a snapshot and a matching reply makes it ready', () => {
    const h = harness('s1')
    act(() => h.api.open())
    expect(h.api.state.status).toBe('loading')
    const request = h.sent[0]
    expect(request).toMatchObject({ type: 'terminal-snapshot-request', sessionId: 's1' })
    const requestId = (request as { requestId: number }).requestId
    h.emit({ type: 'terminal-snapshot', sessionId: 's1', requestId: requestId - 1, ok: true, text: 'stale' })
    expect(h.api.state.status).toBe('loading')
    h.emit({ type: 'terminal-snapshot', sessionId: 's1', requestId, ok: true, text: 'hi', scrollPosition: 2, captureMs: 5 })
    expect(h.api.state).toEqual({ status: 'ready', text: 'hi', scrollPosition: 2, historyLines: 0, captureMs: 5 })
    act(() => h.api.close())
    expect(h.api.state.status).toBe('closed')
  })

  test('a failed reply or unsent request shows an error', () => {
    const h = harness('s1')
    act(() => h.api.open())
    const requestId = (h.sent[0] as { requestId: number }).requestId
    h.emit({ type: 'terminal-snapshot', sessionId: 's1', requestId, ok: false })
    expect(h.api.state.status).toBe('error')
    const offline = harness('s1', false)
    act(() => offline.api.open())
    expect(offline.api.state.status).toBe('error')
  })

  test('switching sessions closes the snapshot and ignores the old reply', () => {
    const h = harness('s1')
    act(() => h.api.open())
    const requestId = (h.sent[0] as { requestId: number }).requestId
    h.rerender('s2')
    expect(h.api.state.status).toBe('closed')
    h.emit({ type: 'terminal-snapshot', sessionId: 's1', requestId, ok: true, text: 'old' })
    expect(h.api.state.status).toBe('closed')
  })

  test('open without a session does nothing', () => {
    const h = harness(null)
    act(() => h.api.open())
    expect(h.sent).toHaveLength(0)
  })
})

describe('TerminalSnapshotLayer', () => {
  const refs = { containerRef: { current: null }, terminalRef: { current: null } }

  test('shows progress, then an error, and Done closes it', () => {
    let closed = 0
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(<TerminalSnapshotLayer state={{ status: 'loading' }} {...refs}
        background="#000" foreground="#fff" onClose={() => { closed += 1 }} />)
    })
    expect(JSON.stringify(renderer.toJSON())).toContain('Capturing text')
    act(() => renderer.update(<TerminalSnapshotLayer state={{ status: 'error' }} {...refs}
      background="#000" foreground="#fff" onClose={() => { closed += 1 }} />))
    expect(JSON.stringify(renderer.toJSON())).toContain('Could not capture')
    const done = renderer.root.findAllByType('button').find((b) => b.props['aria-label'] === 'Done selecting text')
    act(() => done?.props.onClick())
    expect(closed).toBe(1)
  })
})
