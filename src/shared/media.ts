/** Small live metadata and bounded, explicitly requested media detail pages. */
import type { SessionMedia } from './types'

export type MediaDiscovery =
  | { status: 'pending' }
  | { status: 'indexing'; bytesRead: number; bytesTotal: number; filesDone: number; filesTotal: number }
  | { status: 'ready' }
  | { status: 'failed'; message: string }

export interface MediaSummary {
  /** Descriptors too large for bounded pages/navigation; destinations are never truncated. */
  omittedItems?: number
  /** Omitted only by legacy cached/catalog fixtures; new discovery always supplies this state. */
  discovery?: MediaDiscovery
  identity: string
  revision: string
  total: number
  images: number
  documents: number
  links: number
  /** Monotonic within an identity; removals and label edits are not additions. */
  additions: number
  /** Oversized JSONL records excluded from the index, not a media item count. */
  omittedRecords?: number
}

export interface MediaPage {
  omittedItems?: number
  discovery?: MediaDiscovery
  identity: string
  revision: string
  total: number
  items: SessionMedia[]
  nextCursor: string | null
}

export type MediaStreamEvent =
  | { type: 'snapshot'; page: MediaPage & { discovery: MediaDiscovery } }
  | { type: 'progress'; summary: MediaSummary & { discovery: MediaDiscovery } }
  | { type: 'error'; message: string; code?: string }
  | { type: 'done' }

export const MEDIA_STREAM_BYTES = 512 * 1024
export const MEDIA_STREAM_MS = 60_000

/** Constant-sized image navigation, independent of retained rail pages. */
export interface MediaNeighbors {
  identity: string
  revision: string
  current: SessionMedia
  previous: SessionMedia | null
  next: SessionMedia | null
}

export const MEDIA_PAGE_ITEMS = 40
export const MEDIA_PAGE_BYTES = 64 * 1024
/** Inline original previews are bounded; larger assets require explicit opening. */
export const MEDIA_INLINE_BYTES = 64 * 1024

export function mediaSummariesEqual(a: MediaSummary | undefined, b: MediaSummary | undefined): boolean {
  if (a === b) return true
  return !!a && !!b && a.identity === b.identity && a.revision === b.revision &&
    a.total === b.total && a.images === b.images && a.documents === b.documents &&
    a.links === b.links && a.additions === b.additions &&
    (a.omittedRecords ?? 0) === (b.omittedRecords ?? 0) &&
    (a.omittedItems ?? 0) === (b.omittedItems ?? 0) &&
    JSON.stringify(a.discovery ?? { status: 'ready' }) === JSON.stringify(b.discovery ?? { status: 'ready' })
}

/** Filtered pages keep search off the live websocket and out of browser memory. */
export interface MediaQuery { kind?: 'media' | 'links'; search?: string }
