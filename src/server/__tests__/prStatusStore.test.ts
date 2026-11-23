import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PrInfo } from '../../shared/prStatus'
import { GithubPrCooldownError, type GithubPr, type GithubPrTransport } from '../prStatusGithub'
import { PrStatusStore } from '../prStatusStore'

const BASE = 1_800_000_000_000
const POLL_MS = 120_000
const url = (n: number, repo = 'org/repo') => `https://github.com/${repo}/pull/${n}`
const empty = { items: [], etag: null, next: null }

function pull(number: number, updatedAt: number, fields: Partial<GithubPr> = {}): GithubPr {
  return { number, updatedAt, state: 'OPEN', isDraft: false, title: `PR ${number}`, author: 'someone', headSha: 'a'.repeat(40), ...fields }
}

const directories: string[] = []
const stores: PrStatusStore[] = []

afterEach(async () => {
  await Promise.all(stores.splice(0).map(store => store.stop()))
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function setup(overrides: Partial<GithubPrTransport>, path = ':memory:') {
  let now = BASE
  const changes: PrInfo[] = []
  const transport: GithubPrTransport = {
    async list() { return empty },
    async hydrate() { return [] },
    async checks() { return [] },
    ...overrides,
  }
  const store = new PrStatusStore(path, changesToAdd => changes.push(...changesToAdd), { transport, now: () => now })
  stores.push(store)
  return { store, changes, clock: () => now, advance: (ms: number) => { now += ms } }
}

describe('PR status authority store', () => {
  test('uses a canonical identity and only publishes registered PRs', async () => {
    const { store, changes } = setup({
      async list(repo) {
        expect(repo).toBe('org/repo')
        return { ...empty, items: [pull(4, BASE), pull(5, BASE)] }
      },
    })
    const alias = url(4, 'Org/Repo')
    store.register([alias, url(4), 'https://example.com/org/repo/pull/3'])
    await store.poll()
    expect(store.read([alias, url(5)])).toEqual([
      { url: alias, state: 'OPEN', isDraft: false, title: 'PR 4', author: 'someone', headSha: 'a'.repeat(40), lastConfirmedAt: BASE, stale: false },
      { url: url(5), error: 'unavailable' },
    ])
    expect(changes.map(info => info.url)).toEqual([url(4)])
  })

  test('polls open drafts every 30 seconds and quiet repos every two minutes', async () => {
    const calls: string[] = []
    let merged = false
    const { store, advance } = setup({
      async list(repo) {
        calls.push(repo)
        const open = repo === 'org/active' && !merged
        return { ...empty, items: [pull(1, BASE, { state: open ? 'OPEN' : 'MERGED', isDraft: open })] }
      },
    })
    store.register([url(1, 'org/active'), url(1, 'org/quiet')])
    await store.poll()
    calls.length = 0
    advance(29_999)
    await store.poll()
    expect(calls).toEqual([])
    merged = true
    advance(1)
    await store.poll()
    expect(calls).toEqual(['org/active'])
    advance(90_000)
    await store.poll()
    expect(calls).toEqual(['org/active', 'org/quiet'])
  })

  test('backfills in bounded batches and round robins across repositories', async () => {
    const requests: [string, number[]][] = []
    const { store } = setup({
      async hydrate(repo, numbers) {
        requests.push([repo, numbers])
        return numbers.map(number => pull(number, BASE))
      },
    })
    const firstRepo = Array.from({ length: 73 }, (_, i) => url(i + 1, 'org/a'))
    const secondRepo = Array.from({ length: 3 }, (_, i) => url(i + 1, 'org/b'))
    const urls = [...firstRepo, ...secondRepo]
    store.register(urls)
    await store.poll()
    expect(requests.map(([repo, ids]) => [repo, ids.length])).toEqual([
      ['org/a', 25], ['org/b', 3], ['org/a', 25], ['org/a', 23],
    ])
    expect(store.read(urls).every(info => info.state === 'OPEN')).toBe(true)
  })

  test('drains overlap pages and only commits the first-page ETag once the sweep succeeds', async () => {
    const requests: [string | null, string | null][] = []
    let failPage = true
    const { store, advance, clock } = setup({
      async list(_repo, page, etag) {
        requests.push([page, etag])
        if (page === '2' && failPage) throw new Error('offline')
        if (page === '2') return { ...empty, etag: 'p2', items: [pull(7, BASE)] }
        if (etag) return { ...empty, notModified: true }
        return { ...empty, etag: 'first', next: '2', items: [pull(1, BASE)] }
      },
    })
    store.register([url(7)])
    await store.poll()
    expect(store.read([url(7)])[0].error).toBe('unavailable')
    failPage = false
    advance(POLL_MS)
    await store.poll()
    expect(store.read([url(7)])[0].state).toBe('OPEN')
    advance(POLL_MS)
    await store.poll()
    expect(requests).toEqual([[null, null], ['2', null], ['2', null], [null, 'first']])
    expect(store.read([url(7)])[0].lastConfirmedAt).toBe(clock())
  })

  test('keeps snapshots across restart and honors cooldown before stale recovery', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ab-pr-status-'))
    directories.push(directory)
    const path = join(directory, 'store.sqlite')
    const first = setup({ async list() {
      return { ...empty, etag: 'persisted', items: [pull(12, BASE)] }
    } }, path)
    first.store.register([url(12)])
    await first.store.poll()
    await first.store.stop()
    const calls: (string | null)[] = []
    const second = setup({
      async list(_repo, _page, etag) {
        calls.push(etag)
        if (calls.length === 1) throw new GithubPrCooldownError(BASE + 12 * POLL_MS)
        return { ...empty, notModified: true }
      },
    }, path)
    second.advance(3 * POLL_MS)
    await second.store.poll()
    expect(second.store.read([url(12)])[0]).toMatchObject({ state: 'OPEN', stale: true, lastConfirmedAt: BASE })
    expect(second.changes).toHaveLength(1)
    second.advance(POLL_MS)
    await second.store.poll()
    expect(calls).toEqual(['persisted'])
    second.advance(8 * POLL_MS)
    await second.store.poll()
    expect(calls).toEqual(['persisted', 'persisted'])
    expect(second.store.read([url(12)])[0]).toMatchObject({ state: 'OPEN', stale: false, lastConfirmedAt: second.clock() })
    expect(second.changes.map(info => info.stale)).toEqual([true, false])
  })

  test('a GraphQL cooldown still allows REST to deliver a merge', async () => {
    let merged = false
    const { store, advance } = setup({
      async list() { return { ...empty, items: [pull(7, BASE, { state: merged ? 'MERGED' : 'OPEN' })] } },
      async checks() { throw new GithubPrCooldownError(BASE + 30 * POLL_MS, 'graphql') },
    })
    store.register([url(7)])
    await store.poll()
    expect((await store.check(url(7))).error).toBe('unavailable')
    merged = true
    advance(POLL_MS)
    await store.poll()
    expect(store.read([url(7)])[0].state).toBe('MERGED')
  })

  test('keeps checks per repository and head, coalesces concurrent requests and drops exact duplicates', async () => {
    const shaA = 'a'.repeat(40)
    const shaB = 'b'.repeat(40)
    let currentHead = shaA
    let checkCalls = 0
    const check = { name: 'CI', status: 'COMPLETED', conclusion: 'SUCCESS' }
    const pending = Promise.withResolvers<void>()
    const { store, advance, clock } = setup({
      async list() {
        return { ...empty, items: [pull(1, clock(), { headSha: currentHead }), pull(2, clock())] }
      },
      async checks(_repo, _number, headSha) {
        checkCalls++
        await pending.promise
        return headSha === shaA ? [check, check] : []
      },
    })
    store.register([url(1), url(2)])
    await store.poll()
    const checks = Promise.all([store.check(url(1)), store.check(url(2))])
    expect(checkCalls).toBe(1)
    pending.resolve()
    expect((await checks).map(result => [result.url, result.checks])).toEqual([
      [url(1), [check]], [url(2), [check]],
    ])
    currentHead = shaB
    advance(POLL_MS)
    await store.poll()
    expect(await store.check(url(1))).toMatchObject({ headSha: shaB, checks: [] })
    expect(checkCalls).toBe(2)
  })

  test('reconciles missing PRs without replacing their last successful snapshot', async () => {
    let listCalls = 0
    let missing = true
    const { store, advance, clock } = setup({
      async list() {
        listCalls++
        return listCalls === 1
          ? { ...empty, items: [pull(1, BASE)], etag: 'etag' }
          : { ...empty, notModified: true }
      },
      async hydrate() { return missing ? [] : [pull(1, BASE, { state: 'MERGED' })] },
    })
    store.register([url(1)])
    await store.poll()
    advance(24 * 60 * 60_000)
    await store.poll()
    const confirmedAt = clock()
    advance(3 * POLL_MS)
    await store.poll()
    expect(store.read([url(1)])[0]).toMatchObject({ state: 'OPEN', lastConfirmedAt: confirmedAt, stale: true })
    missing = false
    advance(2 * POLL_MS)
    await store.poll()
    expect(store.read([url(1)])[0]).toMatchObject({ state: 'MERGED', lastConfirmedAt: clock(), stale: false })
  })

  test('serves stale check snapshots during failure only for the current head', async () => {
    let foundHead = 'a'.repeat(40)
    let offline = false
    const check = { name: 'CI', status: 'COMPLETED', conclusion: 'SUCCESS' }
    const { store, advance, clock } = setup({
      async list() { return { ...empty, items: [pull(1, clock(), { headSha: foundHead })] } },
      async checks() {
        if (offline) throw new Error('offline')
        return [check]
      },
    })
    store.register([url(1)])
    await store.poll()
    expect(await store.check(url(1))).toMatchObject({ checks: [check], stale: false })
    advance(POLL_MS)
    offline = true
    expect(await store.check(url(1))).toMatchObject({ checks: [check], stale: true })
    foundHead = 'b'.repeat(40)
    await store.poll()
    const result = await store.check(url(1))
    expect(result).toMatchObject({ headSha: foundHead, error: 'unavailable' })
    expect(result.checks).toBeUndefined()
  })
})
