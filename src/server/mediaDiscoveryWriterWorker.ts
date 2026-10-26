/// <reference lib="webworker" />
/** One resumable writer. The coordinator schedules one committed slice at a time. */
import { MediaIndex, mediaIdentity, type MediaScanJob } from './mediaIndex'
import { getSubagentLogPaths, setCodexSubagentIndex } from './subagentLogs'
import type { DiscoveryRequest, DiscoveryResponse } from './mediaDiscoveryProtocol'
const ctx = self as DedicatedWorkerGlobalScope
let index: MediaIndex | undefined
const jobs = new Map<string, MediaScanJob>()
ctx.onmessage = ({ data: request }: MessageEvent<DiscoveryRequest>) => {
  if (request.kind === 'shutdown') { for (const job of jobs.values()) index?.cancelScan(job); index?.close(); ctx.close(); return }
  if (request.kind === 'index') { setCodexSubagentIndex(request.links); return }
  try {
    if (request.kind === 'open') { index ??= new MediaIndex(request.path); ctx.postMessage({ id: request.id, value: null }); return }
    if (!index) throw Error('Media writer unavailable')
    const key = mediaIdentity(request.record)
    if (request.kind === 'cancel') {
      const job = jobs.get(key)
      if (job) index.cancelScan(job)
      jobs.delete(key)
      ctx.postMessage({ id: request.id, value: index.getSummary(request.record) ?? index.pendingSummary(request.record), done: true }); return
    }
    if (request.kind !== 'step') throw Error('Unsupported writer command')
    if (request.links) setCodexSubagentIndex(request.links)
    let job = jobs.get(key)
    if (!job || request.force) {
      if (!job && jobs.size >= 32) throw Error('Media discovery capacity reached')
      job = index.startScan(request.record, [request.record.logFilePath,
        ...getSubagentLogPaths(request.record.logFilePath, request.record.agentType, request.record.sessionId)], { force: request.force })
      jobs.set(key, job)
    }
    const result = index.stepScan(job)
    if (result.done) jobs.delete(key)
    ctx.postMessage({ id: request.id, value: result.summary, done: result.done } satisfies DiscoveryResponse)
  } catch (error) {
    if ('record' in request) {
      jobs.delete(mediaIdentity(request.record))
      // A failing database must not prevent the original request settling.
      try { index?.markFailed(request.record, 'Media discovery failed. Retry to continue.') } catch { /* best effort */ }
    }
    ctx.postMessage({ id: request.id, error: String(error) } satisfies DiscoveryResponse)
  }
}
