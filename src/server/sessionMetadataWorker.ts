/// <reference lib="webworker" />
/** Transcript filesystem/index work stays here; only summaries and requested bounded details cross realms. */
import type { AgentSessionRecord } from './db'
import type { SessionPullRequest } from '../shared/types'
import type { MediaPage, MediaSummary, MediaNeighbors } from '../shared/media'
import type { CodexSubagentLink } from './logMatchWorkerTypes'
import { pullRequestScanPlan, rescanPullRequests, getCachedPullRequests } from './agentSessions'
import { setCodexSubagentIndex } from './subagentLogs'
import { MediaIndex, MediaCursorError } from './mediaIndex'
import { MediaNeighborError } from './mediaAnchor'

export interface SessionMetadata {
  prs: SessionPullRequest[]
  mediaSummary?: MediaSummary
}
export type MetadataRequest =
  | { kind: 'storage'; path: string }
  | { kind: 'scan'; id: number; record: AgentSessionRecord; force?: boolean }
  | { kind: 'page'; id: number; record: AgentSessionRecord; cursor?: string }
  | { kind: 'neighbors'; id: number; record: AgentSessionRecord; anchor: string }
  | { kind: 'index'; links: CodexSubagentLink[] }
  | { kind: 'shutdown' }
export type MetadataResponse = { id: number } & (
  | { metadata: SessionMetadata; page?: MediaPage; neighbors?: MediaNeighbors }
  | { error: string; code?: string }
)

const ctx = self as DedicatedWorkerGlobalScope
let index: MediaIndex | null = null
ctx.onmessage = (event: MessageEvent<MetadataRequest>) => {
  const request = event.data
  if (request.kind === 'shutdown') { index?.close(); ctx.close(); return }
  if (request.kind === 'storage') { index?.close(); index = new MediaIndex(request.path); return }
  if (request.kind === 'index') { setCodexSubagentIndex(request.links); return }
  try {
    if (!index) throw Error('Media index storage not initialized')
    // The DB size can lag the file, and cannot detect a same-size rewrite.
    const record = { ...request.record, lastKnownLogSize: null }
    const plan = pullRequestScanPlan(record)
    rescanPullRequests(record, plan)
    if (request.kind === 'scan' && request.force) index.invalidate(record)
    const mediaSummary = index.scan(record, plan.paths)
    const metadata = { prs: getCachedPullRequests(record), mediaSummary }
    const page = request.kind === 'page' ? index.page(record, request.cursor) : undefined
    const neighbors = request.kind === 'neighbors' ? index.neighbors(record, request.anchor) : undefined
    ctx.postMessage({ id: request.id, metadata, ...(page ? { page } : {}), ...(neighbors ? { neighbors } : {}) } satisfies MetadataResponse)
  } catch (error) {
    ctx.postMessage({ id: request.id, error: String(error),
      ...((error instanceof MediaCursorError || error instanceof MediaNeighborError) ? { code: error.code } : {}) } satisfies MetadataResponse)
  }
}
