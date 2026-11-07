/// <reference lib="webworker" />
/** Pull-request extraction has its own queue; media reads and discovery run elsewhere. */
import type { AgentSessionRecord } from './db'
import type { SessionPullRequest } from '../shared/types'
import type { MediaSummary } from '../shared/media'
import type { CodexSubagentLink } from './logMatchWorkerTypes'
import { pullRequestScanPlan, rescanPullRequests, getCachedPullRequests } from './agentSessions'
import { setCodexSubagentIndex } from './subagentLogs'

export interface SessionMetadata {
  prs: SessionPullRequest[]
  mediaSummary?: MediaSummary
}
export type MetadataRequest =
  | { kind: 'scan'; id: number; record: AgentSessionRecord }
  | { kind: 'index'; links: CodexSubagentLink[] }
  | { kind: 'shutdown' }
export type MetadataResponse = { id: number } & (
  | { metadata: Pick<SessionMetadata, 'prs'> }
  | { error: string }
)

const ctx = self as DedicatedWorkerGlobalScope
ctx.onmessage = (event: MessageEvent<MetadataRequest>) => {
  const request = event.data
  if (request.kind === 'shutdown') { ctx.close(); return }
  if (request.kind === 'index') { setCodexSubagentIndex(request.links); return }
  try {
    // DB size can lag the file and does not detect same-size rewrites.
    const record = { ...request.record, lastKnownLogSize: null }
    rescanPullRequests(record, pullRequestScanPlan(record))
    ctx.postMessage({ id: request.id, metadata: { prs: getCachedPullRequests(record) } } satisfies MetadataResponse)
  } catch (error) {
    ctx.postMessage({ id: request.id, error: String(error) } satisfies MetadataResponse)
  }
}
