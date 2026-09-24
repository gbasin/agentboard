/// <reference lib="webworker" />
/**
 * Worker for Devin session mirroring.
 * syncDevinSessions reads the devin CLI's sessions.db (hundreds of MB of
 * message rows) and rewrites JSONL mirrors — all synchronous SQLite/file I/O.
 * Running it here keeps that off the main thread, where it previously stalled
 * WebSocket handling and tmux proxy work for seconds at a time.
 */
import { syncDevinSessions } from './devinSync'
import type { DevinSyncResult } from './devinSync'

export type DevinSyncWorkerRequest =
  | {
      id: string
      kind: 'sync'
      outDir: string
    }
  | {
      id: string
      kind: 'shutdown'
    }

export type DevinSyncWorkerResponse =
  | {
      id: string
      type: 'result'
      result: DevinSyncResult | null
      durationMs: number
    }
  | {
      id: string
      type: 'error'
      error: string
    }

const ctx = self as DedicatedWorkerGlobalScope

ctx.onmessage = (event: MessageEvent<DevinSyncWorkerRequest>) => {
  const payload = event.data
  if (!payload || !payload.id) {
    return
  }

  if (payload.kind === 'shutdown') {
    ctx.close()
    return
  }

  const startedAt = Date.now()
  try {
    const result = syncDevinSessions(payload.outDir)
    const response: DevinSyncWorkerResponse = {
      id: payload.id,
      type: 'result',
      result,
      durationMs: Date.now() - startedAt,
    }
    ctx.postMessage(response)
  } catch (error) {
    const response: DevinSyncWorkerResponse = {
      id: payload.id,
      type: 'error',
      error: error instanceof Error ? error.message : String(error),
    }
    ctx.postMessage(response)
  }
}
