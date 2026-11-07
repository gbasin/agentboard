/// <reference lib="webworker" />
// A single scanner owns all cursors and bounded transcript work off main.
import { SessionActivityTracker } from './sessionActivity'
import { activityKey, type ActivityRequest, type ActivityResponse } from './sessionActivityProtocol'
import { setCodexSubagentIndex } from './subagentLogs'

const ctx = self as DedicatedWorkerGlobalScope
let scanId: number | null = null
let lastProgress = 0
const tracker = new SessionActivityTracker(() => {
  if (scanId !== null && Date.now() - lastProgress >= 1000) {
    lastProgress = Date.now()
    ctx.postMessage({ id: scanId, progress: true } satisfies ActivityResponse)
  }
})
ctx.onmessage = async (event: MessageEvent<ActivityRequest>) => {
  const request = event.data
  if (request.kind === 'index') { setCodexSubagentIndex(request.links); return }
  scanId = request.id
  try {
    const sessions = await tracker.enrich(request.sessions)
    ctx.postMessage({ id: request.id, patches: sessions.map(session => ({ key: activityKey(session), activity: session.activity })) } satisfies ActivityResponse)
  } catch {
    ctx.postMessage({ id: request.id, error: 'Activity scan failed' } satisfies ActivityResponse)
  } finally { scanId = null }
}
