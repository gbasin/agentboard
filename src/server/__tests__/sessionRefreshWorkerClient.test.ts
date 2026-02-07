import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
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

let SessionRefreshWorkerClient: typeof import('../sessionRefreshWorkerClient').SessionRefreshWorkerClient

beforeAll(async () => {
  globalThis.Worker = WorkerMock as unknown as typeof Worker
  SessionRefreshWorkerClient = (await import('../sessionRefreshWorkerClient'))
    .SessionRefreshWorkerClient
})

afterAll(() => {
  globalThis.Worker = originalWorker
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
