import { afterEach, beforeEach, expect, test } from 'bun:test'
import { WebSocketManager } from '../hooks/useWebSocket'

class Socket {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSING = 2
  static CLOSED = 3
  static instances: Socket[] = []
  readyState = 0
  bufferedAmount = 0
  sent: Array<Record<string, unknown>> = []
  onopen: (() => void) | null = null
  onclose: ((event: object) => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  constructor(_url: string) { Socket.instances.push(this) }
  send(raw: string) { this.sent.push(JSON.parse(raw)) }
  open() { this.readyState = 1; this.onopen?.() }
  close() { this.readyState = 3; this.onclose?.({ code: 1000, wasClean: true, reason: '' }) }
  receive(message: object) { this.onmessage?.({ data: JSON.stringify(message) }) }
  pong() { const ping = this.sent.findLast(m => m.type === 'ping')!; this.receive({ type: 'pong', seq: ping.seq }) }
}
const saved = { window: globalThis.window, document: globalThis.document, WebSocket: globalThis.WebSocket }
let listeners: Map<string, (event?: unknown) => void>
let timers: Map<number, { fn: () => void; ms: number }>
let visibility = 'visible'
let manager: WebSocketManager
let next = 0
function emit(event: string, value?: unknown) { listeners.get(event)?.(value) }
function visible(value: boolean) { visibility = value ? 'visible' : 'hidden'; emit('visibilitychange') }
function attach(ws: Socket, target = 'A') {
  manager.send({ type: 'terminal-attach', sessionId: target, cols: 80, rows: 24 })
  const id = ws.sent.findLast(m => m.type === 'terminal-attach')!.attachId as number
  return { type: 'terminal-ready', sessionId: target, attachId: id } as const
}
function openReady() {
  manager.connect()
  const ws = Socket.instances.at(-1)!
  ws.open()
  ws.receive({ type: 'terminal-lease', token: 'document-capability' })
  ws.receive(attach(ws))
  return ws
}
beforeEach(() => {
  listeners = new Map(); timers = new Map(); Socket.instances = []; visibility = 'visible'; next = 0
  const schedule = (fn: () => void, ms: number) => { const id = ++next; timers.set(id, { fn, ms }); return id }
  Object.assign(globalThis, {
    WebSocket: Socket,
    window: { location: { protocol: 'http:', host: 'localhost' }, setTimeout: schedule, setInterval: schedule,
      clearTimeout: (id: number) => timers.delete(id), clearInterval: (id: number) => timers.delete(id),
      addEventListener: (event: string, fn: (event?: unknown) => void) => listeners.set(event, fn),
      removeEventListener: (event: string) => listeners.delete(event) },
    document: { get visibilityState() { return visibility },
      addEventListener: (event: string, fn: () => void) => listeners.set(event, fn),
      removeEventListener: (event: string) => listeners.delete(event) },
  })
  manager = new WebSocketManager(); manager.startLifecycleListeners()
})
afterEach(() => { manager.disconnect(); manager.stopLifecycleListeners(); Object.assign(globalThis, saved) })

test('lease handshake precedes attach and replacement claims are per document', () => {
  const ws = openReady()
  expect(ws.sent[0]).toEqual({ type: 'terminal-resume', claim: 1 })
  ws.close()
  const retry = [...timers.values()].find(t => t.ms === 1000)!
  retry.fn()
  const replacement = Socket.instances.at(-1)!
  replacement.open()
  expect(replacement.sent[0]).toEqual({ type: 'terminal-resume', token: 'document-capability', claim: 2 })
})

test('hidden, verification and unacknowledged reattach reject typing and paste', () => {
  const ws = openReady()
  expect(manager.send({ type: 'terminal-input', sessionId: 'A', data: 'before' })).toBe(true)
  visible(false)
  expect(manager.send({ type: 'terminal-input', sessionId: 'A', data: 'hidden' })).toBe(false)
  visible(true)
  expect(manager.send({ type: 'terminal-paste', sessionId: 'A', data: 'probing' })).toBe(false)
  const epoch = manager.getConnectionEpoch()
  ws.pong()
  expect(manager.getConnectionEpoch()).toBe(epoch + 1)
  expect(manager.send({ type: 'terminal-input', sessionId: 'A', data: 'not-attached' })).toBe(false)
  ws.receive(attach(ws))
  expect(manager.send({ type: 'terminal-input', sessionId: 'A', data: 'fresh' })).toBe(true)
  expect(ws.sent.filter(m => m.type === 'terminal-input').map(m => m.data)).toEqual(['before', 'fresh'])
})

test('first input after silent suspension verifies before timers have run', () => {
  const ws = openReady()
  ;(manager as unknown as { lastTick: number }).lastTick = Date.now() - 60_000
  expect(manager.send({ type: 'terminal-input', sessionId: 'A', data: 'too-early' })).toBe(false)
  expect(manager.getStatus()).toBe('reconnecting')
  expect(ws.sent.filter(m => m.type === 'terminal-input')).toHaveLength(0)
  ws.pong(); ws.receive(attach(ws))
  expect(manager.send({ type: 'terminal-input', sessionId: 'A', data: 'safe' })).toBe(true)
})

test('pagehide and pageshow work even when document visibility does not change', () => {
  const ws = openReady()
  emit('pagehide')
  expect(manager.send({ type: 'terminal-input', sessionId: 'A', data: 'cached-page' })).toBe(false)
  emit('pageshow', { persisted: true })
  emit('visibilitychange')
  expect(ws.sent.filter(m => m.type === 'ping')).toHaveLength(1)
  ws.pong()
  expect(Socket.instances).toHaveLength(1)
  expect(manager.getStatus()).toBe('connected')
})

test('a socket opening after hide does not start heartbeat or enable input', () => {
  manager.connect(); const ws = Socket.instances[0]!
  visible(false); ws.open()
  expect([...timers.values()].some(t => t.ms === 20_000)).toBe(false)
  expect(manager.getStatus()).toBe('reconnecting')
  visible(true); ws.pong(); ws.receive(attach(ws))
  expect(manager.send({ type: 'terminal-input', sessionId: 'A', data: 'safe' })).toBe(true)
})

test('stale A readiness and output cannot activate a later A attachment', () => {
  const ws = openReady()
  const oldA = attach(ws)
  ws.receive(oldA)
  ws.receive(attach(ws, 'B'))
  const newA = attach(ws)
  const delivered: object[] = []
  manager.subscribe(m => delivered.push(m))
  ws.receive(oldA)
  ws.receive({ type: 'terminal-output', sessionId: 'A', attachId: oldA.attachId, outputSeq: 9, data: 'stale' })
  expect(manager.send({ type: 'terminal-input', sessionId: 'A', data: 'wrong-generation' })).toBe(false)
  expect(delivered).toHaveLength(0)
  expect(ws.sent.at(-1)).toEqual({ type: 'terminal-ack', outputSeq: 9 })
  ws.receive(newA)
  expect(manager.send({ type: 'terminal-input', sessionId: 'A', data: 'current-generation' })).toBe(true)
  expect(ws.sent.at(-1)?.attachId).toBe(newA.attachId)
})


test('late parser ACK cannot release a replacement connection output budget', () => {
  const ws = openReady()
  const oldEpoch = manager.getConnectionEpoch()
  visible(false); visible(true); ws.pong()
  const currentEpoch = manager.getConnectionEpoch()
  expect(currentEpoch).toBeGreaterThan(oldEpoch)
  const before = ws.sent.length
  expect(manager.send({ type: 'terminal-ack', outputSeq: 90, connectionEpoch: oldEpoch })).toBe(false)
  expect(ws.sent).toHaveLength(before)
  expect(manager.send({ type: 'terminal-ack', outputSeq: 1, connectionEpoch: currentEpoch })).toBe(true)
  expect(ws.sent.at(-1)).toEqual({ type: 'terminal-ack', outputSeq: 1 })
})
