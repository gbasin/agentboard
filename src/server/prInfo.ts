// Parse transcript PR identities and normalize GitHub check results.
import type { SessionPullRequest } from '../shared/types'
import type { PrCheckInfo } from '../shared/prStatus'
export type { PrInfo, PrCheckInfo } from '../shared/prStatus'

const PR_URL_PARSE_RE =
  /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/pull\/(\d+)$/

export function parsePrUrl(url: string): SessionPullRequest | null {
  const m = PR_URL_PARSE_RE.exec(url)
  if (!m || url.length > 256 || m[1].split('/').some(part => part === '.' || part === '..')) return null
  const number = Number(m[2])
  return Number.isSafeInteger(number) && number > 0 ? { url, repo: m[1], number } : null
}

export function canonicalPrUrl(url: string): string | null {
  const pr = parsePrUrl(url)
  return pr ? `https://github.com/${pr.repo.toLowerCase()}/pull/${pr.number}` : null
}

// Check runs report status+conclusion; status contexts report state
// (PENDING/EXPECTED/SUCCESS/ERROR/FAILURE). Normalize contexts onto the
// same fields so the client icon works for both.
export function mapCheck(
  c: Record<string, unknown>
): NonNullable<PrCheckInfo['checks']>[number] {
  const isContext = typeof c.status !== 'string'
  const state = typeof c.state === 'string' ? c.state : null
  const pending = state === 'PENDING' || state === 'EXPECTED'
  return {
    name: String(c.name ?? c.context ?? 'check'),
    status: isContext
      ? pending
        ? 'IN_PROGRESS'
        : 'COMPLETED'
      : String(c.status),
    conclusion: isContext
      ? pending
        ? null
        : state
      : typeof c.conclusion === 'string'
        ? c.conclusion
        : null,
    // Check runs expose detailsUrl; status contexts use targetUrl.
    link:
      typeof c.detailsUrl === 'string'
        ? c.detailsUrl
        : typeof c.targetUrl === 'string'
          ? c.targetUrl
          : undefined,
  }
}
