// Shared PR snapshots delivered by HTTP and WebSocket.
export const PR_STATUS_STALE_MS = 5 * 60_000

export interface PrInfo {
  url: string
  state?: string // OPEN | MERGED | CLOSED
  isDraft?: boolean
  title?: string
  author?: string
  headSha?: string
  lastConfirmedAt?: number // Unix epoch milliseconds
  stale?: boolean
  error?: string
}

export interface PrCheckInfo extends PrInfo {
  checks?: {
    name: string
    status: string
    conclusion: string | null
    link?: string
  }[]
}
