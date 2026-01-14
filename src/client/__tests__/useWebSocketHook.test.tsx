import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import TestRenderer, { act } from 'react-test-renderer'
import type { ServerMessage } from '@shared/types'
import { useSessionStore } from '../stores/sessionStore'

class FakeWebSocket {
  static OPEN = 1
  static CLOSED = 3
  static instances: FakeWebSocket[] = []

  readyState = FakeWebSocket.OPEN
  sent: string[] = []
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  onclose: (() => void) | null = null

  constructor(public url: string) {
    FakeWebSocket.instances.push(this)
  }

  send(data: string) {
    this.sent.push(data)
  }

  close() {
    this.readyState = FakeWebSocket.CLOSED
    this.onclose?.()
  }

  triggerOpen() {
    this.readyState = FakeWebSocket.OPEN
    this.onopen?.()
  }

  triggerMessage(payload: string) {
    this.onmessage?.({ data: payload })
  }

  triggerError() {
    this.onerror?.()
  }
}

const globalAny = globalThis as typeof globalThis & {
  window?: Window & typeof globalThis
  WebSocket?: typeof WebSocket
}

const originalWindow = globalAny.window
const originalWebSocket = globalAny.WebSocket

beforeEach(() => {
  FakeWebSocket.instances = []
  globalAny.window = {
    location: { protocol: 'http:', host: 'localhost:1234' },
    setTimeout: (() =>
      1 as unknown as ReturnType<typeof setTimeout>) as unknown as typeof setTimeout,
    clearTimeout: (() => {}) as typeof clearTimeout,
  } as unknown as Window & typeof globalThis
  globalAny.WebSocket = FakeWebSocket as unknown as typeof WebSocket
  useSessionStore.setState({
    sessions: [],
    agentSessions: { active: [], inactive: [] },
    selectedSessionId: null,
    hasLoaded: false,
    connectionStatus: 'connecting',
    connectionError: null,
  })
})

afterEach(() => {
  globalAny.window = originalWindow
  globalAny.WebSocket = originalWebSocket
})

async function loadHook(tag: string) {
  const module = await import(`../hooks/useWebSocket?${tag}`)
  return module.useWebSocket as typeof import('../hooks/useWebSocket').useWebSocket
}

describe('useWebSocket', () => {
  test('connects and updates store status', async () => {
    const useWebSocket = await loadHook('status')
    let renderer!: TestRenderer.ReactTestRenderer

    let hookResult: any = null
    function Harness() {
      hookResult = useWebSocket()
      return null
    }

    act(() => {
      renderer = TestRenderer.create(<Harness />)
    })

    const ws = FakeWebSocket.instances[0]
    if (!ws) {
      throw new Error('Expected WebSocket instance')
    }

    act(() => {
      ws.triggerOpen()
    })

    expect(useSessionStore.getState().connectionStatus).toBe('connected')
    expect(useSessionStore.getState().connectionError).toBeNull()
    expect(hookResult?.status).toBe('connected')

    act(() => {
      renderer.unmount()
    })
  })

  test('subscribes to messages, sends payloads, and stores errors', async () => {
    const useWebSocket = await loadHook('messages')
    let renderer!: TestRenderer.ReactTestRenderer

    let hookResult: any = null
    function Harness() {
      hookResult = useWebSocket()
      return null
    }

    act(() => {
      renderer = TestRenderer.create(<Harness />)
    })

    const ws = FakeWebSocket.instances[0]
    if (!ws) {
      throw new Error('Expected WebSocket instance')
    }

    const received: ServerMessage[] = []
    const unsubscribe = hookResult?.subscribe((message: ServerMessage) =>
      received.push(message)
    )

    act(() => {
      ws.triggerMessage(JSON.stringify({ type: 'sessions', sessions: [] }))
    })

    expect(received).toHaveLength(1)
    expect(received[0]?.type).toBe('sessions')

    hookResult?.sendMessage({ type: 'session-refresh' })
    expect(ws.sent).toHaveLength(1)
    expect(JSON.parse(ws.sent[0] ?? '')).toEqual({ type: 'session-refresh' })

    act(() => {
      ws.triggerError()
    })

    expect(useSessionStore.getState().connectionStatus).toBe('error')
    expect(useSessionStore.getState().connectionError).toBe('WebSocket error')

    unsubscribe?.()

    act(() => {
      renderer.unmount()
    })
  })
})
