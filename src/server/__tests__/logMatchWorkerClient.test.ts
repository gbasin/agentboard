import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { MatchWorkerResponse } from '../logMatchWorkerClient'

class WorkerMock {
  static instances: WorkerMock[] = []
  static nextReady = true
  private _onmessage: ((event: MessageEvent) => void) | null = null
  private emitReady: boolean
  onerror: ((event: ErrorEvent) => void) | null = null
  onmessageerror: (() => void) | null = null
  lastMessage: unknown = null
  terminated = false

  constructor(public url: string, public options?: WorkerOptions) {
    WorkerMock.instances.push(this)
    this.emitReady = WorkerMock.nextReady
    WorkerMock.nextReady = true
  }

  get onmessage() {
    return this._onmessage
  }

  set onmessage(handler: ((event: MessageEvent) => void) | null) {
    this._onmessage = handler
    // Emit "ready" message when handler is set, like the real worker does
    if (handler && this.emitReady) {
      queueMicrotask(() => {
        handler({ data: { type: 'ready' } } as MessageEvent)
      })
    }
  }

  postMessage(payload: unknown) {
    this.lastMessage = payload
  }

  terminate() {
    this.terminated = true
  }

  emitMessage(data: MatchWorkerResponse) {
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

let LogMatchWorkerClient: typeof import('../logMatchWorkerClient').LogMatchWorkerClient

beforeAll(async () => {
  globalThis.Worker = WorkerMock as unknown as typeof Worker
  LogMatchWorkerClient = (await import('../logMatchWorkerClient')).LogMatchWorkerClient
})

afterAll(() => {
  globalThis.Worker = originalWorker
})

// Helper to wait for worker to receive message
async function waitForMessage(worker: WorkerMock, maxWait = 100): Promise<{ id: string }> {
  const start = Date.now()
  while (!worker.lastMessage && Date.now() - start < maxWait) {
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  const payload = worker.lastMessage as { id: string } | null
  if (!payload?.id) throw new Error('Missing request id')
  return payload
}

describe('LogMatchWorkerClient', () => {
  test('poll resolves when worker responds', async () => {
    const client = new LogMatchWorkerClient()
    const worker = WorkerMock.instances[WorkerMock.instances.length - 1]
    if (!worker) throw new Error('Worker not created')

    const promise = client.poll({
      windows: [],
      maxLogsPerPoll: 1,
      sessions: [],
      scrollbackLines: 10,
    })

    const payload = await waitForMessage(worker)
    worker.emitMessage({ id: payload.id, type: 'result', entries: [] })

    const result = await promise
    expect(result.type).toBe('result')
    expect(result.entries).toEqual([])
  })

  test('poll rejects on error response', async () => {
    const client = new LogMatchWorkerClient()
    const worker = WorkerMock.instances[WorkerMock.instances.length - 1]
    if (!worker) throw new Error('Worker not created')

    const promise = client.poll({
      windows: [],
      maxLogsPerPoll: 1,
      sessions: [],
      scrollbackLines: 10,
    })

    const payload = await waitForMessage(worker)
    worker.emitMessage({ id: payload.id, type: 'error', error: 'boom' })

    await expect(promise).rejects.toThrow('boom')
  })

  test('dispose rejects pending requests and terminates worker', async () => {
    const client = new LogMatchWorkerClient()
    const worker = WorkerMock.instances[WorkerMock.instances.length - 1]
    if (!worker) throw new Error('Worker not created')

    const promise = client.poll({
      windows: [],
      maxLogsPerPoll: 1,
      sessions: [],
      scrollbackLines: 10,
    })

    // Wait for message to be posted, then dispose
    await waitForMessage(worker)
    client.dispose()

    await expect(promise).rejects.toThrow('Log match worker is disposed')
    expect(worker.terminated).toBe(true)
  })

  test('dispose during readiness wait rejects poll immediately', async () => {
    WorkerMock.nextReady = false
    const client = new LogMatchWorkerClient()

    const promise = client.poll({
      windows: [],
      maxLogsPerPoll: 1,
      sessions: [],
      scrollbackLines: 10,
    })

    client.dispose()

    await expect(promise).rejects.toThrow('Log match worker is disposed')
  })

  test('worker errors reject pending and restart worker', async () => {
    const client = new LogMatchWorkerClient()
    const worker = WorkerMock.instances[WorkerMock.instances.length - 1]
    if (!worker) throw new Error('Worker not created')
    const instancesBefore = WorkerMock.instances.length

    const promise = client.poll({
      windows: [],
      maxLogsPerPoll: 1,
      sessions: [],
      scrollbackLines: 10,
    })

    // Wait for message to be posted, then emit error
    await waitForMessage(worker)
    worker.emitError('broken')

    await expect(promise).rejects.toThrow('Log match worker error')
    expect(worker.terminated).toBe(true)
    expect(WorkerMock.instances.length).toBe(instancesBefore + 1)
  })

  test('message errors restart worker and fail pending', async () => {
    const client = new LogMatchWorkerClient()
    const worker = WorkerMock.instances[WorkerMock.instances.length - 1]
    if (!worker) throw new Error('Worker not created')
    const instancesBefore = WorkerMock.instances.length

    const promise = client.poll({
      windows: [],
      maxLogsPerPoll: 1,
      sessions: [],
      scrollbackLines: 10,
    })

    // Wait for message to be posted, then emit error
    await waitForMessage(worker)
    worker.emitMessageError()

    await expect(promise).rejects.toThrow('Log match worker message error')
    expect(worker.terminated).toBe(true)
    expect(WorkerMock.instances.length).toBe(instancesBefore + 1)
  })
})
