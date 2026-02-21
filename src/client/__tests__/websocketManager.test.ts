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
  throwOnSend = false

  constructor(public url: string) {
    FakeWebSocket.instances.push(this)
  }

  send(data: string) {
    if (this.throwOnSend) {
      throw new Error('send failed')
    }
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

/** Fire the settle delay timer (750ms) that force reconnects schedule. */
function fireSettleTimer() {
  const settle = timers.find((t) => t.delay === 750)
  expect(settle).toBeDefined()
  settle!.callback()
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

  test('send failure destroys socket and schedules reconnect', () => {
    const manager = new WebSocketManager()
    const statuses: string[] = []
    manager.subscribeStatus((status) => statuses.push(status))
    manager.connect()
    const ws = FakeWebSocket.instances[0]!
    ws.triggerOpen()
    ws.throwOnSend = true

    expect(() => manager.send({ type: 'session-refresh' })).not.toThrow()

    expect(ws.onopen).toBeNull()
    expect(ws.onmessage).toBeNull()
    expect(statuses[statuses.length - 1]).toBe('reconnecting')
    expect(timers.some((t) => t.delay === 1000)).toBe(true)
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
    const timeoutTimer = timers.find((t) => t.delay === 3000)
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

    // Simulate the spec-guaranteed onerror -> onclose sequence
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

    // Socket stays in CONNECTING — find and fire the 3s timeout
    const timeoutTimer = timers.find((t) => t.delay === 3000)
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

  test('reconnects if socket reports OPEN but status never became connected', () => {
    const manager = new WebSocketManager()
    const statuses: string[] = []
    manager.subscribeStatus((status) => statuses.push(status))

    manager.connect()
    expect(FakeWebSocket.instances).toHaveLength(1)
    const ws = FakeWebSocket.instances[0]!

    // Simulate iOS lifecycle glitch: readyState flips OPEN without onopen.
    ws.readyState = FakeWebSocket.OPEN

    // 3s timeout should still treat this as unhealthy and recover.
    const timeoutTimer = timers.find((t) => t.delay === 3000)
    expect(timeoutTimer).toBeDefined()
    timeoutTimer!.callback()

    expect(ws.onopen).toBeNull()
    expect(ws.onclose).toBeNull()
    expect(statuses[statuses.length - 1]).toBe('reconnecting')
    expect(timers.some((t) => t.delay === 1000)).toBe(true)
  })

  test('clears timeout when socket opens successfully', () => {
    const manager = new WebSocketManager()
    manager.connect()

    const timeoutTimer = timers.find((t) => t.delay === 3000)
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

    const timeoutTimer = timers.find((t) => t.delay === 3000)
    const timeoutId = timeoutTimer!.id

    const ws = FakeWebSocket.instances[0]!
    ws.triggerError()

    expect(timers.find((t) => t.id === timeoutId)).toBeUndefined()
  })

  test('ignores stale timeout callback from a replaced socket', () => {
    const manager = new WebSocketManager()

    // First connect creates ws1 + timeout1.
    manager.connect()
    const timeout1 = timers.find((t) => t.delay === 3000)!
    const timeout1Id = timeout1.id

    // Replace socket before timeout fires.
    ;(manager as unknown as { ws: null }).ws = null
    manager.connect()
    const timeout2 = timers.find(
      (t) => t.delay === 3000 && t.id !== timeout1Id
    )!
    const timeout2Id = timeout2.id

    // Old timeout should be cleared by the second connect.
    expect(timers.find((t) => t.id === timeout1Id)).toBeUndefined()

    // Simulate queued stale callback firing late.
    timeout1.callback()

    // Stale callback must not clobber the current connect timer reference.
    manager.disconnect()
    expect(timers.find((t) => t.id === timeout2Id)).toBeUndefined()

    // Disconnect should not schedule reconnect.
    const reconnectTimers = timers.filter((t) => t.delay >= 1000 && t.delay <= 30000)
    expect(reconnectTimers).toHaveLength(0)
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

  test('destroys OPEN socket when status is desynced from connected', () => {
    const manager = new WebSocketManager()
    manager.connect()
    const ws = FakeWebSocket.instances[0]!
    ws.triggerOpen()

    // Simulate desync observed after background/foreground lifecycle glitches.
    ;(manager as unknown as { status: string }).status = 'reconnecting'
    manager.connect()

    expect(FakeWebSocket.instances).toHaveLength(2)
    expect(ws.onopen).toBeNull()
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
  test('force reconnects when page becomes visible (settle delay then connect)', () => {
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

    // Force reconnect schedules a 750ms settle timer before connecting
    expect(FakeWebSocket.instances).toHaveLength(1) // not yet connected
    fireSettleTimer()

    // After settle delay, a new socket is created
    expect(FakeWebSocket.instances).toHaveLength(2)
  })

  test('always force reconnects on resume even with healthy socket (no more verification ping)', () => {
    const manager = new WebSocketManager()
    manager.connect()
    const ws = FakeWebSocket.instances[0]!
    ws.triggerOpen()
    manager.startLifecycleListeners()

    // lastTick is recent — previously this would send a verification ping.
    // Now ALL resumes force-reconnect with force=true.
    fireVisibilityChange('visible')

    // Old socket should be destroyed
    expect(ws.onopen).toBeNull()
    // No verification ping sent on old socket
    expect(ws.sent).toHaveLength(0)

    // Settle timer scheduled, fire it
    fireSettleTimer()
    expect(FakeWebSocket.instances).toHaveLength(2)
  })

  test('force reconnects on suspended resume with healthy socket', () => {
    const manager = new WebSocketManager()
    manager.connect()
    FakeWebSocket.instances[0]!.triggerOpen()
    manager.startLifecycleListeners()

    // Simulate suspension: lastTick far in the past (>10s gap)
    ;(manager as unknown as { lastTick: number }).lastTick = Date.now() - 15_000

    fireVisibilityChange('visible')

    // Old socket handlers should be nulled
    expect(FakeWebSocket.instances[0]!.onopen).toBeNull()

    // Fire the settle delay timer to trigger connect
    fireSettleTimer()

    // Should have torn down and created a new socket despite OPEN+connected
    expect(FakeWebSocket.instances).toHaveLength(2)
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

    // Old socket should be torn down immediately
    expect(FakeWebSocket.instances[0]!.onopen).toBeNull()

    // Fire settle timer to trigger connect
    fireSettleTimer()

    expect(FakeWebSocket.instances).toHaveLength(2)
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

describe('time-jump detector skips while hidden', () => {
  test('does not fire forceReconnect when page is hidden', () => {
    const manager = new WebSocketManager()
    manager.connect()
    FakeWebSocket.instances[0]!.triggerOpen()
    manager.startLifecycleListeners()

    // Go hidden
    fireVisibilityChange('hidden')

    // Set lastTick far in the past (simulating browser timer clamping)
    ;(manager as unknown as { lastTick: number }).lastTick = Date.now() - 60_000

    fireAllIntervals()

    // Should NOT have created a new socket — time-jump skipped while hidden
    expect(FakeWebSocket.instances).toHaveLength(1)
  })
})

describe('reconnect timer cleared on hidden', () => {
  test('clears pending reconnect timer when page goes hidden', () => {
    const manager = new WebSocketManager()
    manager.connect()
    const ws = FakeWebSocket.instances[0]!
    ws.triggerOpen()
    manager.startLifecycleListeners()

    // Trigger a close to schedule a reconnect timer
    ws.close()
    const reconnectTimer = timers.find((t) => t.delay >= 1000 && t.delay <= 30000)
    expect(reconnectTimer).toBeDefined()

    // Go hidden — should clear the reconnect timer
    fireVisibilityChange('hidden')
    expect(timers.find((t) => t.id === reconnectTimer!.id)).toBeUndefined()
  })
})

describe('forceReconnect via time-jump detector', () => {
  test('reconnects when time jump > 15s detected (after settle delay)', () => {
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

    // Force reconnect with force=true schedules settle delay first
    expect(FakeWebSocket.instances).toHaveLength(1)
    fireSettleTimer()

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

    // Force reconnect schedules a 750ms settle timer
    fireSettleTimer()

    // A new socket should be created after the settle delay
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

    // Old socket handlers should be nulled (torn down immediately)
    expect(ws.onopen).toBeNull()

    // Fire settle timer
    fireSettleTimer()

    // Should have destroyed the zombie and created a new socket
    expect(FakeWebSocket.instances).toHaveLength(2)
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

  test('debounces rapid forced forceReconnect calls', () => {
    const manager = new WebSocketManager()
    manager.connect()
    FakeWebSocket.instances[0]!.triggerOpen()
    manager.startLifecycleListeners()

    // Simulate suspension so the first call is forced
    ;(manager as unknown as { lastTick: number }).lastTick = Date.now() - 15_000

    // First call should force-reconnect (all resumes are now forced)
    fireVisibilityChange('visible')
    // Old socket destroyed
    expect(FakeWebSocket.instances[0]!.onopen).toBeNull()
    // Settle timer scheduled
    const settleTimer = timers.find((t) => t.delay === 750)
    expect(settleTimer).toBeDefined()

    // Second rapid call — within the 200ms forced debounce window
    fireVisibilityChange('visible')
    // No second settle timer — debounced
    const settleTimers = timers.filter((t) => t.delay === 750)
    expect(settleTimers).toHaveLength(1) // still just 1

    // Fire settle timer, socket created
    settleTimers[0]!.callback()
    expect(FakeWebSocket.instances).toHaveLength(2) // only 2, not 3
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

    // Force reconnect schedules settle delay
    fireSettleTimer()

    // Should reconnect after settle delay
    expect(FakeWebSocket.instances).toHaveLength(2)
  })
})

describe('heartbeat ping/pong', () => {
  test('pong receipt with matching seq clears timeout', () => {
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
    const sent = JSON.parse(ws.sent[ws.sent.length - 1]!)
    expect(sent.type).toBe('ping')
    expect(sent.seq).toBe(1)

    // A pong timeout timer (10000ms) should now be scheduled
    const pongTimeout = timers.find((t) => t.delay === 10000)
    expect(pongTimeout).toBeDefined()

    // Simulate receiving a matching pong from the server
    ws.triggerMessage(JSON.stringify({ type: 'pong', seq: 1 }))

    // The pong timeout timer should have been cleared
    expect(timers.find((t) => t.id === pongTimeout!.id)).toBeUndefined()

    // No new socket was created — connection is healthy
    expect(FakeWebSocket.instances).toHaveLength(1)
  })

  test('pong with wrong seq does not clear timeout', () => {
    const manager = new WebSocketManager()
    manager.connect()
    const ws = FakeWebSocket.instances[0]!
    ws.triggerOpen()
    manager.startLifecycleListeners()

    const heartbeatInterval = intervals.find((i) => i.interval === 20000)!
    heartbeatInterval.callback()

    const pongTimeout = timers.find((t) => t.delay === 10000)
    expect(pongTimeout).toBeDefined()

    // Send pong with stale seq (0 instead of 1)
    ws.triggerMessage(JSON.stringify({ type: 'pong', seq: 0 }))

    // Timeout should NOT have been cleared — stale pong
    expect(timers.find((t) => t.id === pongTimeout!.id)).toBeDefined()
  })

  test('pong without seq does not clear timeout', () => {
    const manager = new WebSocketManager()
    manager.connect()
    const ws = FakeWebSocket.instances[0]!
    ws.triggerOpen()
    manager.startLifecycleListeners()

    const heartbeatInterval = intervals.find((i) => i.interval === 20000)!
    heartbeatInterval.callback()

    const pongTimeout = timers.find((t) => t.delay === 10000)
    expect(pongTimeout).toBeDefined()

    ws.triggerMessage(JSON.stringify({ type: 'pong' }))

    expect(timers.find((t) => t.id === pongTimeout!.id)).toBeDefined()
  })

  test('ping seq increments', () => {
    const manager = new WebSocketManager()
    manager.connect()
    const ws = FakeWebSocket.instances[0]!
    ws.triggerOpen()
    manager.startLifecycleListeners()

    const heartbeatInterval = intervals.find((i) => i.interval === 20000)!

    // First ping
    heartbeatInterval.callback()
    let sent = JSON.parse(ws.sent[ws.sent.length - 1]!)
    expect(sent.seq).toBe(1)

    // Clear pong timer to allow next heartbeat
    ws.triggerMessage(JSON.stringify({ type: 'pong', seq: 1 }))

    // Second ping
    heartbeatInterval.callback()
    sent = JSON.parse(ws.sent[ws.sent.length - 1]!)
    expect(sent.seq).toBe(2)
  })

  test('ping send failure schedules reconnect without pong timeout', () => {
    const manager = new WebSocketManager()
    manager.connect()
    const ws = FakeWebSocket.instances[0]!
    ws.triggerOpen()
    manager.startLifecycleListeners()
    ws.throwOnSend = true

    const heartbeatInterval = intervals.find((i) => i.interval === 20000)!
    heartbeatInterval.callback()

    expect(timers.some((t) => t.delay === 10000)).toBe(false)
    expect(timers.some((t) => t.delay === 1000)).toBe(true)
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
  test('does not suppress forced pageshow(persisted=true) after forced visibilitychange', () => {
    const manager = new WebSocketManager()
    manager.connect()
    FakeWebSocket.instances[0]!.triggerOpen()
    manager.startLifecycleListeners()

    // All resumes are now forced — visibilitychange fires forceReconnect(force=true)
    fireVisibilityChange('visible')

    // Old socket torn down, settle timer scheduled
    expect(FakeWebSocket.instances[0]!.onopen).toBeNull()
    const settle1 = timers.find((t) => t.delay === 750)
    expect(settle1).toBeDefined()

    // Immediately fire pageshow(persisted=true) — within 200ms debounce window
    // The second forced call should be debounced to avoid double reconnect
    firePageShow(true)

    // Still just one settle timer — second was debounced
    const settleTimers = timers.filter((t) => t.delay === 750)
    expect(settleTimers).toHaveLength(1)

    // Fire settle timer, socket created
    settle1!.callback()
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

    // visibilitychange should detect and force reconnect
    fireVisibilityChange('visible')
    // Old socket destroyed
    expect(FakeWebSocket.instances[0]!.onopen).toBeNull()

    // Fire the settle timer to create the new socket
    fireSettleTimer()
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

describe('lastTick frozen while hidden', () => {
  test('wake-check does not update lastTick while hidden', () => {
    const manager = new WebSocketManager()
    manager.connect()
    FakeWebSocket.instances[0]!.triggerOpen()
    manager.startLifecycleListeners()

    const tickBefore = (manager as unknown as { lastTick: number }).lastTick

    // Go hidden
    fireVisibilityChange('hidden')

    // Fire wake-check interval while hidden
    fireAllIntervals()

    // lastTick should NOT have been updated (frozen at last visible time)
    const tickAfter = (manager as unknown as { lastTick: number }).lastTick
    expect(tickAfter).toBe(tickBefore)
  })

  test('frozen lastTick causes visibilitychange to force reconnect on resume', () => {
    const manager = new WebSocketManager()
    manager.connect()
    FakeWebSocket.instances[0]!.triggerOpen()
    manager.startLifecycleListeners()

    // Set lastTick to 12s ago
    ;(manager as unknown as { lastTick: number }).lastTick = Date.now() - 12_000

    // Go hidden, fire intervals (lastTick stays frozen)
    fireVisibilityChange('hidden')
    fireAllIntervals()

    // Come back visible — all resumes now force reconnect
    fireVisibilityChange('visible')

    // Old socket should be torn down
    expect(FakeWebSocket.instances[0]!.onopen).toBeNull()

    // Fire settle timer
    fireSettleTimer()

    // Should have force reconnected (new socket created)
    expect(FakeWebSocket.instances).toHaveLength(2)
  })
})

describe('resume settle delay', () => {
  test('force reconnect with force=true schedules 750ms settle delay before connect', () => {
    const manager = new WebSocketManager()
    const statuses: string[] = []
    manager.subscribeStatus((status) => statuses.push(status))
    manager.connect()
    FakeWebSocket.instances[0]!.triggerOpen()
    manager.startLifecycleListeners()

    fireVisibilityChange('visible')

    // Status should be 'reconnecting' immediately
    expect(statuses[statuses.length - 1]).toBe('reconnecting')

    // A 750ms settle timer should be scheduled
    const settle = timers.find((t) => t.delay === 750)
    expect(settle).toBeDefined()

    // No new socket yet (waiting for settle delay)
    expect(FakeWebSocket.instances).toHaveLength(1)

    // Fire the settle timer
    settle!.callback()

    // Now the new socket should be created
    expect(FakeWebSocket.instances).toHaveLength(2)
  })

  test('resume connect uses longer timeout (8000ms) instead of standard (3000ms)', () => {
    const manager = new WebSocketManager()
    manager.connect()
    FakeWebSocket.instances[0]!.triggerOpen()
    manager.startLifecycleListeners()

    fireVisibilityChange('visible')

    // Fire settle timer to trigger connect
    fireSettleTimer()

    // The new socket's connect timeout should be 8000ms (resume timeout)
    const connectTimeout = timers.find((t) => t.delay === 8000)
    expect(connectTimeout).toBeDefined()

    // Standard 3000ms timeout should NOT be present for the new socket
    // (the old one was cleared during destroySocket)
    const standardTimeouts = timers.filter((t) => t.delay === 3000)
    expect(standardTimeouts).toHaveLength(0)
  })

  test('non-forced reconnect connects immediately without settle delay', () => {
    const manager = new WebSocketManager()
    manager.connect()
    const ws = FakeWebSocket.instances[0]!
    ws.triggerOpen()

    // Trigger onclose — scheduleReconnect runs (not a force reconnect)
    ws.close()

    // Should schedule a backoff timer (1000ms), not a settle timer (750ms)
    expect(timers.some((t) => t.delay === 750)).toBe(false)
    expect(timers.some((t) => t.delay === 1000)).toBe(true)

    // Fire the backoff timer
    const reconnectTimer = timers.find((t) => t.delay === 1000)!
    reconnectTimer.callback()

    // Standard connect timeout (3000ms) should be used (not resume timeout)
    const connectTimeout = timers.find((t) => t.delay === 3000)
    expect(connectTimeout).toBeDefined()
  })
})

describe('leaked socket tracking', () => {
  test('new WebSocket is added to leakedSockets and removed on successful open', () => {
    const manager = new WebSocketManager()
    const leaked = () => (manager as unknown as { leakedSockets: Set<unknown> }).leakedSockets

    manager.connect()
    const ws = FakeWebSocket.instances[0]!

    // Socket is in leaked set before opening
    expect(leaked().size).toBe(1)
    expect(leaked().has(ws)).toBe(true)

    // On successful open, socket is removed from leaked set
    ws.triggerOpen()
    expect(leaked().size).toBe(0)
    expect(leaked().has(ws)).toBe(false)
  })

  test('force reconnect purges leaked sockets before scheduling settle delay', () => {
    const manager = new WebSocketManager()
    const leaked = () => (manager as unknown as { leakedSockets: Set<unknown> }).leakedSockets

    manager.connect()
    const ws1 = FakeWebSocket.instances[0]!
    ws1.triggerOpen()

    // Simulate a leaked socket by creating another connect that never opens
    ;(manager as unknown as { ws: null }).ws = null
    manager.connect()
    const ws2 = FakeWebSocket.instances[1]!
    // ws2 never opens — stays in leakedSockets

    expect(leaked().size).toBe(1) // ws2 is leaked
    expect(leaked().has(ws2)).toBe(true)

    manager.startLifecycleListeners()

    // Force reconnect via visibility change
    fireVisibilityChange('visible')

    // After forceReconnect(force=true), leaked sockets should be purged
    expect(leaked().size).toBe(0)
  })

  test('purgeLeakedSockets force-closes all tracked sockets', () => {
    const manager = new WebSocketManager()
    const leaked = () => (manager as unknown as { leakedSockets: Set<unknown> }).leakedSockets

    manager.connect()
    const ws1 = FakeWebSocket.instances[0]!
    // ws1 never opens — leaked

    // Manually add another socket to leaked set to simulate accumulation
    ;(manager as unknown as { ws: null }).ws = null
    manager.connect()
    const ws2 = FakeWebSocket.instances[1]!
    // ws2 never opens — leaked

    expect(leaked().size).toBe(2)

    manager.startLifecycleListeners()
    fireVisibilityChange('visible')

    // Both sockets should be force-closed (readyState = CLOSED)
    expect(ws1.readyState).toBe(FakeWebSocket.CLOSED)
    expect(ws2.readyState).toBe(FakeWebSocket.CLOSED)
    expect(leaked().size).toBe(0)
  })
})

describe('stall detection', () => {
  /** Fire a timer by id and remove it from the mock timers array. */
  function consumeTimer(entry: TimerEntry) {
    entry.callback()
    timers = timers.filter((t) => t.id !== entry.id)
  }

  test('purges leaked sockets and adds cooldown after STALL_THRESHOLD (4) consecutive failures', () => {
    const manager = new WebSocketManager()
    const statuses: string[] = []
    manager.subscribeStatus((status) => statuses.push(status))
    const leaked = () => (manager as unknown as { leakedSockets: Set<unknown> }).leakedSockets

    manager.connect()

    // Simulate 4 consecutive failures via connect timeouts.
    // Each iteration: fire the connect timeout, then (for the first 3) fire the
    // backoff timer which triggers a new connect().
    for (let i = 0; i < 4; i++) {
      const timeoutTimer = timers.find((t) => t.delay === 3000)
      expect(timeoutTimer).toBeDefined()
      consumeTimer(timeoutTimer!)

      if (i < 3) {
        // First 3 failures: scheduleReconnect creates a normal backoff timer
        const backoff = timers.find((t) => t.delay >= 1000 && t.delay <= 30000 && t.delay !== 5000)
        expect(backoff).toBeDefined()
        consumeTimer(backoff!)
      }
    }

    // After 4th failure, stall detection kicks in:
    // - leaked sockets purged
    expect(leaked().size).toBe(0)
    // - status is reconnecting
    expect(statuses[statuses.length - 1]).toBe('reconnecting')
    // - cooldown timer at 5000ms
    const cooldown = timers.find((t) => t.delay === 5000)
    expect(cooldown).toBeDefined()

    // Fire cooldown timer — should create a new socket
    cooldown!.callback()
    const latestWs = FakeWebSocket.instances[FakeWebSocket.instances.length - 1]!
    expect(latestWs.readyState).toBe(FakeWebSocket.CONNECTING)
  })

  test('stall cooldown connect uses resume timeout (8000ms)', () => {
    const manager = new WebSocketManager()
    manager.connect()

    // Drive through 4 consecutive failures to trigger stall
    for (let i = 0; i < 4; i++) {
      const timeoutTimer = timers.find((t) => t.delay === 3000)
      expect(timeoutTimer).toBeDefined()
      consumeTimer(timeoutTimer!)

      if (i < 3) {
        const backoff = timers.find((t) => t.delay >= 1000 && t.delay <= 30000 && t.delay !== 5000)
        expect(backoff).toBeDefined()
        consumeTimer(backoff!)
      }
    }

    // Fire the 5000ms stall cooldown timer
    const cooldown = timers.find((t) => t.delay === 5000)
    expect(cooldown).toBeDefined()
    cooldown!.callback()

    // The stall recovery sets isResumeAttempt=true, so connect timeout
    // should be 8000ms
    const resumeTimeout = timers.find((t) => t.delay === 8000)
    expect(resumeTimeout).toBeDefined()
  })

  test('consecutive failures reset on successful open', () => {
    const manager = new WebSocketManager()
    const getFailures = () =>
      (manager as unknown as { consecutiveFailures: number }).consecutiveFailures

    manager.connect()

    // Timeout to increment consecutiveFailures
    const timeout = timers.find((t) => t.delay === 3000)!
    consumeTimer(timeout)
    expect(getFailures()).toBe(1)

    // Reconnect
    const backoff = timers.find((t) => t.delay === 1000)!
    backoff.callback()
    const ws2 = FakeWebSocket.instances[1]!
    ws2.triggerOpen()

    // Successful open resets failures
    expect(getFailures()).toBe(0)
  })
})
