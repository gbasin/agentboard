import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { ServerMessage } from '@shared/types'
import { WebSocketManager } from '../hooks/useWebSocket'

class FakeWebSocket {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSING = 2
  static CLOSED = 3
  static instances: FakeWebSocket[] = []

  readyState = FakeWebSocket.CONNECTING
  sent: string[] = []
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  onclose: ((event: CloseEvent) => void) | null = null

  constructor(public url: string) {
    FakeWebSocket.instances.push(this)
  }

  send(data: string) {
    this.sent.push(data)
  }

  close() {
    this.readyState = FakeWebSocket.CLOSED
    this.onclose?.({ code: 1000, reason: '', wasClean: true } as CloseEvent)
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

type TimerEntry = { id: number; callback: () => void; delay: number }
type IntervalEntry = { id: number; callback: () => void; interval: number }

const globalAny = globalThis as typeof globalThis & {
  window?: unknown
  WebSocket?: unknown
  document?: unknown
}
const originalWindow = globalAny.window
const originalWebSocket = globalAny.WebSocket
const originalDocument = globalAny.document

let timers: TimerEntry[] = []
let intervals: IntervalEntry[] = []
let nextTimerId = 1
let visibilityListeners: Array<() => void> = []
let pageshowListeners: Array<(e: { persisted: boolean }) => void> = []
let mockVisibilityState = 'visible'

function makeWindowMock() {
  return {
    location: { protocol: 'http:', host: 'localhost:1234' },
    setTimeout: (callback: () => void, delay: number) => {
      const id = nextTimerId++
      timers.push({ id, callback, delay })
      return id
    },
    clearTimeout: (id: number) => {
      timers = timers.filter((timer) => timer.id !== id)
    },
    setInterval: (callback: () => void, interval: number) => {
      const id = nextTimerId++
      intervals.push({ id, callback, interval })
      return id
    },
    clearInterval: (id: number) => {
      intervals = intervals.filter((entry) => entry.id !== id)
    },
    addEventListener: (event: string, handler: (...args: unknown[]) => void) => {
      if (event === 'pageshow') pageshowListeners.push(handler as (e: { persisted: boolean }) => void)
    },
    removeEventListener: (event: string, handler: (...args: unknown[]) => void) => {
      if (event === 'pageshow') pageshowListeners = pageshowListeners.filter((h) => h !== handler)
    },
  } as typeof window
}

function makeDocumentMock() {
  return {
    get visibilityState() {
      return mockVisibilityState
    },
    addEventListener: (event: string, handler: () => void) => {
      if (event === 'visibilitychange') visibilityListeners.push(handler)
    },
    removeEventListener: (event: string, handler: () => void) => {
      if (event === 'visibilitychange')
        visibilityListeners = visibilityListeners.filter((h) => h !== handler)
    },
  }
}

function fireVisibilityChange(state: string) {
  mockVisibilityState = state
  for (const listener of visibilityListeners) listener()
}

function firePageShow(persisted: boolean) {
  for (const listener of pageshowListeners)
    listener({ persisted })
}

function fireAllIntervals() {
  for (const entry of intervals) entry.callback()
}

beforeEach(() => {
  timers = []
  intervals = []
  nextTimerId = 1
  visibilityListeners = []
  pageshowListeners = []
  mockVisibilityState = 'visible'
  FakeWebSocket.instances = []

  globalAny.window = makeWindowMock()
  globalAny.document = makeDocumentMock() as unknown as Document
  globalAny.WebSocket = FakeWebSocket as unknown as typeof WebSocket
})

afterEach(() => {
  globalAny.window = originalWindow
  globalAny.WebSocket = originalWebSocket
  globalAny.document = originalDocument
})

describe('WebSocketManager', () => {
  test('connects and emits status updates', () => {
    const manager = new WebSocketManager()
    const statuses: string[] = []
    manager.subscribeStatus((status) => {
      statuses.push(status)
    })

    manager.connect()
    const ws = FakeWebSocket.instances[0]
    ws?.triggerOpen()

    expect(statuses[0]).toBe('connecting')
    expect(statuses[statuses.length - 1]).toBe('connected')
  })

  test('delivers messages and ignores malformed payloads', () => {
    const manager = new WebSocketManager()
    const messages: ServerMessage[] = []
    manager.subscribe((message) => messages.push(message))

    manager.connect()
    const ws = FakeWebSocket.instances[0]
    ws?.triggerMessage(JSON.stringify({ type: 'sessions', sessions: [] }))
    ws?.triggerMessage('{bad-json}')

    expect(messages).toHaveLength(1)
    expect(messages[0]?.type).toBe('sessions')
  })

  test('schedules reconnect on close and reconnects', () => {
    const manager = new WebSocketManager()
    const statuses: string[] = []
    manager.subscribeStatus((status) => statuses.push(status))

    manager.connect()
    const ws = FakeWebSocket.instances[0]
    ws?.triggerOpen()
    ws?.close()

    expect(statuses[statuses.length - 1]).toBe('reconnecting')
    // Reconnect timer + connect timeout timer
    const reconnectTimer = timers.find((t) => t.delay === 1000)
    expect(reconnectTimer).toBeDefined()

    reconnectTimer?.callback()
    expect(FakeWebSocket.instances).toHaveLength(2)
  })

  test('disconnect stops reconnect and marks disconnected', () => {
    const manager = new WebSocketManager()
    const statuses: string[] = []
    manager.subscribeStatus((status) => statuses.push(status))

    manager.connect()
    const ws = FakeWebSocket.instances[0]
    ws?.triggerOpen()

    manager.disconnect()
    expect(statuses[statuses.length - 1]).toBe('disconnected')
  })

  test('send writes to open sockets only', () => {
    const manager = new WebSocketManager()
    manager.connect()
    const ws = FakeWebSocket.instances[0]
    ws?.triggerOpen()

    manager.send({ type: 'session-refresh' })
    expect(ws?.sent).toHaveLength(1)

    if (ws) {
      ws.readyState = FakeWebSocket.CLOSED
    }
    manager.send({ type: 'session-refresh' })
    expect(ws?.sent).toHaveLength(1)
  })

  test('error events clear connect timer but let onclose handle reconnect', () => {
    const manager = new WebSocketManager()
    const statuses: Array<{ status: string; error: string | null }> = []
    manager.subscribeStatus((status, error) => {
      statuses.push({ status, error })
    })

    manager.connect()
    const ws = FakeWebSocket.instances[0]!

    // Find the connect timeout timer
    const timeoutTimer = timers.find((t) => t.delay === 10000)
    expect(timeoutTimer).toBeDefined()
    const timeoutId = timeoutTimer!.id

    // Fire onerror — should only clear the connect timer, not reconnect
    ws.triggerError()
    expect(timers.find((t) => t.id === timeoutId)).toBeUndefined()

    // onclose fires after onerror (per WHATWG spec) — this triggers reconnect
    ws.close()
    expect(statuses[statuses.length - 1]?.status).toBe('reconnecting')
    const reconnectTimer = timers.find((t) => t.delay === 1000)
    expect(reconnectTimer).toBeDefined()
    reconnectTimer?.callback()
    expect(FakeWebSocket.instances).toHaveLength(2)
  })

  test('onerror followed by onclose produces exactly one reconnect (no double-fire)', () => {
    const manager = new WebSocketManager()
    let reconnectCount = 0
    manager.subscribeStatus((status) => {
      if (status === 'reconnecting') reconnectCount++
    })

    manager.connect()
    const ws = FakeWebSocket.instances[0]!

    // Simulate the spec-guaranteed onerror → onclose sequence
    ws.triggerError()
    ws.close()

    // Should only have one reconnecting transition, not two
    expect(reconnectCount).toBe(1)
    // Should only schedule one reconnect timer
    const reconnectTimers = timers.filter((t) => t.delay >= 1000 && t.delay <= 30000)
    expect(reconnectTimers).toHaveLength(1)
  })
})

describe('connect timeout', () => {
  test('destroys socket and schedules reconnect if OPEN never reached', () => {
    const manager = new WebSocketManager()
    const statuses: string[] = []
    manager.subscribeStatus((status) => statuses.push(status))

    manager.connect()
    expect(FakeWebSocket.instances).toHaveLength(1)
    const ws = FakeWebSocket.instances[0]!

    // Socket stays in CONNECTING — find and fire the 10s timeout
    const timeoutTimer = timers.find((t) => t.delay === 10000)
    expect(timeoutTimer).toBeDefined()
    timeoutTimer!.callback()

    // Should have destroyed the socket (handlers nulled)
    expect(ws.onopen).toBeNull()
    expect(ws.onclose).toBeNull()

    // Status should be reconnecting
    expect(statuses[statuses.length - 1]).toBe('reconnecting')

    // Firing the reconnect timer creates a new socket
    const reconnectTimer = timers.find((t) => t.delay === 1000)
    reconnectTimer?.callback()
    expect(FakeWebSocket.instances).toHaveLength(2)
  })

  test('clears timeout when socket opens successfully', () => {
    const manager = new WebSocketManager()
    manager.connect()

    const timeoutTimer = timers.find((t) => t.delay === 10000)
    expect(timeoutTimer).toBeDefined()
    const timeoutId = timeoutTimer!.id

    const ws = FakeWebSocket.instances[0]!
    ws.triggerOpen()

    // Timeout should have been cleared
    expect(timers.find((t) => t.id === timeoutId)).toBeUndefined()
  })

  test('clears timeout on error', () => {
    const manager = new WebSocketManager()
    manager.connect()

    const timeoutTimer = timers.find((t) => t.delay === 10000)
    const timeoutId = timeoutTimer!.id

    const ws = FakeWebSocket.instances[0]!
    ws.triggerError()

    expect(timers.find((t) => t.id === timeoutId)).toBeUndefined()
  })
})

describe('connect() zombie socket guard', () => {
  test('destroys zombie CONNECTING socket and creates new one', () => {
    const manager = new WebSocketManager()
    manager.connect()
    const ws1 = FakeWebSocket.instances[0]!
    // ws1 is stuck in CONNECTING (default readyState)

    // Force internal ws reference to exist but not OPEN
    // Calling connect() again should destroy ws1 and create ws2
    // We need to get past the `if (this.ws)` guard — simulate by
    // disconnecting the close handler so onclose won't null ws
    ;(manager as unknown as { ws: FakeWebSocket }).ws = ws1
    manager.connect()

    expect(FakeWebSocket.instances).toHaveLength(2)
    // ws1 should have had its handlers nulled
    expect(ws1.onopen).toBeNull()
  })

  test('does not create new socket if already OPEN', () => {
    const manager = new WebSocketManager()
    manager.connect()
    const ws = FakeWebSocket.instances[0]!
    ws.triggerOpen()

    manager.connect()
    expect(FakeWebSocket.instances).toHaveLength(1)
  })
})

describe('lifecycle listeners', () => {
  test('startLifecycleListeners is idempotent', () => {
    const manager = new WebSocketManager()
    manager.connect()
    FakeWebSocket.instances[0]?.triggerOpen()

    manager.startLifecycleListeners()
    manager.startLifecycleListeners()
    manager.startLifecycleListeners()

    // Wake-check interval + heartbeat interval
    expect(intervals).toHaveLength(2)
    // Only one visibilitychange listener
    expect(visibilityListeners).toHaveLength(1)
    // Only one pageshow listener
    expect(pageshowListeners).toHaveLength(1)
  })

  test('stopLifecycleListeners cleans up and allows restart', () => {
    const manager = new WebSocketManager()
    manager.connect()
    FakeWebSocket.instances[0]?.triggerOpen()

    manager.startLifecycleListeners()
    expect(intervals).toHaveLength(2) // heartbeat + wake-check
    expect(visibilityListeners).toHaveLength(1)

    manager.stopLifecycleListeners()
    expect(intervals).toHaveLength(1) // heartbeat remains (lifecycle doesn't own it)
    expect(visibilityListeners).toHaveLength(0)
    expect(pageshowListeners).toHaveLength(0)

    // Can start again after stop
    manager.startLifecycleListeners()
    expect(intervals).toHaveLength(2)
    expect(visibilityListeners).toHaveLength(1)
  })

  test('stopLifecycleListeners is a no-op if not started', () => {
    const manager = new WebSocketManager()
    // Should not throw
    manager.stopLifecycleListeners()
    expect(intervals).toHaveLength(0)
  })
})

describe('forceReconnect via visibilitychange', () => {
  test('reconnects when page becomes visible and socket is not OPEN', () => {
    const manager = new WebSocketManager()
    manager.connect()
    const ws = FakeWebSocket.instances[0]!
    ws.triggerOpen()
    manager.startLifecycleListeners()

    // Simulate going to background and losing the socket
    ws.readyState = FakeWebSocket.CLOSED
    ;(manager as unknown as { ws: null }).ws = null
    ;(manager as unknown as { status: string }).status = 'reconnecting'

    fireVisibilityChange('visible')

    // Should have created a new socket
    expect(FakeWebSocket.instances).toHaveLength(2)
  })

  test('does not reconnect on non-suspended resume with healthy socket', () => {
    const manager = new WebSocketManager()
    manager.connect()
    FakeWebSocket.instances[0]!.triggerOpen()
    manager.startLifecycleListeners()

    // lastTick is recent — no suspension detected
    fireVisibilityChange('visible')

    // No new socket — already connected, not forced
    expect(FakeWebSocket.instances).toHaveLength(1)
  })

  test('force reconnects on suspended resume even with healthy socket', () => {
    const manager = new WebSocketManager()
    manager.connect()
    FakeWebSocket.instances[0]!.triggerOpen()
    manager.startLifecycleListeners()

    // Simulate suspension: lastTick far in the past (>10s gap)
    ;(manager as unknown as { lastTick: number }).lastTick = Date.now() - 15_000

    fireVisibilityChange('visible')

    // Should have torn down and created a new socket despite OPEN+connected
    expect(FakeWebSocket.instances).toHaveLength(2)
    // Old socket handlers should be nulled
    expect(FakeWebSocket.instances[0]!.onopen).toBeNull()
  })

  test('does not reconnect if manually disconnected', () => {
    const manager = new WebSocketManager()
    manager.connect()
    FakeWebSocket.instances[0]!.triggerOpen()
    manager.startLifecycleListeners()

    manager.disconnect()
    fireVisibilityChange('visible')

    // No new socket
    expect(FakeWebSocket.instances).toHaveLength(1)
  })

  test('does not fire when page becomes hidden', () => {
    const manager = new WebSocketManager()
    manager.connect()
    FakeWebSocket.instances[0]!.triggerOpen()
    manager.startLifecycleListeners()

    // Manually null out the socket to simulate a broken state
    ;(manager as unknown as { ws: null }).ws = null
    ;(manager as unknown as { status: string }).status = 'reconnecting'

    fireVisibilityChange('hidden')

    // No new socket — only fires on 'visible'
    expect(FakeWebSocket.instances).toHaveLength(1)
  })
})

describe('forceReconnect via pageshow', () => {
  test('reconnects on bfcache restore (persisted=true) even with healthy socket', () => {
    const manager = new WebSocketManager()
    manager.connect()
    FakeWebSocket.instances[0]!.triggerOpen()
    manager.startLifecycleListeners()

    // bfcache restore always forces reconnect — socket is stale
    firePageShow(true)
    expect(FakeWebSocket.instances).toHaveLength(2)
    expect(FakeWebSocket.instances[0]!.onopen).toBeNull() // old socket torn down
  })

  test('does not reconnect on normal navigation (persisted=false)', () => {
    const manager = new WebSocketManager()
    manager.connect()
    FakeWebSocket.instances[0]!.triggerOpen()
    manager.startLifecycleListeners()

    ;(manager as unknown as { ws: null }).ws = null
    ;(manager as unknown as { status: string }).status = 'reconnecting'

    firePageShow(false)
    expect(FakeWebSocket.instances).toHaveLength(1)
  })
})

describe('forceReconnect via time-jump detector', () => {
  test('reconnects when time jump > 15s detected', () => {
    const manager = new WebSocketManager()
    manager.connect()
    FakeWebSocket.instances[0]!.triggerOpen()
    manager.startLifecycleListeners()

    // Simulate dead socket after sleep
    ;(manager as unknown as { ws: null }).ws = null
    ;(manager as unknown as { status: string }).status = 'reconnecting'

    // Simulate a time jump by setting lastTick far in the past
    ;(manager as unknown as { lastTick: number }).lastTick = Date.now() - 20_000

    fireAllIntervals()
    expect(FakeWebSocket.instances).toHaveLength(2)
  })

  test('does not reconnect for small time gaps', () => {
    const manager = new WebSocketManager()
    manager.connect()
    FakeWebSocket.instances[0]!.triggerOpen()
    manager.startLifecycleListeners()

    ;(manager as unknown as { ws: null }).ws = null
    ;(manager as unknown as { status: string }).status = 'reconnecting'

    // lastTick is recent — no time jump
    ;(manager as unknown as { lastTick: number }).lastTick = Date.now() - 4_000

    fireAllIntervals()
    expect(FakeWebSocket.instances).toHaveLength(1)
  })
})

describe('forceReconnect resets backoff', () => {
  test('resets reconnectAttempts to 0 and cancels pending reconnect timer', () => {
    const manager = new WebSocketManager()
    const statuses: string[] = []
    manager.subscribeStatus((status) => statuses.push(status))

    manager.connect()
    const ws = FakeWebSocket.instances[0]!
    ws.triggerOpen()

    // Simulate multiple failed reconnects to increase backoff
    ws.close()
    // reconnectAttempts is now 1, timer scheduled at 1s
    const timer1 = timers.find((t) => t.delay === 1000)!
    timer1.callback()
    // New socket created, trigger close again
    FakeWebSocket.instances[1]!.close()
    // reconnectAttempts is now 2, timer at 2s

    manager.startLifecycleListeners()

    // Now simulate wake — forceReconnect should reset backoff
    ;(manager as unknown as { ws: null }).ws = null
    ;(manager as unknown as { status: string }).status = 'reconnecting'
    fireVisibilityChange('visible')

    // A new socket should be created immediately (not waiting for 4s backoff)
    const latestWs = FakeWebSocket.instances[FakeWebSocket.instances.length - 1]!
    latestWs.triggerOpen()
    expect(statuses[statuses.length - 1]).toBe('connected')
  })
})

describe('zombie OPEN socket detection', () => {
  test('forceReconnect tears down OPEN socket when status is not connected', () => {
    const manager = new WebSocketManager()
    manager.connect()
    const ws = FakeWebSocket.instances[0]!
    ws.triggerOpen()
    manager.startLifecycleListeners()

    // Simulate zombie: socket says OPEN but status diverged (e.g. reconnecting after timeout)
    ;(manager as unknown as { status: string }).status = 'reconnecting'

    fireVisibilityChange('visible')

    // Should have destroyed the zombie and created a new socket
    expect(FakeWebSocket.instances).toHaveLength(2)
    expect(ws.onopen).toBeNull() // old socket handlers nulled
  })
})

describe('scheduleReconnect while hidden', () => {
  test('does not schedule timer when page is hidden', () => {
    mockVisibilityState = 'hidden'
    const manager = new WebSocketManager()
    const statuses: string[] = []
    manager.subscribeStatus((status) => statuses.push(status))

    manager.connect()
    const ws = FakeWebSocket.instances[0]!
    ws.triggerOpen()

    // Close while hidden
    ws.close()

    // Status should be reconnecting but no timer scheduled
    expect(statuses[statuses.length - 1]).toBe('reconnecting')
    const reconnectTimers = timers.filter((t) => t.delay >= 1000 && t.delay <= 30000)
    expect(reconnectTimers).toHaveLength(0)
  })

  test('debounces rapid non-forced forceReconnect calls', () => {
    const manager = new WebSocketManager()
    manager.connect()
    FakeWebSocket.instances[0]!.triggerOpen()
    manager.startLifecycleListeners()

    // Simulate suspension so the first call is forced
    ;(manager as unknown as { lastTick: number }).lastTick = Date.now() - 15_000

    // First call should reconnect (forced — suspension detected)
    fireVisibilityChange('visible')
    expect(FakeWebSocket.instances).toHaveLength(2)

    // Second rapid call — lastTick was normalized by the first handler, so
    // wasSuspended is false and the non-forced debounce (< 500ms) kicks in
    fireVisibilityChange('visible')
    expect(FakeWebSocket.instances).toHaveLength(2) // still 2, not 3
  })

  test('forceReconnect on visibility resume after hidden close', () => {
    const manager = new WebSocketManager()
    manager.connect()
    const ws = FakeWebSocket.instances[0]!
    ws.triggerOpen()
    manager.startLifecycleListeners()

    // Go hidden, socket closes
    mockVisibilityState = 'hidden'
    ws.close()

    // No reconnect timer while hidden
    const reconnectTimers = timers.filter((t) => t.delay >= 1000 && t.delay <= 30000)
    expect(reconnectTimers).toHaveLength(0)

    // Come back
    fireVisibilityChange('visible')

    // Should reconnect immediately
    expect(FakeWebSocket.instances).toHaveLength(2)
  })
})

describe('heartbeat ping/pong', () => {
  test('pong receipt clears timeout', () => {
    const manager = new WebSocketManager()
    manager.connect()
    const ws = FakeWebSocket.instances[0]!
    ws.triggerOpen()
    manager.startLifecycleListeners()

    // Find the heartbeat interval (20000ms)
    const heartbeatInterval = intervals.find((i) => i.interval === 20000)
    expect(heartbeatInterval).toBeDefined()

    // Fire it to send a ping
    heartbeatInterval!.callback()
    expect(ws.sent).toContain('{"type":"ping"}')

    // A pong timeout timer (10000ms) should now be scheduled
    const pongTimeout = timers.find((t) => t.delay === 10000)
    expect(pongTimeout).toBeDefined()

    // Simulate receiving a pong from the server
    ws.triggerMessage(JSON.stringify({ type: 'pong' }))

    // The pong timeout timer should have been cleared
    expect(timers.find((t) => t.id === pongTimeout!.id)).toBeUndefined()

    // No new socket was created — connection is healthy
    expect(FakeWebSocket.instances).toHaveLength(1)
  })

  test('missing pong triggers destroy and reconnect', () => {
    const manager = new WebSocketManager()
    const statuses: string[] = []
    manager.subscribeStatus((status) => statuses.push(status))

    manager.connect()
    const ws = FakeWebSocket.instances[0]!
    ws.triggerOpen()
    manager.startLifecycleListeners()

    // Fire heartbeat interval to send a ping
    const heartbeatInterval = intervals.find((i) => i.interval === 20000)
    expect(heartbeatInterval).toBeDefined()
    heartbeatInterval!.callback()

    // Find and fire the pong timeout (10000ms) — no pong arrived
    const pongTimeout = timers.find((t) => t.delay === 10000)
    expect(pongTimeout).toBeDefined()
    pongTimeout!.callback()

    // Old socket handlers should be nulled (zombie destroyed)
    expect(ws.onopen).toBeNull()
    expect(ws.onclose).toBeNull()

    // Status should be reconnecting
    expect(statuses[statuses.length - 1]).toBe('reconnecting')

    // A reconnect timer should be scheduled
    const reconnectTimer = timers.find((t) => t.delay >= 1000 && t.delay <= 30000)
    expect(reconnectTimer).toBeDefined()
  })
})

describe('forceReconnect debounce', () => {
  test('does not suppress forced pageshow(persisted=true) after non-forced visibilitychange', () => {
    const manager = new WebSocketManager()
    manager.connect()
    FakeWebSocket.instances[0]!.triggerOpen()
    manager.startLifecycleListeners()

    // lastTick is recent (no suspension) — visibilitychange is non-forced
    fireVisibilityChange('visible')

    // Should still be 1 socket — non-forced, already connected, hits already_connected
    expect(FakeWebSocket.instances).toHaveLength(1)

    // Immediately fire pageshow(persisted=true) — bfcache restore should force
    // reconnect even within the 500ms debounce window
    firePageShow(true)

    // Should have 2 sockets now — the forced pageshow was NOT debounced
    expect(FakeWebSocket.instances).toHaveLength(2)
  })
})

describe('lastTick normalization on resume', () => {
  test('prevents wake-check double reconnect', () => {
    const manager = new WebSocketManager()
    manager.connect()
    FakeWebSocket.instances[0]!.triggerOpen()
    manager.startLifecycleListeners()

    // Set lastTick far in the past (20s ago) to simulate suspension
    ;(manager as unknown as { lastTick: number }).lastTick = Date.now() - 20_000

    // visibilitychange should detect suspension and force reconnect
    fireVisibilityChange('visible')
    expect(FakeWebSocket.instances).toHaveLength(2)

    // Open the new socket so it is connected
    FakeWebSocket.instances[1]!.triggerOpen()

    // Fire all intervals (including wake-check) — should NOT create another
    // socket because lastTick was normalized by the visibilitychange handler
    fireAllIntervals()

    // Still 2 sockets, not 3
    expect(FakeWebSocket.instances).toHaveLength(2)
  })
})
