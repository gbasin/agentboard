/// <reference lib="webworker" />
/** Read-only SQLite work. Receives an explicit path; never initializes schema. */
import { Database } from 'bun:sqlite'
import { readImportCandidates, readPollSnapshot } from './sessionReads'
import type { PollSnapshot, SnapshotOptions } from './sessionReads'

export type ReadOperation =
  | { kind: 'snapshot'; options: SnapshotOptions }
  | { kind: 'import' }
export type ReadRequest =
  | { id: number; path: string; operation: ReadOperation }
  | { kind: 'shutdown' }
export type ReadResult =
  | { kind: 'snapshot'; snapshot: PollSnapshot }
  | { kind: 'import'; ids: string[] }
export type ReadResponse =
  | { id: number; result: ReadResult; durationMs: number }
  | { id: number; error: string }

const ctx = self as DedicatedWorkerGlobalScope
let db: Database | null = null
let databasePath: string | null = null
ctx.onmessage = (event: MessageEvent<ReadRequest>) => {
  const request = event.data
  if ('kind' in request) {
    db?.close()
    db = null
    ctx.close()
    return
  }
  const started = performance.now()
  try {
    if (databasePath !== request.path) {
      db?.close()
      db = new Database(request.path, { readonly: true })
      db.exec('PRAGMA busy_timeout=250; PRAGMA query_only=ON; PRAGMA cache_size=-2048')
      databasePath = request.path
    }
    const result: ReadResult = request.operation.kind === 'snapshot'
      ? { kind: 'snapshot', snapshot: readPollSnapshot(db!, request.operation.options) }
      : { kind: 'import', ids: readImportCandidates(db!) }
    ctx.postMessage({ id: request.id, result, durationMs: performance.now() - started } satisfies ReadResponse)
  } catch (error) {
    ctx.postMessage({ id: request.id, error: String(error) } satisfies ReadResponse)
  }
}
