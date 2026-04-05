import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import type { RefreshWorkerResponse } from '../sessionRefreshWorker'
import { config } from '../config'
import { TMUX_TIMEOUT_ERROR_CODE } from '../tmuxTimeout'

class WorkerMock {
  static instances: WorkerMock[] = []
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null
  onmessageerror: (() => void) | null = null
  messages: unknown[] = []
  lastMessage: unknown = null
  terminated = false

  constructor(public url: string, public options?: WorkerOptions) {
    WorkerMock.instances.push(this)
  }

  postMessage(payload: unknown) {
    this.messages.push(payload)
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
let SessionRefreshWorkerTimeoutError: typeof import('../sessionRefreshWorkerClient').SessionRefreshWorkerTimeoutError

function captureTimeoutDelays(): number[] {
  const timeoutDelays: number[] = []
  globalThis.setTimeout = ((((_callback: TimerHandler, delay?: number) => {
    timeoutDelays.push(Number(delay))
    return 1 as unknown as ReturnType<typeof setTimeout>
  }) as unknown) as typeof setTimeout)
  globalThis.clearTimeout = (() => {}) as typeof clearTimeout
  return timeoutDelays
}

function expectScheduledTimeout(timeoutDelays: number[], expectedDelay: number) {
  expect(timeoutDelays.filter(Number.isFinite)).toContain(expectedDelay)
}

beforeAll(async () => {
  globalThis.Worker = WorkerMock as unknown as typeof Worker
  const mod = await import('../sessionRefreshWorkerClient')
  SessionRefreshWorkerClient = mod.SessionRefreshWorkerClient
  SessionRefreshWorkerTimeoutError = mod.SessionRefreshWorkerTimeoutError
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

  test('refresh preserves tmux timeout classification from worker responses', async () => {
    const client = new SessionRefreshWorkerClient()
    const worker = WorkerMock.instances[WorkerMock.instances.length - 1]
    if (!worker) throw new Error('Worker not created')

    const promise = client.refresh('agentboard', [])

    const payload = worker.lastMessage as { id: string } | null
    if (!payload?.id) throw new Error('Missing request id')

    worker.emitMessage({
      id: payload.id,
      kind: 'error',
      type: 'error',
      error: 'tmux list-windows timed out after 3000ms',
      errorCode: TMUX_TIMEOUT_ERROR_CODE,
    })

    await expect(promise).rejects.toBeInstanceOf(SessionRefreshWorkerTimeoutError)
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
    expect(worker.messages.at(-1)).toEqual(
      expect.objectContaining({ kind: 'shutdown' })
    )
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
    expect(worker.messages.at(-1)).toEqual(
      expect.objectContaining({ kind: 'shutdown' })
    )
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
    expect(worker.messages.at(-1)).toEqual(
      expect.objectContaining({ kind: 'shutdown' })
    )
    expect(WorkerMock.instances.length).toBe(instancesBefore + 1)
  })

  test('refresh timeouts fail the generation and restart the worker', async () => {
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

    await expect(promise).rejects.toBeInstanceOf(SessionRefreshWorkerTimeoutError)
    expect(worker.terminated).toBe(false)
    expect(worker.messages.at(-1)).toEqual(
      expect.objectContaining({ kind: 'shutdown' })
    )
    expect(WorkerMock.instances.length).toBe(instancesBefore + 1)
  })

  test('timing out one request fails queued work and future requests use a fresh worker', async () => {
    const timeoutCallbacks: Array<() => void> = []
    globalThis.setTimeout = ((((callback: TimerHandler) => {
      if (typeof callback === 'function') {
        timeoutCallbacks.push(callback as () => void)
      }
      return timeoutCallbacks.length as unknown as ReturnType<typeof setTimeout>
    }) as unknown) as typeof setTimeout)
    globalThis.clearTimeout = (() => {}) as typeof clearTimeout

    const client = new SessionRefreshWorkerClient()
    const firstWorker = WorkerMock.instances[WorkerMock.instances.length - 1]
    if (!firstWorker) throw new Error('Worker not created')

    const firstPromise = client.refresh('agentboard', [])
    const firstPayload = firstWorker.messages.at(-1) as { id: string } | null
    if (!firstPayload?.id) throw new Error('Missing first request id')

    const secondPromise = client.refresh('agentboard', [])
    const secondPayload = firstWorker.messages.at(-1) as { id: string } | null
    if (!secondPayload?.id) throw new Error('Missing second request id')
    const firstOutcome = firstPromise.catch((error) => error)
    const secondOutcome = secondPromise.catch((error) => error)

    const firstTimeout = timeoutCallbacks.shift()
    if (!firstTimeout) {
      throw new Error('First timeout was not scheduled')
    }
    firstTimeout()

    await expect(firstOutcome).resolves.toBeInstanceOf(SessionRefreshWorkerTimeoutError)
    await expect(secondOutcome).resolves.toBeInstanceOf(SessionRefreshWorkerTimeoutError)
    expect(firstWorker.messages.at(-1)).toEqual(
      expect.objectContaining({ kind: 'shutdown' })
    )

    const replacementWorker = WorkerMock.instances[WorkerMock.instances.length - 1]
    if (!replacementWorker || replacementWorker === firstWorker) {
      throw new Error('Replacement worker was not created')
    }

    const thirdPromise = client.refresh('agentboard', [])
    const thirdPayload = replacementWorker.messages.at(-1) as { id: string } | null
    if (!thirdPayload?.id) throw new Error('Missing third request id')

    replacementWorker.emitMessage({
      id: thirdPayload.id,
      kind: 'refresh',
      type: 'result',
      sessions: [],
    })

    await expect(thirdPromise).resolves.toEqual([])
  })

  test('refresh timeout stays tight for small installs', async () => {
    const timeoutDelays = captureTimeoutDelays()

    const client = new SessionRefreshWorkerClient()
    const promise = client.refresh('agentboard', [], { expectedWindowCount: 1 })
    client.dispose()

    await expect(promise).rejects.toThrow('Session refresh worker disposed')
    expectScheduledTimeout(timeoutDelays, 11000)
  })

  test('refresh timeout scales with expected window count', async () => {
    const timeoutDelays = captureTimeoutDelays()

    const client = new SessionRefreshWorkerClient()
    const promise = client.refresh('agentboard', [], { expectedWindowCount: 20 })
    client.dispose()

    await expect(promise).rejects.toThrow('Session refresh worker disposed')
    expectScheduledTimeout(timeoutDelays, 68000)
  })

  test('getLastUserMessage timeout respects configured tmux timeout', async () => {
    const originalTmuxTimeoutMs = config.tmuxTimeoutMs
    const timeoutDelays = captureTimeoutDelays()

    try {
      config.tmuxTimeoutMs = 12000
      const client = new SessionRefreshWorkerClient()
      const promise = client.getLastUserMessage('agentboard:1')
      client.dispose()

      await expect(promise).rejects.toThrow('Session refresh worker disposed')
      expectScheduledTimeout(timeoutDelays, 14000)
    } finally {
      config.tmuxTimeoutMs = originalTmuxTimeoutMs
    }
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
