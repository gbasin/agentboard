import { afterEach, expect, test } from 'bun:test'
import type { Session } from '../../shared/types'
import type { ITerminalProxy, TerminalProxyOptions } from '../terminal'
import { TerminalRuntime, createTerminalPeerData, type TerminalPeer } from '../relay/terminalRuntime'
import { parseRelayBuffers } from '../relay/terminalRuntimeClipboard'
import { config } from '../config'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(yes => { resolve = yes })
  return { promise, resolve }
}

class Proxy implements ITerminalProxy {
  started = false
  starts = 0
  disposed = false
  physical = ''
  switches: string[] = []
  writes: Array<{ target: string; data: string }> = []
  pastes: string[] = []
  dimensions: number[][] = []
  afterSwitch: Promise<void> | null = null
  queue = Promise.resolve(true)
  constructor(readonly options: TerminalProxyOptions) {}
  async start() { if (!this.started) { this.started = true; this.starts++ } }
  switchTo(target: string, onReady?: () => void) {
    const hold = this.afterSwitch
    this.afterSwitch = null
    this.queue = this.queue.then(async () => {
      this.physical = target
      this.switches.push(target)
      await hold
      onReady?.()
      this.options.onData(`redraw:${target}`)
      return true
    })
    return this.queue
  }
  ensureEffectiveTarget(target: string) { return target }
  write(data: string) { this.writes.push({ target: this.physical, data }) }
  paste(data: string) { this.pastes.push(data) }
  resize(cols: number, rows: number) { this.dimensions.push([cols, rows]) }
  async dispose() { this.disposed = true; this.options.onExit?.() }
  isReady() { return this.started && !this.disposed }
  getClientTty() { return 'test-tty' }
  getCurrentWindow() { return this.physical }
  getSessionName() { return 'test-relay' }
  getMode(): 'pty' { return 'pty' }
}

const active: Array<{ runtime: TerminalRuntime; peer: TerminalPeer }> = []
afterEach(async () => { for (const value of active.splice(0)) await value.runtime.dispose(value.peer) })

function fixture() {
  const sessions = new Map<string, Session>(['A', 'B'].map((id, i) => [id, {
    id, name: id, tmuxWindow: `board:@${i}`, projectPath: '/tmp', status: 'unknown', lastActivity: '', createdAt: '', source: 'managed',
  }]))
  const messages: Array<Record<string, unknown>> = []
  const proxies: Proxy[] = []
  const submissions: string[] = []
  const clipboard: string[] = []
  const copyChecks: string[] = []
  const copyCancels: string[] = []
  let captureHold: Promise<void> | null = null
  let cancelHold: Promise<void> = Promise.resolve()
  const peer: TerminalPeer = { data: createTerminalPeerData('test'), readyState: 1, send: raw => messages.push(JSON.parse(raw)) }
  const runtime = new TerminalRuntime({
    getSession: id => sessions.get(id),
    createProxy: options => { const proxy = new Proxy(options); proxies.push(proxy); return proxy },
    capture: async target => { await captureHold; return `snapshot:${target}` },
    cancelCopyMode: (_peer, session) => { copyCancels.push(session.id); return cancelHold },
    checkCopyMode: async (_peer, session) => { copyChecks.push(session.id) },
    onSubmit: id => submissions.push(id),
    clipboard: { start: (_peer, session) => clipboard.push(`start:${session.id}`), stop: () => clipboard.push('stop'), arm: () => clipboard.push('arm') },
  })
  active.push({ runtime, peer })
  const attach = (id: string, attachId: number) => runtime.handle(peer, { type: 'terminal-attach', sessionId: id, attachId, cols: 80, rows: 24 })
  const input = (id: string, attachId: number, data = 'input') => runtime.handle(peer, { type: 'terminal-input', sessionId: id, attachId, data })
  return { sessions, messages, proxies, submissions, clipboard, copyChecks, copyCancels, peer, runtime, attach, input, holdCapture: (hold: Promise<void> | null) => { captureHold = hold }, holdCancel: (hold: Promise<void>) => { cancelHold = hold } }
}

async function until(predicate: () => boolean) {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await Bun.sleep(1) }
  throw new Error('Runtime did not reach expected state')
}

test('ready follows snapshot and verified redraw; early and stale input are rejected', async () => {
  const f = fixture(), capture = deferred()
  f.holdCapture(capture.promise)
  f.attach('A', 1)
  f.input('A', 1, 'early')
  capture.resolve()
  await until(() => f.peer.data.inputReady)
  expect(f.proxies[0].writes).toEqual([])
  expect(f.messages.map(m => m.type)).toEqual(['terminal-output', 'terminal-output', 'terminal-ready'])
  expect(f.messages.every(m => m.attachId === 1)).toBe(true)
  f.input('A', 0, 'old'); f.input('B', 1, 'wrong-target'); f.input('A', 1, 'current')
  expect(f.proxies[0].writes).toEqual([{ target: 'board:@0', data: 'current' }])
})

test('retained observer is reverified after replacement interrupts physical switch', async () => {
  const f = fixture()
  f.attach('A', 1)
  await until(() => f.peer.data.inputReady)
  const proxy = f.proxies[0], switched = deferred()
  proxy.afterSwitch = switched.promise
  f.attach('B', 2)
  await until(() => proxy.physical === 'board:@1')
  f.runtime.suspend(f.peer)
  f.attach('A', 3)
  f.input('A', 3, 'too-soon')
  switched.resolve()
  await until(() => f.peer.data.inputReady)
  expect(proxy.physical).toBe('board:@0')
  expect(proxy.switches).toEqual(['board:@0', 'board:@1', 'board:@0'])
  expect(proxy.starts).toBe(1)
  expect(f.messages.filter(m => m.type === 'terminal-ready').map(m => m.attachId)).toEqual([1, 3])
  f.input('B', 2, 'old-owner'); f.input('A', 3, 'current-owner')
  expect(proxy.writes).toEqual([{ target: 'board:@0', data: 'current-owner' }])
})

test('rapid A-B-A cannot publish an earlier A as the current attachment', async () => {
  const f = fixture(), capture = deferred()
  f.holdCapture(capture.promise)
  f.attach('A', 1); f.attach('B', 2); f.attach('A', 3)
  capture.resolve()
  await until(() => f.peer.data.inputReady)
  expect(f.messages.filter(m => m.type === 'terminal-ready').map(m => m.attachId)).toEqual([3])
  f.input('A', 1, 'obsolete-A')
  expect(f.proxies[0].writes).toHaveLength(0)
})

test('disposal fences pending output and destroys only the observer', async () => {
  const f = fixture()
  f.attach('A', 1)
  await until(() => f.peer.data.inputReady)
  const proxy = f.proxies[0]
  await f.runtime.dispose(f.peer)
  f.messages.length = 0
  proxy.options.onData('late output'); proxy.options.onExit?.()
  expect(f.messages).toHaveLength(0)
  expect(proxy.disposed).toBe(true)
  expect(f.sessions.size).toBe(2)
})

test('paste preserves multiline text without triggering submit; resize and stale commands are gated', async () => {
  const f = fixture()
  f.attach('A', 1)
  await until(() => f.peer.data.inputReady)
  f.runtime.handle(f.peer, { type: 'terminal-paste', sessionId: 'A', attachId: 1, data: 'one\ntwo' })
  expect(f.proxies[0].pastes).toEqual(['one\ntwo'])
  expect(f.submissions).toEqual([])
  f.input('A', 1, '\r')
  expect(f.submissions).toEqual(['A'])
  f.runtime.handle(f.peer, { type: 'terminal-resize', sessionId: 'A', attachId: 0, cols: 9, rows: 9 })
  f.runtime.handle(f.peer, { type: 'terminal-resize', sessionId: 'A', attachId: 1, cols: -1, rows: 9 })
  f.runtime.handle(f.peer, { type: 'terminal-resize', sessionId: 'A', attachId: 1, cols: 90, rows: 30 })
  expect(f.proxies[0].dimensions).toEqual([[80, 24], [90, 30]])
})

test('catalog target override and deleted target cannot become input-ready', async () => {
  const f = fixture()
  f.runtime.handle(f.peer, { type: 'terminal-attach', sessionId: 'A', attachId: 1, tmuxTarget: 'board:@1' })
  expect(f.messages[0].type).toBe('terminal-error')
  expect(f.proxies).toHaveLength(0)
  const capture = deferred()
  f.holdCapture(capture.promise)
  f.attach('A', 2)
  await until(() => f.proxies.length === 1)
  f.sessions.delete('A')
  capture.resolve()
  await until(() => f.messages.length > 1)
  expect(f.peer.data.inputReady).toBe(false)
  expect(f.messages.some(m => m.type === 'terminal-ready')).toBe(false)
})

test('copy-mode cancellation precedes queued typing; a disconnect drops that queued input', async () => {
  const f = fixture(), cancel = deferred()
  f.attach('A', 1)
  await until(() => f.peer.data.inputReady)
  f.holdCancel(cancel.promise)
  f.runtime.handle(f.peer, { type: 'tmux-cancel-copy-mode', sessionId: 'A', attachId: 1 })
  f.input('A', 1, 'first'); f.input('A', 1, 'second')
  expect(f.proxies[0].writes).toHaveLength(0)
  cancel.resolve()
  await until(() => f.proxies[0].writes.length === 2)
  expect(f.proxies[0].writes.map(w => w.data)).toEqual(['first', 'second'])
  const abandoned = deferred()
  f.holdCancel(abandoned.promise)
  f.runtime.handle(f.peer, { type: 'tmux-cancel-copy-mode', sessionId: 'A', attachId: 1 })
  f.input('A', 1, 'abandoned')
  f.runtime.suspend(f.peer)
  f.attach('B', 2)
  abandoned.resolve()
  await until(() => f.peer.data.inputReady)
  f.input('B', 2, 'new-target')
  expect(f.proxies[0].writes).toEqual([
    { target: 'board:@0', data: 'first' }, { target: 'board:@0', data: 'second' }, { target: 'board:@1', data: 'new-target' },
  ])
})

test('remote attach restrictions apply before proxy construction', () => {
  const f = fixture(), previous = config.remoteAllowAttach
  config.remoteAllowAttach = false
  try {
    f.sessions.set('A', { ...f.sessions.get('A')!, remote: true, host: 'example' })
    f.attach('A', 1)
    expect(f.proxies).toHaveLength(0)
    expect(f.messages[0].type).toBe('terminal-error')
  } finally { config.remoteAllowAttach = previous }
})

test('local to remote switch replaces the observer and preserves SSH input policy', async () => {
  const f = fixture(), previous = config.remoteAllowAttach
  config.remoteAllowAttach = true
  try {
    f.attach('A', 1)
    await until(() => f.peer.data.inputReady)
    const local = f.proxies[0]
    f.sessions.set('B', { ...f.sessions.get('B')!, remote: true, host: 'remote-host' })
    f.attach('B', 2)
    await until(() => f.peer.data.inputReady)
    expect(local.disposed).toBe(true)
    expect(f.proxies[1].options.host).toBe('remote-host')
    expect(f.peer.data.terminalHost).toBe('remote-host')
    f.messages.length = 0
    local.options.onData('old local bytes'); local.options.onExit?.()
    expect(f.messages).toHaveLength(0)
    f.input('B', 2, '\r')
    expect(f.proxies[1].writes).toEqual([{ target: 'board:@1', data: '\r' }])
    expect(f.submissions).toEqual([])
  } finally { config.remoteAllowAttach = previous }
})

test('a proxy that declines a switch cannot publish ready', async () => {
  const f = fixture(), capture = deferred()
  f.holdCapture(capture.promise)
  f.attach('A', 1)
  await until(() => f.proxies.length === 1)
  f.proxies[0].switchTo = async () => false
  capture.resolve()
  await until(() => f.messages.some(m => m.type === 'terminal-error'))
  expect(f.peer.data.inputReady).toBe(false)
  expect(f.messages.some(m => m.type === 'terminal-ready')).toBe(false)
})

test('clipboard summary ordering retains automatic-buffer creation semantics', () => {
  const result = parseRelayBuffers('buffer0001\t10\t500\nbuffer0002\t10\t2\nnamed999\t10\t1\nbad\tno\t3\n')
  expect(result.map(b => b.name)).toEqual(['buffer0002', 'buffer0001', 'named999'])
})

test('catalog remap after ready fences every scoped operation against attached identity', async () => {
  const operations = ['input', 'paste', 'resize', 'check', 'cancel', 'output'] as const
  const changes: Array<Partial<Session>> = [{ tmuxWindow: 'board:@9' }, { host: 'other-host' }, { remote: true }]
  for (const change of changes) {
    for (const operation of operations) {
      const f = fixture()
      f.attach('A', 1)
      await until(() => f.peer.data.inputReady)
      f.messages.length = 0
      f.sessions.set('A', { ...f.sessions.get('A')!, ...change })
      if (operation === 'input') f.input('A', 1, 'wrong-identity')
      if (operation === 'paste') f.runtime.handle(f.peer, { type: 'terminal-paste', sessionId: 'A', attachId: 1, data: 'wrong-identity' })
      if (operation === 'resize') f.runtime.handle(f.peer, { type: 'terminal-resize', sessionId: 'A', attachId: 1, cols: 99, rows: 30 })
      if (operation === 'check') f.runtime.handle(f.peer, { type: 'tmux-check-copy-mode', sessionId: 'A', attachId: 1 })
      if (operation === 'cancel') f.runtime.handle(f.peer, { type: 'tmux-cancel-copy-mode', sessionId: 'A', attachId: 1 })
      if (operation === 'output') f.proxies[0].options.onData('obsolete-output')
      await Bun.sleep(0)
      expect(f.proxies[0].writes).toHaveLength(0)
      expect(f.proxies[0].pastes).toHaveLength(0)
      expect(f.proxies[0].dimensions).toEqual([[80, 24]])
      expect(f.copyChecks).toHaveLength(0)
      expect(f.copyCancels).toHaveLength(0)
      expect(f.messages.some(m => m.type === 'terminal-output')).toBe(false)
      expect(f.peer.data.inputReady).toBe(false)
    }
  }
})

test('pending input and copy cancellation cannot act after a catalog remap', async () => {
  const f = fixture(), cancel = deferred()
  f.attach('A', 1)
  await until(() => f.peer.data.inputReady)
  f.holdCancel(cancel.promise)
  f.runtime.handle(f.peer, { type: 'tmux-cancel-copy-mode', sessionId: 'A', attachId: 1 })
  await until(() => f.copyCancels.length === 1)
  f.input('A', 1, 'queued-before-remap')
  f.runtime.handle(f.peer, { type: 'tmux-cancel-copy-mode', sessionId: 'A', attachId: 1 })
  f.sessions.set('A', { ...f.sessions.get('A')!, tmuxWindow: 'board:@9' })
  cancel.resolve()
  await until(() => !f.peer.data.inputReady)
  expect(f.proxies[0].writes).toHaveLength(0)
  expect(f.copyCancels).toHaveLength(1)
})

test('in-place catalog mutation during capture cannot redefine the captured identity', async () => {
  const f = fixture(), capture = deferred()
  f.holdCapture(capture.promise)
  f.attach('A', 1)
  await until(() => f.proxies.length === 1)
  f.sessions.get('A')!.tmuxWindow = 'board:@9'
  capture.resolve()
  await until(() => f.messages.some(m => m.type === 'terminal-error'))
  expect(f.messages.some(m => m.type === 'terminal-ready' || m.type === 'terminal-output')).toBe(false)
  expect(f.peer.data.inputReady).toBe(false)
})
