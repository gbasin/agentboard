// prInfo.ts - Fetch GitHub PR metadata for session PR chips via `gh`.
//
// Two tiers:
//   fetchPrInfo(urls)   - eager, batched: state/title/author per PR
//   fetchPrChecks(url)  - lazy, on hover: CI statusCheckRollup detail
// Both are cached briefly so refreshes and hovers don't spam gh.

import type { SessionPullRequest } from '../shared/types'

const CACHE_TTL_MS = 60_000
const GH_TIMEOUT_MS = 8_000

export interface PrInfo {
  url: string
  state?: string // OPEN | MERGED | CLOSED
  isDraft?: boolean
  title?: string
  author?: string
  error?: string
}

export interface PrCheckInfo extends PrInfo {
  checks?: { name: string; status: string; conclusion: string | null }[]
}

const PR_URL_PARSE_RE =
  /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/pull\/(\d+)$/

export function parsePrUrl(url: string): SessionPullRequest | null {
  const m = PR_URL_PARSE_RE.exec(url)
  return m ? { url, repo: m[1], number: Number(m[2]) } : null
}

const infoCache = new Map<string, { at: number; info: PrInfo }>()
const checksCache = new Map<string, { at: number; info: PrCheckInfo }>()

async function ghPrView(repo: string, number: number, fields: string) {
  const proc = Bun.spawn(
    ['gh', 'pr', 'view', String(number), '--repo', repo, '--json', fields],
    { stdout: 'pipe', stderr: 'pipe' }
  )
  const timeout = setTimeout(() => proc.kill(), GH_TIMEOUT_MS)
  try {
    const [out, code] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ])
    if (code !== 0) return null
    return JSON.parse(out) as Record<string, unknown>
  } catch {
    return null
  } finally {
    clearTimeout(timeout)
  }
}

function baseInfo(url: string, raw: Record<string, unknown> | null): PrInfo {
  if (!raw) return { url, error: 'unavailable' }
  const author = raw.author as Record<string, unknown> | undefined
  return {
    url,
    state: typeof raw.state === 'string' ? raw.state : undefined,
    isDraft: raw.isDraft === true,
    title: typeof raw.title === 'string' ? raw.title : undefined,
    author: typeof author?.login === 'string' ? author.login : undefined,
  }
}

/** Batched eager fetch: one gh call per PR, in parallel, cached 60s. */
export async function fetchPrInfo(urls: string[]): Promise<PrInfo[]> {
  const now = Date.now()
  return Promise.all(
    urls.map(async (url) => {
      const cached = infoCache.get(url)
      if (cached && now - cached.at < CACHE_TTL_MS) return cached.info
      const parsed = parsePrUrl(url)
      const info = parsed
        ? baseInfo(
            url,
            await ghPrView(
              parsed.repo,
              parsed.number,
              'state,isDraft,title,author'
            )
          )
        : { url, error: 'invalid url' }
      infoCache.set(url, { at: now, info })
      return info
    })
  )
}

/** Lazy fetch for hover cards: includes CI check rollup. */
export async function fetchPrChecks(url: string): Promise<PrCheckInfo> {
  const now = Date.now()
  const cached = checksCache.get(url)
  if (cached && now - cached.at < CACHE_TTL_MS) return cached.info
  const parsed = parsePrUrl(url)
  let info: PrCheckInfo = parsed
    ? { url, error: 'unavailable' }
    : { url, error: 'invalid url' }
  if (parsed) {
    const raw = await ghPrView(
      parsed.repo,
      parsed.number,
      'state,isDraft,title,author,statusCheckRollup'
    )
    if (raw) {
      const rollup = Array.isArray(raw.statusCheckRollup)
        ? (raw.statusCheckRollup as Record<string, unknown>[])
        : []
      info = {
        ...baseInfo(url, raw),
        checks: rollup.slice(0, 20).map((c) => ({
          name: String(c.name ?? c.context ?? 'check'),
          status: String(c.status ?? ''),
          conclusion:
            typeof c.conclusion === 'string' ? c.conclusion : null,
        })),
      }
    }
  }
  checksCache.set(url, { at: now, info })
  return info
}
