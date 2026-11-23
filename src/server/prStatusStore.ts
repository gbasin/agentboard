import { Database } from 'bun:sqlite'
import { restrictDatabaseFiles } from './databasePermissions'
import { PR_STATUS_STALE_MS, type PrCheckInfo, type PrInfo } from '../shared/prStatus'
import { logger } from './logger'
import { parsePrUrl } from './prInfo'
import {
  createGithubPrTransport,
  GithubPrCooldownError,
  GITHUB_PR_BATCH_SIZE,
  type GithubPr,
  type GithubPrTransport,
} from './prStatusGithub'

const ACTIVE_POLL_MS = 30_000
const QUIET_POLL_MS = 120_000
const BUDGET_WINDOW_MS = 120_000
const OVERLAP_MS = 5 * 60_000
const RECONCILE_MS = 24 * 60 * 60_000
const HYDRATE_RETRY_MS = 10 * 60_000
const CHECK_TTL_MS = 60_000
const REQUEST_BUDGET = { list: 32, hydrate: 20, checks: 24 }
type RequestLane = keyof typeof REQUEST_BUDGET
const CHECK_CONCURRENCY = 4

type Checks = NonNullable<PrCheckInfo['checks']>
interface CheckSnapshot {
  checks: Checks
  stale?: boolean
}

interface RepoRow {
  repo: string
  etag: string | null
  cursor: number
  active: number
}

interface PullRow {
  number: number
  state: string | null
  draft: number | null
  title: string | null
  author: string | null
  head_sha: string | null
  updated_at: number | null
  confirmed_at: number | null
  reconcile_missing: number
}

interface ChecksRow {
  checked_at: number
  payload: string
}

interface Sweep {
  started: number
  cutoff: number
  etag: string | null
  next: string | null
}

interface Options {
  transport?: GithubPrTransport
  now?: () => number
  onConfirmed?: () => void
}

function identify(url: string) {
  const pr = parsePrUrl(url)
  if (!pr) return null
  return { repo: pr.repo.toLowerCase(), number: pr.number }
}

function canonicalUrl(repo: string, number: number) {
  return `https://github.com/${repo}/pull/${number}`
}

/** Persist PR status separately from host-local session identity. */
export class PrStatusStore {
  private readonly db: Database
  private readonly transport: GithubPrTransport
  private readonly now: () => number
  private readonly onConfirmed?: () => void
  private readonly sweeps = new Map<string, Sweep>()
  private readonly lastPoll = new Map<string, number>()
  private readonly checkInflight = new Map<string, Promise<CheckSnapshot | undefined>>()
  private readonly stalePublished = new Set<string>()
  private timer?: ReturnType<typeof setTimeout>
  private started = false
  private polling?: Promise<void>
  private repoll = false
  private closing?: Promise<void>
  private budgetWindow = -Infinity
  private requests = { list: 0, hydrate: 0, checks: 0 }
  private readonly retryAt = { core: 0, graphql: 0, shared: 0 }

  constructor(
    path: string,
    private readonly onChange: (infos: PrInfo[]) => void,
    options: Options = {},
  ) {
    this.transport = options.transport ?? createGithubPrTransport()
    this.now = options.now ?? Date.now
    this.onConfirmed = options.onConfirmed
    this.db = new Database(path, { create: true, strict: true })
    restrictDatabaseFiles(path)
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS pr_status_repos (
        repo TEXT PRIMARY KEY,
        etag TEXT,
        cursor INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS pr_status_pulls (
        repo TEXT NOT NULL,
        number INTEGER NOT NULL,
        state TEXT,
        draft INTEGER,
        title TEXT,
        author TEXT,
        head_sha TEXT,
        updated_at INTEGER,
        confirmed_at INTEGER,
        next_hydrate INTEGER NOT NULL DEFAULT 0,
        reconcile_missing INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (repo, number)
      );
      CREATE INDEX IF NOT EXISTS pr_status_hydrate ON pr_status_pulls(repo, next_hydrate);
      CREATE INDEX IF NOT EXISTS pr_status_open ON pr_status_pulls(repo) WHERE state = 'OPEN';
      CREATE INDEX IF NOT EXISTS pr_status_head ON pr_status_pulls(repo, head_sha);
      CREATE INDEX IF NOT EXISTS pr_status_confirmed ON pr_status_pulls(confirmed_at);
      CREATE TABLE IF NOT EXISTS pr_status_checks (
        repo TEXT NOT NULL,
        head_sha TEXT NOT NULL,
        checked_at INTEGER NOT NULL,
        payload TEXT NOT NULL,
        PRIMARY KEY (repo, head_sha)
      );
    `)
  }

  register(urls: string[]) {
    if (this.closing) return
    const unseen = new Map<string, NonNullable<ReturnType<typeof identify>>>()
    const known = this.db.query<{ number: number }, [string, number]>(
      'SELECT number FROM pr_status_pulls WHERE repo = ? AND number = ?'
    )
    for (const url of urls) {
      const pr = identify(url)
      if (pr && !known.get(pr.repo, pr.number)) unseen.set(canonicalUrl(pr.repo, pr.number), pr)
    }
    if (!unseen.size) return
    const insertRepo = this.db.query('INSERT OR IGNORE INTO pr_status_repos(repo) VALUES (?)')
    const insertPull = this.db.query('INSERT OR IGNORE INTO pr_status_pulls(repo, number) VALUES (?, ?)')
    this.db.transaction(() => {
      for (const pr of unseen.values()) {
        insertRepo.run(pr.repo)
        insertPull.run(pr.repo, pr.number)
      }
    })()
    if (this.started) {
      if (this.polling) this.repoll = true
      else void this.poll()
    }
  }

  read(urls: string[]): PrInfo[] {
    if (this.closing) return urls.map(url => ({ url, error: 'unavailable' }))
    const now = this.now()
    return urls.map(url => {
      const pr = identify(url)
      return pr
        ? this.toInfo(url, this.readPull(pr.repo, pr.number), now)
        : { url, error: 'invalid url' }
    })
  }

  start() {
    if (this.started || this.closing) return
    this.started = true
    void this.poll()
  }

  stop(): Promise<void> {
    if (!this.closing) {
      this.started = false
      clearTimeout(this.timer)
      this.closing = Promise.allSettled([this.polling, ...this.checkInflight.values()])
        .then(() => { this.db.close() })
    }
    return this.closing
  }

  /** Share a single poll among timer and registration callers. */
  poll(): Promise<void> {
    if (this.closing) return Promise.resolve()
    if (!this.polling) {
      clearTimeout(this.timer)
      this.polling = this.pollRepos().then(nextPoll => {
        if (this.started) {
          this.timer = setTimeout(() => void this.poll(), this.repoll ? 0 : nextPoll)
          this.timer.unref?.()
        }
      }).catch((error: unknown) => {
        logger.warn('pr_status_poll_failed', { error: String(error) })
        if (this.started) {
          this.timer = setTimeout(() => void this.poll(), QUIET_POLL_MS)
          this.timer.unref?.()
        }
      }).finally(() => {
        this.polling = undefined
        this.repoll = false
      })
    }
    return this.polling
  }

  async check(url: string): Promise<PrCheckInfo> {
    const pr = identify(url)
    if (!pr) return { url, error: 'invalid url' }
    this.register([url])
    const info = this.read([url])[0]
    const headSha = info.headSha
    if (!headSha) return info
    const key = `${pr.repo}@${headSha}`
    let lookup = this.checkInflight.get(key)
    if (!lookup) {
      lookup = this.fetchChecks(pr.repo, pr.number, headSha).finally(() => this.checkInflight.delete(key))
      this.checkInflight.set(key, lookup)
    }
    const snapshot = await lookup
    if (this.closing) return { url, error: 'unavailable' }
    const current = this.read([url])[0]
    if (current.headSha !== headSha) return current
    return snapshot
      ? { ...current, checks: snapshot.checks, stale: current.stale || snapshot.stale === true }
      : { ...current, error: 'unavailable' }
  }

  private readPull(repo: string, number: number) {
    return this.db.query<PullRow, [string, number]>(
      'SELECT * FROM pr_status_pulls WHERE repo = ? AND number = ?'
    ).get(repo, number)
  }

  private toInfo(url: string, row: PullRow | null, now: number): PrInfo {
    if (!row || row.confirmed_at === null) return { url, error: 'unavailable' }
    return {
      url,
      state: row.state ?? undefined,
      isDraft: row.draft === 1,
      title: row.title ?? undefined,
      author: row.author ?? undefined,
      headSha: row.head_sha ?? undefined,
      lastConfirmedAt: row.confirmed_at,
      stale: now - row.confirmed_at >= PR_STATUS_STALE_MS,
    }
  }

  private canRequest(lane: RequestLane) {
    const now = this.now()
    const bucket = lane === 'list' ? 'core' : 'graphql'
    return !this.closing && now >= Math.max(this.retryAt[bucket], this.retryAt.shared) &&
      (now >= this.budgetWindow + BUDGET_WINDOW_MS || this.requests[lane] < REQUEST_BUDGET[lane])
  }

  private takeRequest(lane: RequestLane) {
    if (!this.canRequest(lane)) return false
    const now = this.now()
    if (now >= this.budgetWindow + BUDGET_WINDOW_MS) {
      this.budgetWindow = now
      this.requests = { list: 0, hydrate: 0, checks: 0 }
    }
    this.requests[lane]++
    return true
  }

  private handleFailure(error: unknown) {
    if (error instanceof GithubPrCooldownError) {
      this.retryAt[error.bucket] = Math.max(this.retryAt[error.bucket], error.retryAt)
    }
  }

  private async pollRepos() {
    const now = this.now()
    const repos = this.db.query<RepoRow, []>(`
      SELECT r.*, EXISTS(SELECT 1 FROM pr_status_pulls p WHERE p.repo = r.repo AND p.state = 'OPEN') AS active
      FROM pr_status_repos r ORDER BY repo
    `).all()
    const dueAt = (r: RepoRow) => (this.lastPoll.get(r.repo) ?? -Infinity) + (r.active ? ACTIVE_POLL_MS : QUIET_POLL_MS)
    repos.sort((a, b) => dueAt(a) - dueAt(b))
    let morePages: RepoRow[] = []
    for (const repo of repos) {
      if (now < dueAt(repo) || !this.canRequest('list')) break
      this.lastPoll.set(repo.repo, this.now())
      if (await this.syncPage(repo)) morePages.push(repo)
    }

    // Drain cold registrations and reconciliations in round-robin batches.
    // Use a separate quota so a busy repository cannot consume their budget.
    let moreHydrates = repos
    while (moreHydrates.length && this.canRequest('hydrate')) {
      const next = []
      for (const repo of moreHydrates) {
        if (!this.canRequest('hydrate')) break
        if (await this.hydrateRepo(repo.repo)) next.push(repo)
      }
      moreHydrates = next
    }

    // Each due repository had a first turn before any paginated continuation.
    while (morePages.length && this.canRequest('list')) {
      const next = []
      for (const repo of morePages) {
        if (!this.canRequest('list')) break
        if (await this.syncPage(repo)) next.push(repo)
      }
      morePages = next
    }
    if (!this.closing) this.publishStale()
    const finished = this.now()
    const earliest = repos.reduce(
      (next, repo) => Math.min(next, dueAt(repo)), finished + ACTIVE_POLL_MS
    )
    const available = Math.max(this.retryAt.core, this.retryAt.shared, this.canRequest('list') ? finished : this.budgetWindow + BUDGET_WINDOW_MS)
    return Math.min(QUIET_POLL_MS, Math.max(1, earliest - finished, available - finished))
  }

  private async syncPage(repo: RepoRow): Promise<boolean> {
    if (!this.takeRequest('list')) return false
    const started = this.now()
    const sweep = this.sweeps.get(repo.repo) ?? {
      started,
      cutoff: (repo.cursor || started) - OVERLAP_MS,
      etag: repo.etag,
      next: null,
    }
    let page
    try {
      page = await this.transport.list(repo.repo, sweep.next, sweep.next ? null : repo.etag)
    } catch (error) {
      this.handleFailure(error)
      return false
    }
    if (this.closing) return false
    if (page.notModified && !sweep.next) {
      this.completeSweep(repo.repo, started, repo.etag)
      return false
    }
    if (!sweep.next) sweep.etag = page.etag
    this.apply(repo.repo, page.items)
    // Commit the ETag only once the overlap window has been covered.
    if (!page.next || page.items.some(item => item.updatedAt < sweep.cutoff)) {
      this.completeSweep(repo.repo, sweep.started, sweep.etag)
      return false
    }
    sweep.next = page.next
    this.sweeps.set(repo.repo, sweep)
    return true
  }

  private completeSweep(repo: string, cursor: number, etag: string | null) {
    const recovered = this.db.query<PullRow, [string, number]>(`
      SELECT * FROM pr_status_pulls WHERE repo = ? AND reconcile_missing = 0 AND confirmed_at <= ?
    `).all(repo, this.now() - PR_STATUS_STALE_MS)
    const touched = this.db.transaction(() => {
      this.db.query('UPDATE pr_status_repos SET cursor = ?, etag = ? WHERE repo = ?').run(cursor, etag, repo)
      return this.db.query('UPDATE pr_status_pulls SET confirmed_at = ? WHERE repo = ? AND reconcile_missing = 0 AND confirmed_at IS NOT NULL AND confirmed_at < ?')
        .run(cursor, repo, cursor).changes
    })()
    this.sweeps.delete(repo)
    if (touched) this.onConfirmed?.()
    const now = this.now()
    if (now - cursor < PR_STATUS_STALE_MS && recovered.length) {
      this.onChange(recovered.map(row => {
        const url = canonicalUrl(repo, row.number)
        this.stalePublished.delete(url)
        return this.toInfo(url, { ...row, confirmed_at: cursor }, now)
      }))
    }
  }

  private publishStale() {
    const now = this.now()
    const rows = this.db.query<PullRow & { repo: string }, [number]>(`
      SELECT * FROM pr_status_pulls WHERE confirmed_at <= ?
    `).all(now - PR_STATUS_STALE_MS)
    const stale: PrInfo[] = []
    for (const row of rows) {
      const url = canonicalUrl(row.repo, row.number)
      if (this.stalePublished.has(url)) continue
      this.stalePublished.add(url)
      stale.push(this.toInfo(url, row, now))
    }
    if (stale.length) this.onChange(stale)
  }

  private async hydrateRepo(repo: string): Promise<boolean> {
    const now = this.now()
    const targets = this.db.query<{ number: number }, [string, number, number]>(`
      SELECT number FROM pr_status_pulls WHERE repo = ? AND next_hydrate <= ?
      ORDER BY confirmed_at IS NOT NULL, next_hydrate, number LIMIT ?
    `).all(repo, now, GITHUB_PR_BATCH_SIZE)
    if (!targets.length || !this.takeRequest('hydrate')) return false
    const numbers = targets.map(row => row.number)
    const retry = this.db.query('UPDATE pr_status_pulls SET next_hydrate = ? WHERE repo = ? AND number = ?')
    this.db.transaction(() => {
      for (const number of numbers) retry.run(now + QUIET_POLL_MS, repo, number)
    })()
    let items
    try {
      items = await this.transport.hydrate(repo, numbers)
    } catch (error) {
      this.handleFailure(error)
      return false
    }
    if (this.closing) return false
    const found = new Set(items.map(item => item.number))
    const markMissing = this.db.query('UPDATE pr_status_pulls SET reconcile_missing = 1 WHERE repo = ? AND number = ?')
    this.db.transaction(() => {
      for (const number of numbers) {
        if (found.has(number)) continue
        markMissing.run(repo, number)
        retry.run(now + HYDRATE_RETRY_MS, repo, number)
      }
    })()
    this.apply(repo, items)
    return targets.length === GITHUB_PR_BATCH_SIZE
  }

  private apply(repo: string, items: GithubPr[]) {
    const now = this.now()
    const updates: PrInfo[] = []
    let refreshed = false
    const write = this.db.query(`
      UPDATE pr_status_pulls SET state = ?, draft = ?, title = ?, author = ?,
        head_sha = ?, updated_at = ?, confirmed_at = ?, next_hydrate = ?, reconcile_missing = 0
      WHERE repo = ? AND number = ?
    `)
    const prune = this.db.query(`
      DELETE FROM pr_status_checks WHERE repo = ?1 AND head_sha = ?2
      AND NOT EXISTS (SELECT 1 FROM pr_status_pulls WHERE repo = ?1 AND head_sha = ?2)
    `)
    this.db.transaction(() => {
      for (const item of items) {
        const row = this.readPull(repo, item.number)
        if (!row || (row.updated_at !== null && item.updatedAt < row.updated_at)) continue
        write.run(
          item.state, +item.isDraft, item.title, item.author, item.headSha,
          item.updatedAt, now, now + RECONCILE_MS, repo, item.number,
        )
        if (row.head_sha && row.head_sha !== item.headSha) prune.run(repo, row.head_sha)
        if (row.state !== item.state || row.draft !== +item.isDraft || row.title !== item.title ||
            row.author !== item.author || row.head_sha !== item.headSha || row.confirmed_at === null ||
            now - row.confirmed_at >= PR_STATUS_STALE_MS) {
          const url = canonicalUrl(repo, item.number)
          this.stalePublished.delete(url)
          updates.push(this.toInfo(url, this.readPull(repo, item.number), now))
        } else if (row.confirmed_at !== now) refreshed = true
      }
    })()
    if (updates.length) this.onChange(updates)
    if (refreshed) this.onConfirmed?.()
  }

  private async fetchChecks(repo: string, number: number, headSha: string): Promise<CheckSnapshot | undefined> {
    const row = this.db.query<ChecksRow, [string, string]>(
      'SELECT * FROM pr_status_checks WHERE repo = ? AND head_sha = ?'
    ).get(repo, headSha)
    const cached = row ? JSON.parse(row.payload) as Checks : undefined
    if (row && cached && this.now() - row.checked_at < CHECK_TTL_MS) return { checks: cached }
    if (this.checkInflight.size < CHECK_CONCURRENCY && this.takeRequest('checks')) {
      try {
        const response = await this.transport.checks(repo, number, headSha)
        if (this.closing) return undefined
        const checks = [...new Map(response.map(check => [
          JSON.stringify([check.name, check.status, check.conclusion, check.link]),
          check,
        ])).values()]
        this.db.query(`
          INSERT OR REPLACE INTO pr_status_checks
          SELECT ?1, ?2, ?3, ?4 WHERE EXISTS
            (SELECT 1 FROM pr_status_pulls WHERE repo = ?1 AND head_sha = ?2)
        `).run(repo, headSha, this.now(), JSON.stringify(checks))
        return { checks }
      } catch (error) {
        this.handleFailure(error)
      }
    }
    return cached ? { checks: cached, stale: true } : undefined
  }
}
