/** In-memory discovery seam: facade tests never create a real media database. */
import type { AgentSessionRecord } from '../../db'
import type { CodexSubagentLink } from '../../logMatchWorkerTypes'
import type { MediaSummary, MediaPage, MediaNeighbors, MediaQuery, MediaStreamEvent } from '../../../shared/media'
export const pendingMedia: MediaSummary = { identity: 'test', revision: 'pending', total: 0, images: 0, documents: 0, links: 0, additions: 0, discovery: { status: 'pending' } }
export class FakeMediaDiscovery {
  summary = pendingMedia
  queued: AgentSessionRecord[] = []
  invalidated: AgentSessionRecord[] = []
  links: CodexSubagentLink[] = []
  disposed = false
  calls: unknown[][] = []
  failure: Error | null = null
  changed: (record: AgentSessionRecord, summary: MediaSummary) => void = () => {}
  get(_record: AgentSessionRecord) { return this.summary }
  queue(record: AgentSessionRecord) { this.queued.push(record) }
  invalidate(record: AgentSessionRecord) { this.invalidated.push(record) }
  setIndex(links: CodexSubagentLink[]) { this.links = links }
  dispose() { this.disposed = true }
  publish(record: AgentSessionRecord, summary: MediaSummary) { this.summary = summary; this.changed(record, summary) }
  async page(record: AgentSessionRecord, cursor?: string, query?: MediaQuery): Promise<MediaPage> {
    this.calls.push(['page', record, cursor, query])
    if (this.failure) throw this.failure
    return { identity: 'test', revision: 'indexed', total: 0, items: [], nextCursor: null }
  }
  async neighbors(record: AgentSessionRecord, anchor: string): Promise<MediaNeighbors> {
    this.calls.push(['neighbors', record, anchor])
    if (this.failure) throw this.failure
    return { identity: 'test', revision: 'indexed', current: { kind: 'image', url: anchor }, previous: null, next: null }
  }
  async *watch(record: AgentSessionRecord, cursor?: string, query?: MediaQuery, signal?: AbortSignal): AsyncIterable<MediaStreamEvent> {
    this.calls.push(['watch', record, cursor, query, signal])
    yield { type: 'done' }
  }
}
