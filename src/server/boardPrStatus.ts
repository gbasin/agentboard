// A board's public PR view contains only the identities its transcripts discovered.
// The authority can also hold private records registered by other boards.
import { Hono } from 'hono'
import type { PrInfo, PrCheckInfo } from '../shared/prStatus'
import type { SessionPullRequest } from '../shared/types'
import { canonicalPrUrl } from './prInfo'

interface Provider {
  register(urls: string[]): void
  read(urls: string[]): PrInfo[]
  check(url: string): Promise<PrCheckInfo>
}

export class BoardPrStatus {
  private readonly local = new Set<string>()

  constructor(private readonly provider: Provider) {}

  discover(prs: SessionPullRequest[]): void {
    const added: string[] = []
    for (const pr of prs) {
      const key = canonicalPrUrl(pr.url)
      if (!key || this.local.has(key)) continue
      this.local.add(key)
      added.push(key)
    }
    if (added.length) this.provider.register(added)
  }

  changes(infos: PrInfo[]): PrInfo[] {
    return infos.filter(info => this.local.has(info.url))
  }

  routes() {
    const app = new Hono()
    app.post('/pr-info', async c => {
      const body = await c.req.json().catch(() => null)
      const urls: string[] = Array.isArray(body?.urls)
        ? body.urls.slice(0, 50).filter((u: unknown) => typeof u === 'string')
        : []
      const keys = urls.map(canonicalPrUrl)
      const known = keys.filter((key): key is string => key !== null && this.local.has(key))
      const records = new Map(this.provider.read(known).map(info => [info.url, info]))
      return c.json(urls.map((url, i) => {
        const key = keys[i]
        const info = key && records.get(key)
        return info ? { ...info, url } : { url, error: key ? 'unavailable' : 'invalid url' }
      }))
    })
    app.get('/pr-checks', async c => {
      const url = c.req.query('url') ?? ''
      const key = canonicalPrUrl(url)
      if (!key) return c.json({ error: 'Invalid PR url' }, 400)
      if (!this.local.has(key)) return c.json({ url, error: 'unavailable' })
      return c.json({ ...await this.provider.check(key), url })
    })
    return app
  }
}
