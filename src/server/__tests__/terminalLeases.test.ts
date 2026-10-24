import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { TerminalRelayClient } from '../relay/client'
import type { Session } from '../../shared/types'
import { TerminalLeases } from '../relay/leases'
import type { RelayToTerminal, TerminalToRelay, ParentToRelay } from '../relay/protocol'

class FakeWorker {
  static instances: FakeWorker[] = []
  onmessage: ((event: MessageEvent<TerminalToRelay>) => void) | null = null
  onerror: (() => void) | null = null
  messages: (RelayToTerminal | ParentToRelay)[] = []
  constructor() { FakeWorker.instances.push(this) }
  postMessage(message: RelayToTerminal | ParentToRelay) { this.messages.push(message) }
  emit(message: TerminalToRelay) { this.onmessage?.({ data: message } as MessageEvent<TerminalToRelay>) }
}
function socket() {
  const frames: string[] = [], closes: number[] = []
  return {
    data: { id: crypto.randomUUID(), lease: null, outputSerial: 0, outstanding: new Map<number, number>(), outstandingBytes: 0 },
    readyState: 1, frames, closes,
    send(payload: string) { frames.push(payload); return payload.length },
    close(code: number) { closes.push(code) },
    getBufferedAmount() { return 0 },
  }
}
type Socket = Parameters<TerminalLeases['handle']>[0]
const asSocket = (peer: ReturnType<typeof socket>) => peer as unknown as Socket
const token = (peer: ReturnType<typeof socket>) => JSON.parse(peer.frames.find(frame => JSON.parse(frame).type === 'terminal-lease')!).token as string

describe('terminal lease ownership and resource bounds', () => {
  const original = globalThis.Worker
  let leases: TerminalLeases
  beforeEach(() => {
    FakeWorker.instances = []
    globalThis.Worker = FakeWorker as unknown as typeof Worker
    leases = new TerminalLeases(() => {})
  })
  afterEach(async () => {
    const stopped = leases.shutdown()
    for (const worker of FakeWorker.instances) worker.emit({ type: 'stopped' })
    await stopped
    globalThis.Worker = original
  })

  test('queued obsolete-owner handshake cannot retire the replacement owner', () => {
    const old = socket(), next = socket()
    leases.handle(asSocket(old), { type: 'terminal-resume', claim: 1 })
    leases.handle(asSocket(next), { type: 'terminal-resume', token: token(old), claim: 2 })
    // Keep fake readyState OPEN to exercise ownership independently of close delivery.
    leases.handle(asSocket(old), { type: 'terminal-resume', token: 'unknown', claim: 3 })
    const worker = FakeWorker.instances[0]
    expect(worker.messages.some(message => message.type === 'shutdown')).toBe(false)
    leases.handle(asSocket(next), { type: 'terminal-attach', sessionId: 'agentboard:@1', attachId: 2 })
    expect(worker.messages.at(-1)?.type).toBe('message')
    expect(FakeWorker.instances).toHaveLength(1)
  })

  test('retiring workers consume capacity until disposal acknowledgment, then reuse', async () => {
    for (let i = 0; i < 32; i++) {
      const peer = socket()
      leases.handle(asSocket(peer), { type: 'terminal-attach', sessionId: 'agentboard:@1' })
      leases.close(asSocket(peer))
    }
    const blocked = socket()
    leases.handle(asSocket(blocked), { type: 'terminal-resume', claim: 1 })
    expect(blocked.closes).toContain(1013)
    expect(FakeWorker.instances).toHaveLength(32)
    FakeWorker.instances[0].emit({ type: 'stopped' })
    await Promise.resolve()
    const next = socket()
    leases.handle(asSocket(next), { type: 'terminal-resume', claim: 1 })
    expect(next.closes).toHaveLength(0)
    expect(FakeWorker.instances).toHaveLength(32)
  })

  test('unacknowledged parser output closes instead of dropping part of an ANSI stream', () => {
    const peer = socket()
    leases.handle(asSocket(peer), { type: 'terminal-resume', claim: 1 })
    const worker = FakeWorker.instances[0]
    const payload = JSON.stringify({ type: 'terminal-output', sessionId: 'agentboard:@1', attachId: 1, data: 'x'.repeat(600_000) })
    worker.emit({ type: 'send', epoch: 1, sequence: 1, payload })
    worker.emit({ type: 'send', epoch: 1, sequence: 2, payload })
    expect(peer.closes).toContain(1013)
    expect(peer.frames.filter(frame => JSON.parse(frame).type === 'terminal-output')).toHaveLength(1)
    expect(worker.messages.filter(message => message.type === 'credit')).toHaveLength(2)
  })

  test('relay catalog excludes transcript data and skips unchanged identities', () => {
    const sessions: Session[] = ['b', 'a'].map(id => ({ id, tmuxWindow: `agentboard:@${id}`, name: id, projectPath: '/tmp', status: 'unknown', createdAt: '', lastActivity: '', source: 'managed', lastUserMessage: 'private transcript' }))
    const client = new TerminalRelayClient({ port: 0, hostname: '127.0.0.1', upstreamPort: 1, tlsCert: '', tlsKey: '', terminalColorsEnabled: true }, sessions, () => {})
    const worker = FakeWorker.instances[0]
    const initial = worker.messages[0] as Extract<ParentToRelay, { type: 'init' }>
    expect(initial.sessions.map(session => session.id)).toEqual(['a', 'b'])
    expect(JSON.stringify(initial)).not.toContain('private transcript')
    client.post({ type: 'sessions', sessions: [...sessions].reverse(), terminalColorsEnabled: true })
    sessions[0].status = 'working'
    client.post({ type: 'sessions', sessions, terminalColorsEnabled: true })
    expect(worker.messages).toHaveLength(1)
    sessions[0].host = 'other-host'
    client.post({ type: 'sessions', sessions, terminalColorsEnabled: true })
    expect(worker.messages).toHaveLength(2)
    client.post({ type: 'sessions', sessions, terminalColorsEnabled: false })
    expect(worker.messages).toHaveLength(3)
  })

  test('single oversized dashboard frame is rejected before queueing', () => {
    const peer = socket()
    leases.send(asSocket(peer), 'x'.repeat(16 * 1024 * 1024 + 1))
    expect(peer.closes).toContain(1013)
    expect(peer.frames).toHaveLength(0)
  })
})
