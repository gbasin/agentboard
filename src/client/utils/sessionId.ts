export function getSessionIdShort(sessionId: string): string {
  const trimmed = sessionId.trim()
  if (!trimmed || trimmed.length <= 6) return trimmed
  return `${trimmed.slice(0, 3)}…${trimmed.slice(-3)}`
}

// Keep old name for compatibility during refactor
export const getSessionIdPrefix = getSessionIdShort
