import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { PR_STATUS_STALE_MS, type PrInfo } from '../../shared/prStatus'
import { mountPrStatusPeer, PR_STATUS_PEER_PATH, recordDigest } from '../prStatusPeer'
import type { GithubPr } from '../prStatusGithub'
import { createPrStatusProvider, PrStatusFollower } from '../prStatusProvider'

const token = 'a'.repeat(32)
const origin = 'https://authority.example'
const url = 'https://github.com/owner/repo/pull/1'
const secondUrl = 'https://github.com/owner/repo/pull/2'
const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
const fresh: PrInfo = { url, state: 'OPEN', title: 'Peer status', headSha: 'abcdef', lastConfirmedAt: 100 }

const directories: string[] = []
function temporaryPath() {
  const dir = mkdtempSync(join(tmpdir(), 'ab-pr-status-peer-'))
  directories.push(dir)
  return join(dir, 'status.sqlite')
}

afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function fakeAuthority() {
  const app = new Hono()
  const records = new Map([[url, fresh]])
  const registered = new Set<string>()
  let checks = 0
  let revision = 'one'
  mountPrStatusPeer(app, {
    register: urls => urls.forEach(item => registered.add(item)),
    read: urls => urls.flatMap(item => records.get(item) ?? []),
    check: async item => {
      checks++
      return { ...records.get(item), url: item, checks: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }] }
    },
  }, token, () => revision)
  return { app, registered, records, checkCount: () => checks, changeRevision: () => { revision = 'two' } }
}

function post(app: Hono, endpoint: string, body: unknown, requestHeaders?: HeadersInit) {
  return app.request(`${PR_STATUS_PEER_PATH}/${endpoint}`, {
    method: 'POST', headers: requestHeaders, body: JSON.stringify(body),
  })
}

describe('PR status peer transport', () => {
  test('rejects unauthenticated and browser requests before registration', async () => {
    const { app, registered } = fakeAuthority()
    const body = [[url, null]]
    expect((await post(app, 'sync', body)).status).toBe(401)
    expect((await post(app, 'sync', body, { Authorization: 'Bearer wrong' })).status).toBe(401)
    expect((await post(app, 'sync', body, { ...headers, Origin: origin })).status).toBe(401)
    expect((await post(app, 'check', url, { ...headers, 'Sec-Fetch-Site': 'same-origin' })).status).toBe(401)
    expect(registered.size).toBe(0)
  })

  test('limits registration to validated identities and sends only requested deltas', async () => {
    const { app, registered, records } = fakeAuthority()
    records.set(secondUrl, { ...fresh, url: secondUrl })
    expect((await post(app, 'sync', [[url, null], ['https://elsewhere.invalid/anything', null]], headers)).status).toBe(400)
    expect((await post(app, 'sync', Array.from({ length: 129 }, () => [url, null]), headers)).status).toBe(400)
    expect(registered.size).toBe(0)
    const reply = await post(app, 'sync', [[url, null]], headers)
    expect(reply.headers.get('Cache-Control')).toBe('no-store')
    expect(await reply.json()).toEqual([fresh])
    expect(await (await post(app, 'sync', [[url, recordDigest(fresh)]], headers)).json()).toEqual([])
    expect([...registered]).toEqual([url])
  })

  test('keeps peer endpoints disabled by default and refuses insecure follower origins', async () => {
    const path = temporaryPath()
    const local = createPrStatusProvider(path, () => {}, {})
    const app = new Hono()
    local.mount(app)
    expect((await post(app, 'sync', [[url, null]], headers)).status).toBe(404)
    for (const invalid of ['http://remote.example', 'https://remote.example/prefix', 'https://user@remote.example']) {
      expect(() => createPrStatusProvider(path, () => {}, {
        AGENTBOARD_PR_STATUS_AUTHORITY_URL: invalid,
        AGENTBOARD_PR_STATUS_TOKEN: token,
      })).toThrow()
    }
    expect(() => createPrStatusProvider(path, () => {}, { AGENTBOARD_PR_STATUS_AUTHORITY_URL: origin })).toThrow()
  })

  test('replicates new PRs, serves stale data on outage and restart, then reconnects', async () => {
    const { app, registered, records, checkCount, changeRevision } = fakeAuthority()
    const observed: PrInfo[][] = []
    let available = true
    const calls: Request[] = []
    const fetchPeer = (async (uri: string, init: RequestInit) => {
      expect(init.redirect).toBe('manual')
      const req = new Request(uri, init)
      calls.push(req.clone())
      return available ? app.fetch(req) : new Response(null, { status: 503 })
    }) as typeof fetch
    const path = temporaryPath()
    const follower = new PrStatusFollower(path, origin, token, delta => observed.push(delta), { fetch: fetchPeer, now: () => 200 })
    const followerApp = new Hono()
    follower.mount(followerApp)
    expect((await post(followerApp, 'sync', [[url, null]], headers)).status).toBe(404)
    expect(follower.read([url])[0].error).toBe('unavailable')
    follower.register([url, url])
    await follower.sync()
    expect([...registered]).toEqual([url])
    expect(observed).toEqual([[{ ...fresh, stale: false }]])
    await follower.sync()
    expect(calls.at(-1)?.url).toEndWith('/revision')
    expect(calls).toHaveLength(3)
    changeRevision()
    await follower.sync()
    expect(await calls.at(-1)?.json()).toEqual([[url, recordDigest(fresh)]])
    expect(observed).toHaveLength(1)
    const [checks, duplicate] = await Promise.all([follower.check(url), follower.check(url)])
    expect(checks.checks).toEqual(duplicate.checks)
    expect(checkCount()).toBe(1)
    expect((await follower.check(secondUrl)).error).toBe('unavailable')
    expect(checkCount()).toBe(1)

    available = false
    await follower.sync()
    expect(observed.at(-1)).toEqual([{ ...fresh, stale: true }])
    expect(follower.read([url])).toEqual([{ ...fresh, stale: true }])
    expect(await follower.check(url)).toMatchObject({ stale: true, checks: checks.checks })
    await follower.stop()

    const restarted = new PrStatusFollower(path, origin, token, delta => observed.push(delta), { fetch: fetchPeer, now: () => 200 })
    restarted.register([url])
    expect(restarted.read([url])).toEqual([{ ...fresh, stale: true }])
    expect(await restarted.check(url)).toMatchObject({ stale: true, checks: checks.checks })
    const merged = { ...fresh, state: 'MERGED', headSha: 'new-head', lastConfirmedAt: 200 }
    records.set(url, merged)
    available = true
    await restarted.sync()
    expect(observed.at(-1)).toEqual([{ ...merged, stale: false }])
    available = false
    expect((await restarted.check(url)).checks).toBeUndefined()
    await restarted.stop()
  })

  test('retries a partially applied sweep before recording the revision', async () => {
    const { app, records, changeRevision } = fakeAuthority()
    const everyUrl = Array.from({ length: 129 }, (_, i) =>
      `https://github.com/owner/repo/pull/${i + 1}`)
    const tail = everyUrl.at(-1)!
    records.set(tail, { ...fresh, url: tail })
    let rejectTail = false
    let syncCalls = 0
    const fetchPeer = (async (uri: string, init: RequestInit) => {
      if (uri.endsWith('/sync')) {
        syncCalls++
        const items = JSON.parse(init.body as string) as string[][]
        if (rejectTail && items.some(([url]) => url === tail)) return new Response(null, { status: 503 })
      }
      return app.fetch(new Request(uri, init))
    }) as typeof fetch
    const follower = new PrStatusFollower(temporaryPath(), origin, token, () => {}, { fetch: fetchPeer, now: () => 200 })
    follower.register(everyUrl)
    await follower.sync()
    expect(syncCalls).toBe(2)
    records.set(url, { ...fresh, title: 'new title' })
    records.set(tail, { ...fresh, url: tail, state: 'MERGED' })
    changeRevision()
    rejectTail = true
    await follower.sync()
    expect(follower.read([url, tail])).toMatchObject([
      { title: 'new title', stale: true }, { state: 'OPEN', stale: true },
    ])
    rejectTail = false
    await follower.sync()
    expect(syncCalls).toBe(6)
    expect(follower.read([url, tail])).toMatchObject([
      { title: 'new title' }, { state: 'MERGED' },
    ])
    await follower.sync()
    expect(syncCalls).toBe(6)
    await follower.stop()
  })


  test('shares one upstream lookup across an authority and two followers', async () => {
    const item: GithubPr = {
      number: 1, state: 'OPEN', isDraft: false, title: 'One lookup', author: 'octo',
      headSha: fresh.headSha!, updatedAt: 100,
    }
    let lists = 0
    let hydrations = 0
    let checks = 0
    let now = 100
    const authorityPath = temporaryPath()
    const authorityReady = Promise.withResolvers<void>()
    const authority = createPrStatusProvider(authorityPath, () => authorityReady.resolve(), {
      AGENTBOARD_PR_STATUS_TOKEN: token,
    }, {
      now: () => now,
      transport: {
        list: async () => { lists++; return { items: [item], etag: 'version', next: null } },
        hydrate: async () => { hydrations++; return [] },
        checks: async () => { checks++; return [] },
      },
    })
    const authorityApp = new Hono()
    authority.mount(authorityApp)
    const fetchPeer = ((uri: string, init: RequestInit) => authorityApp.fetch(new Request(uri, init))) as typeof fetch
    const followerPath = temporaryPath()
    const followerEnv = {
      AGENTBOARD_PR_STATUS_AUTHORITY_URL: origin,
      AGENTBOARD_PR_STATUS_TOKEN: token,
    }
    const a = createPrStatusProvider(followerPath, () => {}, followerEnv, { fetch: fetchPeer, now: () => now }) as PrStatusFollower
    const b = createPrStatusProvider(temporaryPath(), () => {}, followerEnv, { fetch: fetchPeer, now: () => now }) as PrStatusFollower
    a.register([url])
    b.register([url])
    await Promise.all([a.sync(), b.sync()])
    expect(lists).toBe(0)
    expect(a.read([url])[0].error).toBe('unavailable')
    authority.start()
    await authorityReady.promise
    await Promise.all([a.sync(), b.sync()])
    expect(a.read([url])).toEqual(authority.read([url]))
    expect(b.read([url])).toEqual(authority.read([url]))
    expect(lists).toBe(1)
    expect(hydrations).toBe(0)
    await Promise.all([a.check(url), b.check(url), authority.check(url)])
    expect(checks).toBe(1)
    now += PR_STATUS_STALE_MS
    expect(a.read([url])[0].stale).toBe(true)

    await Promise.all([a.stop(), b.stop(), authority.stop()])
    const localAfterFollower = createPrStatusProvider(followerPath, () => {}, {})
    const followerAfterLocal = createPrStatusProvider(authorityPath, () => {}, followerEnv)
    localAfterFollower.register([url])
    followerAfterLocal.register([url])
    expect(localAfterFollower.read([url])[0].error).toBe('unavailable')
    expect(followerAfterLocal.read([url])[0].error).toBe('unavailable')
    await Promise.all([localAfterFollower.stop(), followerAfterLocal.stop()])
  })
})
