/** Only canonical, content-addressed descriptors emitted by our media index are anchors. */
export class MediaNeighborError extends Error {
  constructor(readonly code: 'INVALID_ANCHOR' | 'STALE_ANCHOR') {
    super(code === 'STALE_ANCHOR' ? 'Image changed; refresh media.' : 'Invalid image anchor')
    this.name = 'MediaNeighborError'
  }
}

export function parseMediaAnchor(sessionId: string, anchor: string) {
  if (!anchor || anchor.length > 8192) throw new MediaNeighborError('INVALID_ANCHOR')
  let url: URL
  try { url = new URL(anchor, 'http://agentboard.local') } catch { throw new MediaNeighborError('INVALID_ANCHOR') }
  const prefix = `/api/session-media/${encodeURIComponent(sessionId)}`
  const path = url.searchParams.get('path') ?? ''
  const offset = Number(url.searchParams.get('offset'))
  const index = Number(url.searchParams.get('index'))
  const digest = url.searchParams.get('digest') ?? ''
  if (!path || !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(index) || index < 0 ||
      !/^[a-f0-9]{64}$/.test(digest)) throw new MediaNeighborError('INVALID_ANCHOR')
  const canonical = `${prefix}?path=${encodeURIComponent(path)}&offset=${offset}&index=${index}&digest=${digest}`
  // Equality also rejects remote URLs, extra/duplicate parameters, fragments and missing offsets.
  if (anchor !== canonical) throw new MediaNeighborError('INVALID_ANCHOR')
  return { path, offset, index }
}
