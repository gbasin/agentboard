import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { DiscoveryRpc } from '../mediaDiscoveryRpc'
import type { DiscoveryRequest, DiscoveryResponse } from '../mediaDiscoveryProtocol'

class FakeWorker {
  sent: DiscoveryRequest[] = []
  onmessage: ((event: MessageEvent<DiscoveryResponse>) => void) | null = null
  onerror: (() => void) | null = null
  onmessageerror: (() => void) | null = null
  closeListener: (() => void) | null = null
  throwOnPost = false
  postMessage(message: DiscoveryRequest) {
    if (this.throwOnPost) throw Error('Native worker is closed')
    this.sent.push(message)
  }
  addEventListener(type: string, listener: () => void) { if (type === 'close') this.closeListener = listener }
  reply(id: number, response: Omit<Extract<DiscoveryResponse, { value: unknown }>, 'id'> | { error: string; code?: string }) {
    this.onmessage?.({ data: { id, ...response } } as MessageEvent<DiscoveryResponse>)
  }
  requests() { return this.sent.filter((message): message is DiscoveryRequest & { id: number } => 'id' in message) }
}

let timers: Map<ReturnType<typeof setTimeout>, () => void>
let timerSpy: ReturnType<typeof spyOn<typeof globalThis, 'setTimeout'>>
let clearSpy: ReturnType<typeof spyOn<typeof globalThis, 'clearTimeout'>>
const instances: DiscoveryRpc[] = []
beforeEach(() => {
  timers = new Map()
  timerSpy = spyOn(globalThis, 'setTimeout').mockImplementation(((callback: () => void) => {
    const id = {} as ReturnType<typeof setTimeout>
    timers.set(id, callback)
    return id
  }) as typeof setTimeout)
  clearSpy = spyOn(globalThis, 'clearTimeout').mockImplementation(((id: ReturnType<typeof setTimeout>) => {
    timers.delete(id)
  }) as typeof clearTimeout)
})
afterEach(() => {
  for (const rpc of instances.splice(0)) rpc.dispose()
  timerSpy.mockRestore()
  clearSpy.mockRestore()
})
function fixture() {
  const worker = new FakeWorker(), failures: string[] = []
  const rpc = new DiscoveryRpc('mediaDiscoveryReaderWorker', 30_000, message => failures.push(message),
    () => worker as unknown as Worker)
  instances.push(rpc)
  return { rpc, worker, failures }
}
function request(rpc: DiscoveryRpc) {
  const promise = rpc.request({ kind: 'open', path: ':memory:' })
  void promise.catch(() => {})
  return promise
}
function expireAll() {
  const callbacks = Array.from(timers.values())
  timers.clear()
  for (const callback of callbacks) callback()
}

test('admission is bounded at 32 active worker requests and opens only when one settles', async () => {
  const { rpc, worker } = fixture()
  const requests = Array.from({ length: 32 }, () => request(rpc))
  await expect(request(rpc)).rejects.toThrow('Too many pending')
  expect(worker.requests()).toHaveLength(32)
  worker.reply(worker.requests()[0].id, { value: null })
  await requests[0]
  const next = request(rpc)
  expect(worker.requests()).toHaveLength(33)
  rpc.dispose()
  await Promise.allSettled([...requests, next])
})

test('timeout retains native work ownership, stalls dispatch and keeps whenIdle pending until replies', async () => {
  const { rpc, worker, failures } = fixture()
  const first = request(rpc), second = request(rpc)
  let idle = false
  const idlePromise = rpc.whenIdle().then(() => { idle = true })
  expireAll()
  await expect(first).rejects.toMatchObject({ code: 'MEDIA_TIMEOUT' })
  await expect(second).rejects.toMatchObject({ code: 'MEDIA_TIMEOUT' })
  await expect(request(rpc)).rejects.toThrow('still processing')
  expect(worker.requests()).toHaveLength(2)
  expect(failures).toHaveLength(2)
  expect(rpc.exited).toBe(false)
  expect(idle).toBe(false)
  worker.reply(worker.requests()[0].id, { value: null })
  await Promise.resolve()
  expect(idle).toBe(false)
  await expect(request(rpc)).rejects.toThrow('still processing')
  worker.reply(worker.requests()[1].id, { value: null })
  await idlePromise
  expect(idle).toBe(true)
  const third = request(rpc)
  expect(worker.requests()).toHaveLength(3)
  worker.reply(worker.requests()[2].id, { value: null })
  await third
})

test('typed worker errors preserve their code and release admission', async () => {
  const { rpc, worker } = fixture()
  const pending = request(rpc)
  worker.reply(worker.requests()[0].id, { error: 'Invalid cursor', code: 'INVALID_CURSOR' })
  await expect(pending).rejects.toMatchObject({ code: 'INVALID_CURSOR', message: 'Invalid cursor' })
  expect(timers.size).toBe(0)
  await rpc.whenIdle()
  expect(rpc.exited).toBe(false)
})

test('synchronous postMessage failure cleans up its timer and request slot without false exit', async () => {
  const { rpc, worker, failures } = fixture()
  worker.throwOnPost = true
  for (let i = 0; i < 40; i++) await expect(request(rpc)).rejects.toThrow('Native worker is closed')
  expect(timers.size).toBe(0)
  expect(worker.requests()).toHaveLength(0)
  expect(failures).toHaveLength(0)
  await rpc.whenIdle()
  expect(rpc.exited).toBe(false)
  worker.throwOnPost = false
  const pending = request(rpc)
  worker.reply(worker.requests()[0].id, { value: null })
  await pending
})

test('dispose rejects pending callers, settles waiters and requests shutdown without claiming exit', async () => {
  const { rpc, worker } = fixture()
  const pending = request(rpc), idle = rpc.whenIdle()
  rpc.dispose()
  await expect(pending).rejects.toThrow('disposed')
  await idle
  expect(timers.size).toBe(0)
  expect(worker.sent.filter(message => message.kind === 'shutdown')).toHaveLength(1)
  expect(rpc.exited).toBe(false)
  await expect(request(rpc)).rejects.toThrow('unavailable')
  rpc.dispose()
  expect(worker.sent.filter(message => message.kind === 'shutdown')).toHaveLength(1)
  worker.closeListener?.()
  expect(rpc.exited).toBe(true)
})

test('error and messageerror reject callers but only confirmed close marks native exit', async () => {
  for (const event of ['onerror', 'onmessageerror'] as const) {
    const { rpc, worker, failures } = fixture()
    const pending = request(rpc), idle = rpc.whenIdle()
    worker[event]?.()
    await expect(pending).rejects.toThrow('disposed')
    await idle
    expect(failures).toHaveLength(1)
    expect(rpc.exited).toBe(false)
    await expect(request(rpc)).rejects.toThrow('unavailable')
    worker.closeListener?.()
    expect(rpc.exited).toBe(true)
    expect(failures).toHaveLength(1)
  }
})

test('confirmed close rejects pending requests even when posting shutdown throws', async () => {
  const { rpc, worker, failures } = fixture()
  const pending = request(rpc), idle = rpc.whenIdle()
  worker.throwOnPost = true
  expect(() => worker.closeListener?.()).not.toThrow()
  await expect(pending).rejects.toThrow('disposed')
  await idle
  expect(rpc.exited).toBe(true)
  expect(timers.size).toBe(0)
  expect(failures).toEqual(['Media worker closed'])
})
