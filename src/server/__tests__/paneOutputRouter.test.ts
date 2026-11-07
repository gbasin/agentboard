import { expect, test } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { PaneOutputRouter } from '../relay/paneOutputRouter'
import { privateTmuxEnv } from './testEnvironment'

function fakeWorker() {
  const messages: unknown[] = []
  const worker = { onmessage: null, onerror: null, postMessage: (message: unknown) => messages.push(message) } as unknown as Worker
  return { worker, messages, emit: (message: unknown) => worker.onmessage?.({ data: message } as MessageEvent) }
}
const subscribe = { type: 'pane-subscribe' as const, id: 'test', key: 'key', target: '%0' }

test('router startup failures reject subscription and leave disposal acknowledgeable', () => {
  const peer = fakeWorker()
  const router = new PaneOutputRouter(() => {}, () => { throw new Error('startup failed') })
  router.handle(peer.worker, subscribe)
  expect(peer.messages).toEqual([{ type: 'pane-error', id: 'test', error: 'Error: startup failed' }])
  router.handle(peer.worker, { type: 'pane-release', id: 'test' })
  expect(peer.messages.at(-1)).toEqual({ type: 'pane-released', id: 'test' })
})

test('router post failures roll back the pending subscription', () => {
  const peer = fakeWorker()
  const broker = fakeWorker()
  broker.worker.postMessage = () => { throw new Error('post failed') }
  const router = new PaneOutputRouter(() => {}, () => broker.worker)
  router.handle(peer.worker, subscribe)
  router.handle(peer.worker, { type: 'pane-release', id: 'test' })
  expect(peer.messages).toEqual([{ type: 'pane-error', id: 'test', error: 'Error: post failed' }, { type: 'pane-released', id: 'test' }])
})

test('router shutdown shares one acknowledgment and rejects new subscriptions', async () => {
  const peer = fakeWorker()
  const broker = fakeWorker()
  const router = new PaneOutputRouter(() => {}, () => broker.worker)
  router.handle(peer.worker, subscribe)
  const first = router.shutdown()
  expect(router.shutdown()).toBe(first)
  router.handle(peer.worker, { ...subscribe, id: 'late' })
  expect(peer.messages.at(-1)).toEqual({ type: 'pane-error', id: 'late', error: 'Pane output unavailable' })
  broker.emit({ type: 'pane-stopped' })
  await first
  expect(broker.messages.filter((message: any) => message.type === 'pane-shutdown')).toHaveLength(1)
})

test('broker failure rejects requests, reaps reported private resources, then fails service', async () => {
  const peer = fakeWorker()
  const broker = fakeWorker()
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ab-router-fatal-'))
  const tail = Bun.spawn(['sleep', '30'], { env: privateTmuxEnv(null), stdout: 'ignore', stderr: 'ignore' })
  let failed!: () => void
  const fatal = new Promise<void>(resolve => { failed = resolve })
  const router = new PaneOutputRouter(() => failed(), () => broker.worker)
  try {
    router.handle(peer.worker, subscribe)
    broker.emit({ type: 'pane-resource', key: 'fake-no-tmux-epoch', target: '%0', root, pid: tail.pid })
    broker.worker.onerror?.(new ErrorEvent('error'))
    await fatal
    await tail.exited
    expect(tail.signalCode).toBe('SIGTERM')
    await expect(fs.access(root)).rejects.toBeDefined()
    expect(peer.messages.at(-1)).toEqual({ type: 'pane-error', id: 'test', error: 'Pane output worker stopped' })
    router.handle(peer.worker, { ...subscribe, id: 'replacement' })
    expect(peer.messages.at(-1)).toEqual({ type: 'pane-error', id: 'replacement', error: 'Pane output unavailable' })
    await router.shutdown()
  } finally { try { tail.kill() } catch {} await fs.rm(root, { recursive: true, force: true }) }
})
