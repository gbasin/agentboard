export function getSessionIdPrefix(sessionId: string, length = 5): string {
  const trimmed = sessionId.trim()
  if (!trimmed || length <= 0) return ''
  return trimmed.slice(0, length)
}
