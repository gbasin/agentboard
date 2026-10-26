/** Bypass pre-hardening immutable payload caches without changing navigation anchors. */
export function mediaPayloadUrl(url: string): string {
  return url.startsWith('/api/session-media/') ? `${url}${url.includes('?') ? '&' : '?'}delivery=2` : url
}
