import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import type { DevinSyncWorkerRequest, DevinSyncWorkerResponse } from '../devinSyncWorker'

class WorkerMock {
  static instances: WorkerMock[] = []
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null
  onmessageerror: (() => void) | null = null
  messages: unknown[] = []
  terminated = false

  constructor(public url: string, public options?: WorkerOptions) {
    WorkerMock.instances.push(this)
  }

  postMessage(payload: unknown) {
    this.messages.push(payload)
  }

  terminate() {
    this.terminated = true
  }

  emitMessage(data: DevinSyncWorkerResponse) {
    this.onmessage?.({ data } as MessageEvent)
  }

  emitError(message = 'worker error') {
    this.onerror?.(new ErrorEvent('error', { message }))
  }

  emitMessageError() {
    this.onmessageerror?.()
  }

  syncRequests(): Extract<DevinSyncWorkerRequest, { kind: 'sync' }>[] {
    return this.messages.filter(
      (m): m is Extract<DevinSyncWorkerRequest, { kind: 'sync' }> =>
        typeof m === 'object' && m !== null && (m as DevinSyncWorkerRequest).kind === 'sync'
    )
  }

  shutdownRequests(): Extract<DevinSyncWorkerRequest, { kind: 'shutdown' }>[] {
    return this.messages.filter(
      (m): m is Extract<DevinSyncWorkerRequest, { kind: 'shutdown' }> =>
        typeof m === 'object' && m !== null && (m as DevinSyncWorkerRequest).kind === 'shutdown'
    )
  }
}

const originalWorker = globalThis.Worker

let DevinSyncWorkerClient: typeof import('../devinSyncWorkerClient').DevinSyncWorkerClient
let DevinSyncWorkerTimeoutError: typeof import('../devinSyncWorkerClient').DevinSyncWorkerTimeoutError

beforeAll(async () => {
  globalThis.Worker = WorkerMock as unknown as typeof Worker
  const mod = await import('../devinSyncWorkerClient')
  DevinSyncWorkerClient = mod.DevinSyncWorkerClient
  DevinSyncWorkerTimeoutError = mod.DevinSyncWorkerTimeoutError
})

afterAll(() => {
  globalThis.Worker = originalWorker
})

beforeEach(() => {
  WorkerMock.instances = []
})

function lastWorker(): WorkerMock {
  const worker = WorkerMock.instances.at(-1)
  if (!worker) throw new Error('expected a spawned worker')
  return worker
}

describe('DevinSyncWorkerClient', () => {
  test('sync spawns the worker lazily and resolves with the result', async () => {
    const client = new DevinSyncWorkerClient()
    expect(WorkerMock.instances).toHaveLength(0)

    const promise = client.sync('/tmp/out')
    const worker = lastWorker()
    const request = worker.syncRequests().at(-1)
    expect(request?.outDir).toBe('/tmp/out')

    const result = { sessions: 3, rewritten: 1, appended: 2, removed: 0 }
    worker.emitMessage({ id: request!.id, type: 'result', result, durationMs: 42 })
    await expect(promise).resolves.toEqual({ result, durationMs: 42 })
    client.dispose()
  })

  test('sync rejects when the worker responds with an error', async () => {
    const client = new DevinSyncWorkerClient()
    const promise = client.sync('/tmp/out')
    const request = lastWorker().syncRequests().at(-1)!
    lastWorker().emitMessage({ id: request.id, type: 'error', error: 'sync blew up' })
    await expect(promise).rejects.toThrow('sync blew up')
    client.dispose()
  })

  test('concurrent syncs resolve independently by request id', async () => {
    const client = new DevinSyncWorkerClient()
    const first = client.sync('/tmp/a')
    const second = client.sync('/tmp/b')
    const worker = lastWorker()
    const [reqA, reqB] = worker.syncRequests()
    expect(reqA.id).not.toBe(reqB.id)

    // Respond out of order.
    worker.emitMessage({ id: reqB.id, type: 'result', result: null, durationMs: 2 })
    await expect(second).resolves.toEqual({ result: null, durationMs: 2 })
    worker.emitMessage({ id: reqA.id, type: 'result', result: null, durationMs: 5 })
    await expect(first).resolves.toEqual({ result: null, durationMs: 5 })
    client.dispose()
  })

  test('dispose rejects pending syncs, asks the worker to exit, and does not terminate it', async () => {
    const client = new DevinSyncWorkerClient()
    const promise = client.sync('/tmp/out')
    const worker = lastWorker()

    client.dispose()

    await expect(promise).rejects.toThrow('Devin sync worker disposed')
    // Cooperative shutdown, not terminate() — terminate segfaults compiled
    // Bun binaries (BUN-118B).
    expect(worker.terminated).toBe(false)
    expect(worker.shutdownRequests()).toHaveLength(1)
    expect(worker.onmessage).toBeNull()
    expect(worker.onerror).toBeNull()
  })

  test('dispose with no spawned worker is a no-op', () => {
    const client = new DevinSyncWorkerClient()
    client.dispose()
    expect(WorkerMock.instances).toHaveLength(0)
  })

  test('sync after dispose throws without spawning', async () => {
    const client = new DevinSyncWorkerClient()
    client.dispose()
    await expect(client.sync('/tmp/out')).rejects.toThrow('Devin sync worker is disposed')
    expect(WorkerMock.instances).toHaveLength(0)
  })

  test('a worker error rejects pending syncs and the next sync respawns', async () => {
    const client = new DevinSyncWorkerClient()
    const first = client.sync('/tmp/out')
    const crashed = lastWorker()

    crashed.emitError('boom')
    await expect(first).rejects.toThrow('boom')
    // The crashed worker is shut down cooperatively and detached.
    expect(crashed.shutdownRequests()).toHaveLength(1)
    expect(crashed.terminated).toBe(false)
    expect(crashed.onmessage).toBeNull()

    const second = client.sync('/tmp/out')
    expect(WorkerMock.instances).toHaveLength(2)
    const request = lastWorker().syncRequests().at(-1)!
    lastWorker().emitMessage({ id: request.id, type: 'result', result: null, durationMs: 1 })
    await expect(second).resolves.toEqual({ result: null, durationMs: 1 })
    client.dispose()
  })

  test('a messageerror rejects pending syncs and restarts the worker', async () => {
    const client = new DevinSyncWorkerClient()
    const first = client.sync('/tmp/out')
    lastWorker().emitMessageError()
    await expect(first).rejects.toThrow('Devin sync worker message error')

    void client.sync('/tmp/out').catch(() => {})
    expect(WorkerMock.instances).toHaveLength(2)
    client.dispose()
  })

  test('a timed-out sync rejects and restarts the worker', async () => {
    const client = new DevinSyncWorkerClient(25)
    const first = client.sync('/tmp/out')
    const stuck = lastWorker()

    await expect(first).rejects.toBeInstanceOf(DevinSyncWorkerTimeoutError)
    expect(stuck.shutdownRequests()).toHaveLength(1)
    expect(stuck.onmessage).toBeNull()

    void client.sync('/tmp/out').catch(() => {})
    expect(WorkerMock.instances).toHaveLength(2)
    client.dispose()
  })

  test('a late response from a detached worker does not resolve the retry', async () => {
    const client = new DevinSyncWorkerClient(25)
    const first = client.sync('/tmp/out')
    const stuck = lastWorker()
    const staleRequest = stuck.syncRequests().at(-1)!

    await expect(first).rejects.toBeInstanceOf(DevinSyncWorkerTimeoutError)

    // The detached worker's response must not resolve anything — and a new
    // sync on the fresh worker resolves normally.
    stuck.emitMessage({ id: staleRequest.id, type: 'result', result: null, durationMs: 999 })

    const second = client.sync('/tmp/out')
    const request = lastWorker().syncRequests().at(-1)!
    lastWorker().emitMessage({ id: request.id, type: 'result', result: null, durationMs: 7 })
    await expect(second).resolves.toEqual({ result: null, durationMs: 7 })
    client.dispose()
  })
})
