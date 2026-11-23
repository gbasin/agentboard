// GitHub transport for PR status. Uses the daemon's existing gh credentials.
import { logger } from './logger'
import { mapCheck, type PrCheckInfo } from './prInfo'
import { sanitizedTmuxEnv } from './tmuxEnv'

export interface GithubPr {
  number: number
  state: 'OPEN' | 'MERGED' | 'CLOSED'
  isDraft: boolean
  title: string
  author: string
  headSha: string
  updatedAt: number
}

export interface GithubPrPage {
  items: GithubPr[]
  etag: string | null
  next: string | null
  notModified?: boolean
}

export interface GithubPrTransport {
  list(repo: string, cursor: string | null, etag: string | null): Promise<GithubPrPage>
  hydrate(repo: string, numbers: number[]): Promise<GithubPr[]>
  checks(repo: string, number: number, headSha: string): Promise<NonNullable<PrCheckInfo['checks']>>
}

export class GithubPrCooldownError extends Error {
  constructor(readonly retryAt: number, readonly bucket: 'core' | 'graphql' | 'shared' = 'shared') {
    super('GitHub rate limit cooldown')
  }
}

export const GITHUB_PR_BATCH_SIZE = 25
const TIMEOUT_MS = 8_000
const MAX_CONCURRENT_REQUESTS = 4
const MAX_OUTSTANDING_REQUESTS = 128
const FALLBACK_COOLDOWN_MS = 60_000
const API_ORIGIN = 'https://api.github.com'

type JsonObject = Record<string, unknown>
type Budget = 'core' | 'graphql'
type RunGh = (args: string[], input?: string) => Promise<string>

function object(value: unknown): JsonObject | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject : undefined
}

function validRepo(repo: string): boolean {
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) &&
    repo.split('/').every(part => part !== '.' && part !== '..')
}

function prFromJson(value: unknown, source: 'rest' | 'graphql'): GithubPr | undefined {
  const pr = object(value)
  if (!pr) return
  const isRest = source === 'rest'
  const state = isRest
    ? pr.state === 'open' ? 'OPEN' : pr.state === 'closed' ? (pr.merged_at ? 'MERGED' : 'CLOSED') : undefined
    : pr.state
  const updatedAt = Date.parse(String(pr[isRest ? 'updated_at' : 'updatedAt'] ?? ''))
  const headSha = isRest ? object(pr.head)?.sha : pr.headRefOid
  if (state !== 'OPEN' && state !== 'CLOSED' && state !== 'MERGED') return
  if (!Number.isSafeInteger(pr.number) || typeof pr.title !== 'string' ||
      typeof headSha !== 'string' || !Number.isFinite(updatedAt)) return
  const author = object(pr[isRest ? 'user' : 'author'])?.login
  return {
    number: pr.number as number,
    state,
    isDraft: pr[isRest ? 'draft' : 'isDraft'] === true,
    title: pr.title,
    author: typeof author === 'string' ? author : '',
    headSha,
    updatedAt,
  }
}

function parseResponse(output: string) {
  const separator = /\r?\n\r?\n/.exec(output)
  const [statusLine, ...lines] = output.slice(0, separator?.index ?? 0).split(/\r?\n/)
  const status = Number(/^HTTP\/\S+ (\d{3})(?: |$)/.exec(statusLine)?.[1])
  if (!separator || !Number.isFinite(status)) throw new Error('GitHub response unavailable')
  const headers = new Headers()
  for (const line of lines) {
    const colon = line.indexOf(':')
    if (colon > 0) headers.append(line.slice(0, colon), line.slice(colon + 1).trim())
  }
  const bodyText = output.slice(separator.index + separator[0].length)
  let body: unknown
  try { body = JSON.parse(bodyText) } catch { /* HTTP status still applies. */ }
  return { status, headers, body }
}

function getNextPage(headers: Headers, path: string): string | null {
  const link = /<([^>]+)>;\s*rel="next"/.exec(headers.get('link') ?? '')?.[1]
  if (!link) return null
  const next = new URL(link)
  // GitHub's Link header can use a numeric repository ID instead of owner/name.
  if (next.origin !== API_ORIGIN ||
      (next.pathname.toLowerCase() !== path.toLowerCase() && !/^\/repositories\/\d+\/pulls$/.test(next.pathname))) {
    throw new Error('Invalid GitHub PR pagination link')
  }
  // Keep the original repo and fixed filters even if Link uses a numeric ID.
  const page = next.searchParams.get('page')
  if (!page || !/^[1-9]\d*$/.test(page)) throw new Error('Invalid GitHub PR page number')
  return page
}

function retryAfterMs(header: string, now: number): number {
  if (/^\d+$/.test(header)) return now + Number(header) * 1_000
  return Date.parse(header)
}

async function runGh(args: string[], input?: string): Promise<string> {
  const proc = Bun.spawn(['gh', 'api', '--hostname', 'github.com', '--include', ...args], {
    env: { ...sanitizedTmuxEnv(), GH_PROMPT_DISABLED: '1', NO_COLOR: '1', GH_FORCE_TTY: '' },
    stdin: input === undefined ? 'ignore' : new Response(input).body!,
    stdout: 'pipe',
    stderr: 'ignore',
  })
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    try { proc.kill('SIGKILL') } catch { /* The process may have exited. */ }
  }, TIMEOUT_MS)
  try {
    // gh exits nonzero on 304 and on GraphQL partial errors, but prints the
    // HTTP response first. Interpret that response independently of exit code.
    const [output] = await Promise.allSettled([new Response(proc.stdout).text(), proc.exited])
    if (timedOut || output.status !== 'fulfilled') throw new Error('GitHub response unavailable')
    return output.value
  } finally {
    clearTimeout(timer)
  }
}

export function createGithubPrTransport(run: RunGh = runGh, now = Date.now): GithubPrTransport {
  const cooldown = { core: 0, graphql: 0, shared: 0 }
  const pending: Array<() => void> = []
  let active = 0

  function drain() {
    while (pending.length && active < MAX_CONCURRENT_REQUESTS) {
      active++
      pending.shift()!()
    }
  }

  function schedule<T>(job: () => Promise<T>): Promise<T> {
    if (active + pending.length >= MAX_OUTSTANDING_REQUESTS) {
      return Promise.reject(new Error('GitHub PR request queue is full'))
    }
    return new Promise<T>((resolve, reject) => {
      pending.push(() => {
        void job().then(resolve, reject).finally(() => {
          active--
          drain()
        })
      })
      drain()
    })
  }

  async function request(operation: 'list' | 'hydrate' | 'checks', args: string[], input?: string) {
    const budget: Budget = operation === 'list' ? 'core' : 'graphql'
    const started = now()
    const blockedUntil = Math.max(cooldown[budget], cooldown.shared)
    if (blockedUntil > started) throw new GithubPrCooldownError(blockedUntil, cooldown.shared === blockedUntil ? 'shared' : budget)
    let response: ReturnType<typeof parseResponse>
    try {
      response = parseResponse(await run(args, input))
    } catch {
      logger.debug('github_pr_request_failed', { operation, elapsedMs: now() - started })
      throw new Error('GitHub response unavailable')
    }
    const { status, headers, body } = response
    const remaining = headers.get('x-ratelimit-remaining')
    const reset = headers.get('x-ratelimit-reset')
    const retryAfter = headers.get('retry-after')
    const errors = object(body)?.errors
    const graphqlErrors = Array.isArray(errors) ? errors.map(object) : []
    const rateLimited = graphqlErrors.some(error => {
      const extensions = object(error?.extensions)
      return [error?.type, error?.code, extensions?.type, extensions?.code].some(value =>
        value === 'RATE_LIMIT' || value === 'RATE_LIMITED' || value === 'graphql_rate_limit'
      )
    })
    const secondaryLimit = /secondary rate limit|abuse detection/i
    const secondaryLimited = graphqlErrors.some(error => secondaryLimit.test(String(error?.message ?? ''))) ||
      (status === 403 && secondaryLimit.test(String(object(body)?.message ?? '')))
    const received = now()
    const fallback = received + FALLBACK_COOLDOWN_MS
    if (remaining === '0') {
      const resetAt = reset ? Number(reset) * 1_000 : NaN
      cooldown[budget] = Math.max(cooldown[budget], resetAt > received ? resetAt : fallback)
    }
    if (retryAfter || status === 429 || secondaryLimited) {
      const instructed = retryAfter ? retryAfterMs(retryAfter, received) : NaN
      cooldown.shared = Math.max(cooldown.shared, instructed > received ? instructed : fallback)
    } else if (rateLimited && remaining !== '0') {
      cooldown[budget] = Math.max(cooldown[budget], fallback)
    }
    const retryAt = Math.max(cooldown[budget], cooldown.shared)
    logger.debug('github_pr_request', {
      operation, status, elapsedMs: received - started, budget, remaining, reset,
      used: headers.get('x-ratelimit-used'),
      limit: headers.get('x-ratelimit-limit'),
      retryAt: retryAt > received ? retryAt : undefined,
    })
    if ((status !== 200 && status !== 304) || ((rateLimited || secondaryLimited) && !object(body)?.data)) {
      if (retryAt > received) throw new GithubPrCooldownError(retryAt, cooldown.shared === retryAt ? 'shared' : budget)
      throw new Error(`GitHub API returned HTTP ${status}`)
    }
    return response
  }

  async function graphql(operation: 'hydrate' | 'checks', repo: string, fields: string, oid?: string) {
    if (!validRepo(repo)) throw new Error('Invalid GitHub repository')
    const [owner, name] = repo.split('/')
    const variables = { owner, name, ...(oid ? { oid } : {}) }
    const oidArgument = oid ? ', $oid: GitObjectID!' : ''
    const query = `query($owner: String!, $name: String!${oidArgument}) {
      repository(owner: $owner, name: $name) { ${fields} }
    }`
    const { body } = await schedule(() =>
      request(operation, ['--method', 'POST', 'graphql', '--input', '-'], JSON.stringify({ query, variables }))
    )
    const repository = object(object(object(body)?.data)?.repository)
    if (!repository) throw new Error('GitHub repository unavailable')
    const errors = object(body)?.errors
    if (operation === 'checks' && Array.isArray(errors) && errors.length) {
      throw new Error('GitHub commit checks unavailable')
    }
    return repository
  }

  return {
    async list(repo, cursor, etag) {
      if (!validRepo(repo)) throw new Error('Invalid GitHub repository')
      const path = `/repos/${repo}/pulls`
      if (cursor !== null && !/^[1-9]\d*$/.test(cursor)) throw new Error('Invalid GitHub PR page number')
      const args = ['--method', 'GET', `${path.slice(1)}?state=all&sort=updated&direction=desc&per_page=50&page=${cursor ?? 1}`]
      if (etag) args.push('-H', `If-None-Match: ${etag}`)
      const { status, headers, body } = await schedule(() => request('list', args))
      const next = getNextPage(headers, path)
      const responseEtag = headers.get('etag')
      if (status === 304) return { notModified: true, items: [], etag: responseEtag ?? etag, next }
      if (!Array.isArray(body)) throw new Error('Invalid GitHub PR listing')
      const items = body.map(pr => prFromJson(pr, 'rest')).filter(pr => pr !== undefined)
      return { items, etag: responseEtag, next }
    },
    async hydrate(repo, numbers) {
      const unique = [...new Set(numbers)]
      if (!unique.length) return []
      if (unique.length > GITHUB_PR_BATCH_SIZE || unique.some(number => !Number.isSafeInteger(number) || number < 1)) {
        throw new Error('Invalid GitHub PR batch')
      }
      const fields = unique.map(number =>
        `pr${number}: pullRequest(number: ${number}) { number state isDraft title author { login } headRefOid updatedAt }`
      ).join('\n')
      const repository = await graphql('hydrate', repo, fields)
      return unique.flatMap(number => {
        const pr = prFromJson(repository[`pr${number}`], 'graphql')
        return pr?.number === number ? [pr] : []
      })
    },
    async checks(repo, _number, headSha) {
      if (!/^[a-f0-9]{40}$/i.test(headSha)) throw new Error('Invalid GitHub commit SHA')
      const repository = await graphql('checks', repo, `
        object(oid: $oid) {
          ... on Commit {
            statusCheckRollup {
              contexts(first: 20) { nodes {
                ... on CheckRun { name status conclusion detailsUrl }
                ... on StatusContext { context state targetUrl }
              } }
            }
          }
        }`, headSha)
      const commit = object(repository.object)
      if (!commit || !Object.hasOwn(commit, 'statusCheckRollup')) throw new Error('GitHub commit checks unavailable')
      if (commit.statusCheckRollup === null) return []
      const nodes = object(object(commit.statusCheckRollup)?.contexts)?.nodes
      if (!Array.isArray(nodes)) throw new Error('GitHub commit checks unavailable')
      return nodes.map(object).filter(node => node !== undefined).map(mapCheck)
    },
  }
}
