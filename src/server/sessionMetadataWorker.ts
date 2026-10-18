/// <reference lib="webworker" />
/** Transcript filesystem access stays here, never in session-view construction. */
import type { AgentSessionRecord } from './db'
import type { SessionMedia, SessionPullRequest } from '../shared/types'
import type { CodexSubagentLink } from './logMatchWorkerTypes'
import { pullRequestScanPlan, rescanMedia, rescanPullRequests, getCachedMedia, getCachedPullRequests } from './agentSessions'
import { setCodexSubagentIndex } from './subagentLogs'

export interface SessionMetadata {
  prs: SessionPullRequest[]
  media: SessionMedia[]
}
export type MetadataRequest =
  | { kind: 'scan'; id: number; record: AgentSessionRecord }
  | { kind: 'index'; links: CodexSubagentLink[] }
  | { kind: 'shutdown' }
export type MetadataResponse = { id: number } & (
  | { metadata: SessionMetadata }
  | { error: string }
)

const ctx = self as DedicatedWorkerGlobalScope
ctx.onmessage = (event: MessageEvent<MetadataRequest>) => {
  const request = event.data
  if (request.kind === 'shutdown') { ctx.close(); return }
  if (request.kind === 'index') { setCodexSubagentIndex(request.links); return }
  try {
    // The DB size can lag the file, and cannot detect a same-size rewrite.
    const record = { ...request.record, lastKnownLogSize: null }
    const plan = pullRequestScanPlan(record)
    rescanPullRequests(record, plan)
    rescanMedia(record, plan)
    const metadata = { prs: getCachedPullRequests(record), media: getCachedMedia(record) }
    ctx.postMessage({ id: request.id, metadata } satisfies MetadataResponse)
  } catch (error) {
    ctx.postMessage({ id: request.id, error: String(error) } satisfies MetadataResponse)
  }
}
