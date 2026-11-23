// Select the local GitHub-backed authority or a read-through follower.
import { Database } from 'bun:sqlite'
import { restrictDatabaseFiles } from './databasePermissions'
import { createHash, randomUUID } from 'node:crypto'
import type { Hono } from 'hono'
import { PR_STATUS_STALE_MS, type PrCheckInfo, type PrInfo } from '../shared/prStatus'
import { logger } from './logger'
import { normalizeOrigin } from './requestOrigin'
import {
  boundedJson,
  mountPrStatusPeer,
  PEER_BATCH_SIZE,
  peerPrUrl,
  PR_STATUS_PEER_PATH,
  recordDigest,
  RESPONSE_BYTES,
} from './prStatusPeer'
import type { GithubPrTransport } from './prStatusGithub'
import { PrStatusStore } from './prStatusStore'

const SYNC_MS = 5_000
const REQUEST_TIMEOUT_MS = 10_000
const MAX_PARALLEL_CHECKS = 8

export interface PrStatusProvider {
  register(urls: string[]): void
  read(urls: string[]): PrInfo[]
  check(url: string): Promise<PrCheckInfo>
  start(): void
  stop(): void | Promise<void>
  mount(app: Hono): void
}

type OnChange = (records: PrInfo[]) => void

function configuration(env: NodeJS.ProcessEnv) {
  const token = env.AGENTBOARD_PR_STATUS_TOKEN
  if (token !== undefined && !/^[A-Za-z0-9_-]{32,256}$/.test(token)) {
    throw new Error('AGENTBOARD_PR_STATUS_TOKEN must contain 32–256 URL-safe characters')
  }
  const configured = env.AGENTBOARD_PR_STATUS_AUTHORITY_URL
  if (configured === undefined) return { token }
  const origin = normalizeOrigin(configured)
  if (!origin) throw new Error('AGENTBOARD_PR_STATUS_AUTHORITY_URL must be an HTTP(S) origin')
  const url = new URL(origin)
  if (url.protocol !== 'https:' && url.hostname !== '127.0.0.1' && url.hostname !== '[::1]') {
    throw new Error('AGENTBOARD_PR_STATUS_AUTHORITY_URL requires HTTPS or a loopback IP')
  }
  if (!token) throw new Error('AGENTBOARD_PR_STATUS_AUTHORITY_URL requires AGENTBOARD_PR_STATUS_TOKEN')
  return { origin, token }
}

interface ProviderOptions {
  transport?: GithubPrTransport
  fetch?: typeof globalThis.fetch
  now?: () => number
}

export function createPrStatusProvider(
  path: string,
  onChange: OnChange,
  env: NodeJS.ProcessEnv = process.env,
  options?: ProviderOptions,
): PrStatusProvider {
  const { origin, token } = configuration(env)
  if (origin && token) return new PrStatusFollower(path, origin, token, onChange, options)
  const generation = randomUUID()
  let revision = 0
  const store = new PrStatusStore(path, records => {
    revision++
    onChange(records)
  }, { transport: options?.transport, now: options?.now, onConfirmed: () => revision++ })
  const registered = new Set<string>()
  let closing: Promise<void> | undefined
  const authority: PrStatusProvider = {
    register(urls) {
      if (closing) return
      const added: string[] = []
      for (const raw of urls) {
        const url = peerPrUrl(raw)
        if (!url || registered.has(url)) continue
        registered.add(url)
        added.push(url)
      }
      if (added.length) store.register(added)
    },
    read: urls => closing ? urls.map(url => ({ url, error: 'unavailable' })) : store.read(urls),
    check: url => closing ? Promise.resolve({ url, error: 'unavailable' }) : store.check(url),
    start: () => store.start(),
    stop: () => (closing ??= store.stop()),
    mount(app) {
      if (token) mountPrStatusPeer(app, authority, token, () => `${generation}.${revision}`)
    },
  }
  return authority
}

type CachedInfo = { payload: string }
type CachedChecks = { checks: string | null }

function validInfo(value: unknown): value is PrInfo {
  if (!value || typeof value !== 'object') return false
  const info = value as Partial<PrInfo>
  return typeof info.url === 'string' &&
    (info.error === undefined || typeof info.error === 'string') &&
    (info.state === undefined || typeof info.state === 'string') &&
    (info.isDraft === undefined || typeof info.isDraft === 'boolean') &&
    (info.title === undefined || typeof info.title === 'string') &&
    (info.author === undefined || typeof info.author === 'string') &&
    (info.headSha === undefined || typeof info.headSha === 'string') &&
    (info.lastConfirmedAt === undefined || Number.isFinite(info.lastConfirmedAt)) &&
    (info.stale === undefined || typeof info.stale === 'boolean')
}

function validChecks(value: unknown): value is NonNullable<PrCheckInfo['checks']> {
  return Array.isArray(value) && value.length <= 100 && value.every(check =>
    check && typeof check === 'object' &&
    typeof check.name === 'string' && typeof check.status === 'string' &&
    (typeof check.conclusion === 'string' || check.conclusion === null) &&
    (check.link === undefined || (typeof check.link === 'string' && /^https?:\/\//i.test(check.link))))
}

function samePresentation(a: PrInfo | undefined, b: PrInfo): boolean {
  return a?.state === b.state && a?.isDraft === b.isDraft && a?.headSha === b.headSha &&
    a?.title === b.title && a?.author === b.author && a?.stale === b.stale
}

export class PrStatusFollower implements PrStatusProvider {
  private readonly db: Database
  private readonly scope: string
  private readonly fetchPeer: typeof globalThis.fetch
  private readonly now: () => number
  private readonly registered = new Set<string>()
  private readonly checks = new Map<string, Promise<PrCheckInfo>>()
  private readonly lifecycle = new AbortController()
  private timer?: ReturnType<typeof setTimeout>
  private syncing?: Promise<void>
  private closing?: Promise<void>
  private running = false
  private offline = true
  private peerRevision?: string
  private syncedCount = 0

  constructor(
    path: string,
    private readonly origin: string,
    private readonly token: string,
    private readonly onChange: OnChange,
    options: ProviderOptions = {},
  ) {
    this.fetchPeer = options.fetch ?? globalThis.fetch
    this.now = options.now ?? Date.now
    this.scope = createHash('sha256').update(origin).update('\0').update(token).digest('hex')
    this.db = new Database(path, { create: true, strict: true })
    restrictDatabaseFiles(path)
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS pr_status_follower (
        scope TEXT NOT NULL,
        url TEXT NOT NULL,
        payload TEXT NOT NULL,
        PRIMARY KEY (scope, url)
      );
      CREATE TABLE IF NOT EXISTS pr_status_follower_checks (
        scope TEXT NOT NULL,
        url TEXT NOT NULL,
        checks TEXT NOT NULL,
        PRIMARY KEY (scope, url)
      );
    `)
  }

  mount(_app: Hono) {
    // Only an authority accepts peer requests. Followers cannot form a chain.
  }

  register(urls: string[]) {
    let added = false
    for (const raw of urls) {
      const url = peerPrUrl(raw)
      if (!url || this.registered.has(url)) continue
      this.registered.add(url)
      added = true
    }
    if (added && this.running && !this.syncing) this.schedule(50)
  }

  private cached(url: string): PrInfo | undefined {
    const cache = this.db.query<CachedInfo, [string, string]>(
      'SELECT payload FROM pr_status_follower WHERE scope = ? AND url = ?',
    ).get(this.scope, url)
    return cache ? JSON.parse(cache.payload) as PrInfo : undefined
  }

  read(urls: string[]): PrInfo[] {
    const staleBefore = this.now() - PR_STATUS_STALE_MS
    return urls.map(raw => {
      const url = peerPrUrl(raw)
      if (!url) return { url: raw, error: 'invalid url' }
      const record = !this.lifecycle.signal.aborted && this.registered.has(url) && this.cached(url)
      return record
        ? { ...record, url: raw, stale: this.offline || record.stale || (record.lastConfirmedAt ?? Infinity) <= staleBefore }
        : { url: raw, error: 'unavailable' }
    })
  }

  start() {
    if (this.running || this.lifecycle.signal.aborted) return
    this.running = true
    this.schedule(0)
  }

  stop(): Promise<void> {
    if (!this.closing) {
      this.running = false
      clearTimeout(this.timer)
      this.lifecycle.abort()
      this.closing = Promise.allSettled([this.syncing, ...this.checks.values()]).then(() => { this.db.close() })
    }
    return this.closing
  }

  private schedule(delay: number) {
    clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      void this.sync().finally(() => {
        if (this.running) this.schedule(SYNC_MS)
      })
    }, delay)
    this.timer.unref?.()
  }

  /** Run one bounded-batch sweep, sharing it with any caller already syncing. */
  sync(): Promise<void> {
    if (this.lifecycle.signal.aborted) return Promise.resolve()
    this.syncing ??= this.sweep().finally(() => { this.syncing = undefined })
    return this.syncing
  }

  private async sweep() {
    if (!this.registered.size) return
    let urls: string[] | undefined
    const previousOffline = this.offline
    const changed = new Map<string, PrInfo>()
    try {
      const revision = await this.request('revision')
      if (typeof revision !== 'string' || revision.length > 80) throw new Error('Invalid PR status authority revision')
      if (revision === this.peerRevision && this.syncedCount === this.registered.size && !previousOffline) return
      urls = [...this.registered]
      for (let offset = 0; offset < urls.length; offset += PEER_BATCH_SIZE) {
        const batch = new Map(urls.slice(offset, offset + PEER_BATCH_SIZE).map(url => [url, this.cached(url)]))
        const payload = await this.request('sync', [...batch].map(([url, info]) =>
          [url, info ? recordDigest(info) : null]))
        if (this.lifecycle.signal.aborted) return
        if (!Array.isArray(payload) || payload.length > batch.size ||
            !payload.every(record => validInfo(record) && batch.has(record.url))) {
          throw new Error('Invalid PR status authority response')
        }
        const save = this.db.query(`
          INSERT INTO pr_status_follower(scope, url, payload) VALUES (?, ?, ?)
          ON CONFLICT(scope, url) DO UPDATE SET payload = excluded.payload
        `)
        this.db.transaction(() => {
          for (const record of payload as PrInfo[]) {
            const previous = batch.get(record.url)
            // An authority rebuilding its cache may be temporarily missing a PR.
            const incoming = record.error && previous ? { ...previous, stale: true } : record
            if (incoming.error) continue
            save.run(this.scope, incoming.url, JSON.stringify(incoming))
            if (!previous || !samePresentation(previous, incoming)) changed.set(incoming.url, incoming)
          }
        })()
      }
      this.peerRevision = revision
      this.syncedCount = urls.length
      this.offline = false
    } catch {
      if (this.lifecycle.signal.aborted) return
      if (!previousOffline) logger.warn('pr_status_authority_unavailable')
      this.offline = true
    }
    if (previousOffline !== this.offline) {
      for (const record of this.read(urls ?? [...this.registered])) {
        if (!record.error) changed.set(record.url, record)
      }
    }
    if (changed.size) this.onChange([...changed.values()].map(record =>
      this.offline ? { ...record, stale: true } : record))
  }

  async check(raw: string): Promise<PrCheckInfo> {
    const url = peerPrUrl(raw)
    if (!url) return { url: raw, error: 'invalid url' }
    if (this.lifecycle.signal.aborted || !this.registered.has(url)) return { url: raw, error: 'unavailable' }
    let inflight = this.checks.get(url)
    if (!inflight) {
      if (this.checks.size >= MAX_PARALLEL_CHECKS) {
        return { ...this.cachedChecks(url), url: raw }
      }
      inflight = this.readChecks(url).finally(() => this.checks.delete(url))
      this.checks.set(url, inflight)
    }
    return { ...(await inflight), url: raw }
  }

  private cachedChecks(url: string): PrCheckInfo {
    const info = this.read([url])[0]
    const row = this.db.query<CachedChecks, [string, string]>(
      'SELECT checks FROM pr_status_follower_checks WHERE scope = ? AND url = ?',
    ).get(this.scope, url)
    const record = row?.checks ? JSON.parse(row.checks) as PrCheckInfo : undefined
    return record?.headSha && record.headSha === info.headSha
      ? { ...info, stale: true, checks: record.checks }
      : { ...info, error: 'unavailable' }
  }

  private async readChecks(url: string): Promise<PrCheckInfo> {
    try {
      const payload = await this.request('check', url)
      if (!this.lifecycle.signal.aborted && validInfo(payload) && payload.url === url && !payload.error) {
        const info: PrCheckInfo = payload
        if (info.checks === undefined) return this.cachedChecks(url)
        if (validChecks(info.checks) && info.headSha) {
          const current = this.cached(url)
          if (current?.headSha !== info.headSha &&
              (current?.lastConfirmedAt ?? 0) > (info.lastConfirmedAt ?? 0)) return this.cachedChecks(url)
          this.db.query('INSERT OR REPLACE INTO pr_status_follower_checks VALUES (?, ?, ?)')
            .run(this.scope, url, JSON.stringify(info))
          return info
        }
      }
    } catch { /* Preserve the last checks known for the current head. */ }
    return this.lifecycle.signal.aborted ? { url, error: 'unavailable' } : this.cachedChecks(url)
  }

  private async request(endpoint: 'revision' | 'sync' | 'check', payload?: unknown): Promise<unknown> {
    const response = await this.fetchPeer(`${this.origin}${PR_STATUS_PEER_PATH}/${endpoint}`, {
      method: endpoint === 'revision' ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      redirect: 'manual',
      signal: AbortSignal.any([this.lifecycle.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
    })
    if (!response.ok) {
      void response.body?.cancel().catch(() => {})
      throw new Error('PR status authority unavailable')
    }
    return boundedJson(response, RESPONSE_BYTES)
  }
}
