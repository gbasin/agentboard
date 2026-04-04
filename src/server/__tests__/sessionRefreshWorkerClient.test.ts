import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import type { RefreshWorkerResponse } from '../sessionRefreshWorker'

class WorkerMock {
  static instances: WorkerMock[] = []
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null
  onmessageerror: (() => void) | null = null
  lastMessage: unknown = null
  terminated = false

  constructor(public url: string, public options?: WorkerOptions) {
    WorkerMock.instances.push(this)
  }

  postMessage(payload: unknown) {
    this.lastMessage = payload
  }

  terminate() {
    this.terminated = true
  }

  emitMessage(data: RefreshWorkerResponse) {
    this.onmessage?.({ data } as MessageEvent)
  }

  emitError(message = 'worker error') {
    this.onerror?.({ message } as ErrorEvent)
  }

  emitMessageError() {
    this.onmessageerror?.()
  }
}

const originalWorker = globalThis.Worker
const originalSetTimeout = globalThis.setTimeout
const originalClearTimeout = globalThis.clearTimeout

let SessionRefreshWorkerClient: typeof import('../sessionRefreshWorkerClient').SessionRefreshWorkerClient

beforeAll(async () => {
  globalThis.Worker = WorkerMock as unknown as typeof Worker
  SessionRefreshWorkerClient = (await import('../sessionRefreshWorkerClient'))
    .SessionRefreshWorkerClient
})

afterAll(() => {
  globalThis.Worker = originalWorker
})

afterEach(() => {
  globalThis.setTimeout = originalSetTimeout
  globalThis.clearTimeout = originalClearTimeout
  WorkerMock.instances = []
})

describe('SessionRefreshWorkerClient', () => {
  test('refresh resolves when worker responds', async () => {
    const client = new SessionRefreshWorkerClient()
    const worker = WorkerMock.instances[WorkerMock.instances.length - 1]
    if (!worker) throw new Error('Worker not created')

    const promise = client.refresh('agentboard', [])

    const payload = worker.lastMessage as { id: string } | null
    if (!payload?.id) throw new Error('Missing request id')

    worker.emitMessage({
      id: payload.id,
      kind: 'refresh',
      type: 'result',
      sessions: [],
    })

    const result = await promise
    expect(result).toEqual([])
  })

  test('refresh rejects on error response', async () => {
    const client = new SessionRefreshWorkerClient()
    const worker = WorkerMock.instances[WorkerMock.instances.length - 1]
    if (!worker) throw new Error('Worker not created')

    const promise = client.refresh('agentboard', [])

    const payload = worker.lastMessage as { id: string } | null
    if (!payload?.id) throw new Error('Missing request id')

    worker.emitMessage({ id: payload.id, kind: 'error', type: 'error', error: 'boom' })

    await expect(promise).rejects.toThrow('boom')
  })

  test('getLastUserMessage resolves with the worker response', async () => {
    const client = new SessionRefreshWorkerClient()
    const worker = WorkerMock.instances[WorkerMock.instances.length - 1]
    if (!worker) throw new Error('Worker not created')

    const promise = client.getLastUserMessage('agentboard:1')

    const payload = worker.lastMessage as { id: string } | null
    if (!payload?.id) throw new Error('Missing request id')

    worker.emitMessage({
      id: payload.id,
      kind: 'last-user-message',
      type: 'result',
      message: 'hello',
    })

    await expect(promise).resolves.toBe('hello')
  })

  test('dispose rejects pending requests and abandons worker', async () => {
    const client = new SessionRefreshWorkerClient()
    const worker = WorkerMock.instances[WorkerMock.instances.length - 1]
    if (!worker) throw new Error('Worker not created')

    const promise = client.refresh('agentboard', [])

    client.dispose()

    await expect(promise).rejects.toThrow('Session refresh worker disposed')
    // Worker is abandoned, not terminated (Bun bug BUN-118B)
    expect(worker.terminated).toBe(false)
  })

  test('worker errors reject pending and restart worker', async () => {
    const client = new SessionRefreshWorkerClient()
    const worker = WorkerMock.instances[WorkerMock.instances.length - 1]
    if (!worker) throw new Error('Worker not created')
    const instancesBefore = WorkerMock.instances.length

    const promise = client.refresh('agentboard', [])

    worker.emitError('broken')

    await expect(promise).rejects.toThrow('Session refresh worker error')
    // Worker is abandoned, not terminated (Bun bug BUN-118B)
    expect(worker.terminated).toBe(false)
    expect(WorkerMock.instances.length).toBe(instancesBefore + 1)
  })

  test('message errors restart worker and fail pending', async () => {
    const client = new SessionRefreshWorkerClient()
    const worker = WorkerMock.instances[WorkerMock.instances.length - 1]
    if (!worker) throw new Error('Worker not created')
    const instancesBefore = WorkerMock.instances.length

    const promise = client.refresh('agentboard', [])

    worker.emitMessageError()

    await expect(promise).rejects.toThrow('Session refresh worker message error')
    // Worker is abandoned, not terminated (Bun bug BUN-118B)
    expect(worker.terminated).toBe(false)
    expect(WorkerMock.instances.length).toBe(instancesBefore + 1)
  })

  test('refresh timeouts restart worker and fail pending request', async () => {
    globalThis.setTimeout = ((((callback: TimerHandler) => {
      queueMicrotask(() => {
        if (typeof callback === 'function') {
          callback()
        }
      })
      return 1 as unknown as ReturnType<typeof setTimeout>
    }) as unknown) as typeof setTimeout)
    globalThis.clearTimeout = (() => {}) as typeof clearTimeout

    const client = new SessionRefreshWorkerClient()
    const worker = WorkerMock.instances[WorkerMock.instances.length - 1]
    if (!worker) throw new Error('Worker not created')
    const instancesBefore = WorkerMock.instances.length

    const promise = client.refresh('agentboard', [])

    await expect(promise).rejects.toThrow('Session refresh worker timed out')
    expect(worker.terminated).toBe(false)
    expect(WorkerMock.instances.length).toBe(instancesBefore + 1)
  })

  test('refresh timeout scales with expected window count', async () => {
    const timeoutDelays: number[] = []
    globalThis.setTimeout = ((((_callback: TimerHandler, delay?: number) => {
      timeoutDelays.push(Number(delay))
      return 1 as unknown as ReturnType<typeof setTimeout>
    }) as unknown) as typeof setTimeout)
    globalThis.clearTimeout = (() => {}) as typeof clearTimeout

    const client = new SessionRefreshWorkerClient()
    const promise = client.refresh('agentboard', [], { expectedWindowCount: 20 })
    client.dispose()

    await expect(promise).rejects.toThrow('Session refresh worker disposed')
    expect(timeoutDelays[0]).toBe(77000)
  })

  test('late errors from an abandoned worker do not fail the replacement worker', async () => {
    const timeoutCallbacks: Array<() => void> = []
    globalThis.setTimeout = ((((callback: TimerHandler) => {
      if (typeof callback === 'function') {
        timeoutCallbacks.push(callback as () => void)
      }
      return timeoutCallbacks.length as unknown as ReturnType<typeof setTimeout>
    }) as unknown) as typeof setTimeout)
    globalThis.clearTimeout = (() => {}) as typeof clearTimeout

    const client = new SessionRefreshWorkerClient()
    const originalWorker = WorkerMock.instances[WorkerMock.instances.length - 1]
    if (!originalWorker) throw new Error('Worker not created')

    const firstPromise = client.refresh('agentboard', [])
    const firstTimeout = timeoutCallbacks.shift()
    if (!firstTimeout) throw new Error('Timeout not scheduled')
    firstTimeout()

    await expect(firstPromise).rejects.toThrow('Session refresh worker timed out')

    const replacementWorker = WorkerMock.instances[WorkerMock.instances.length - 1]
    if (!replacementWorker || replacementWorker === originalWorker) {
      throw new Error('Replacement worker not created')
    }

    const secondPromise = client.refresh('agentboard', [])
    const secondPayload = replacementWorker.lastMessage as { id: string } | null
    if (!secondPayload?.id) throw new Error('Missing second request id')

    originalWorker.emitError('old worker error')
    replacementWorker.emitMessage({
      id: secondPayload.id,
      kind: 'refresh',
      type: 'result',
      sessions: [],
    })

    await expect(secondPromise).resolves.toEqual([])
  })

  test('calls after dispose throw', async () => {
    const client = new SessionRefreshWorkerClient()
    client.dispose()

    await expect(client.refresh('agentboard', [])).rejects.toThrow(
      'Session refresh worker is disposed'
    )
    await expect(client.getLastUserMessage('agentboard:1')).rejects.toThrow(
      'Session refresh worker is disposed'
    )
  })
})
