/** Small live metadata and bounded, explicitly requested media detail pages. */
import type { SessionMedia } from './types'

export interface MediaSummary {
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
  identity: string
  revision: string
  total: number
  items: SessionMedia[]
  nextCursor: string | null
}

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
    (a.omittedRecords ?? 0) === (b.omittedRecords ?? 0)
}
