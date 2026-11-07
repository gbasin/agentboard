/// <reference lib="webworker" />
/** Snapshot reads never scan files or share the writer's work queue. */
import { MediaIndex } from './mediaIndex'
import type { DiscoveryRequest, DiscoveryResponse } from './mediaDiscoveryProtocol'
const ctx = self as DedicatedWorkerGlobalScope
let index: MediaIndex | undefined
ctx.onmessage = ({ data: request }: MessageEvent<DiscoveryRequest>) => {
  if (request.kind === 'shutdown') { index?.close(); ctx.close(); return }
  if (request.kind === 'index') return
  try {
    if (request.kind === 'open') { index ??= new MediaIndex(request.path, { readonly: true }); ctx.postMessage({ id: request.id, value: null }); return }
    if (!index) throw Error('Media reader unavailable')
    const value = request.kind === 'summary' ? index.getSummary(request.record) ?? index.pendingSummary(request.record)
      : request.kind === 'page' ? index.page(request.record, request.cursor, request.query)
      : request.kind === 'neighbors' ? index.neighbors(request.record, request.anchor) : null
    ctx.postMessage({ id: request.id, value } satisfies DiscoveryResponse)
  } catch (error) {
    ctx.postMessage({ id: request.id, error: String(error), code: (error as { code?: string }).code } satisfies DiscoveryResponse)
  }
}
