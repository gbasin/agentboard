/** Transcript metadata is untrusted. Only inert formats may render on our origin. */
const INLINE_TYPES = new Set([
  'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/bmp',
  'image/x-icon', 'image/vnd.microsoft.icon', 'application/pdf', 'text/plain',
])
export function mediaPayloadHeaders(declaredType: string | undefined, immutable: boolean): Record<string, string> {
  const type = declaredType?.split(';')[0].trim().toLowerCase() ?? ''
  const inline = INLINE_TYPES.has(type)
  return {
    'Content-Type': inline ? type : 'application/octet-stream',
    'Content-Disposition': inline ? 'inline' : 'attachment',
    'Content-Security-Policy': "sandbox; default-src 'none'; base-uri 'none'; form-action 'none'",
    'Cache-Control': inline && immutable ? 'private, max-age=31536000, immutable' : 'no-store',
    'X-Content-Type-Options': 'nosniff',
  }
}
