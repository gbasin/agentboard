import { expect, test } from 'bun:test'
import { createGithubPrTransport, GITHUB_PR_BATCH_SIZE, GithubPrCooldownError } from '../prStatusGithub'

function response(status: number, body?: unknown, headers: Record<string, string> = {}) {
  return [
    `HTTP/2.0 ${status}`,
    ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
    '',
    body === undefined ? '' : JSON.stringify(body),
  ].join('\r\n')
}

const updatedAt = '2026-11-23T12:00:00Z'
const sha = '0'.repeat(40)
const graphPr = { number: 42, state: 'OPEN', title: 'Update', author: { login: 'gary' }, isDraft: true, headRefOid: sha, updatedAt }

test('lists updated PRs, distinguishes merged, and reuses an ETag on a page', async () => {
  const requests: string[][] = []
  const transport = createGithubPrTransport(async args => {
    requests.push(args)
    if (requests.length > 1) return response(304)
    const common = { title: 'Update', user: { login: 'gary' }, head: { sha }, updated_at: updatedAt }
    return response(200, [
      { ...common, number: 1, state: 'open', draft: true },
      { ...common, number: 2, state: 'closed', merged_at: null },
      { ...common, number: 3, state: 'closed', merged_at: updatedAt },
    ], {
      ETag: 'W/"one"',
      Link: '<https://api.github.com/repositories/123/pulls?page=2>; rel="next"',
    })
  })
  const result = await transport.list('owner/repo', null, null)
  expect(result.items.map(pr => [pr.state, pr.isDraft, pr.headSha, pr.updatedAt])).toEqual([
    ['OPEN', true, sha, Date.parse(updatedAt)],
    ['CLOSED', false, sha, Date.parse(updatedAt)],
    ['MERGED', false, sha, Date.parse(updatedAt)],
  ])
  expect(result.next).toBe('2')
  expect(requests[0]).toContain('repos/owner/repo/pulls?state=all&sort=updated&direction=desc&per_page=50&page=1')
  expect(await transport.list('owner/repo', result.next, result.etag)).toEqual({
    notModified: true, items: [], etag: 'W/"one"', next: null,
  })
  expect(requests[1]).toContain('If-None-Match: W/"one"')
  expect(requests[1]).toContain('repos/owner/repo/pulls?state=all&sort=updated&direction=desc&per_page=50&page=2')
})

test('rejects pagination outside the requested pulls endpoint', async () => {
  const transport = createGithubPrTransport(async () => response(200, [], {
    Link: '<https://api.github.com/repos/different/repo/pulls?page=2>; rel="next"',
  }))
  await expect(transport.list('owner/repo', null, null)).rejects.toThrow('Invalid GitHub PR pagination link')
})

test('hydrates a limited set of PRs in one GraphQL request and preserves partial successes', async () => {
  let calls = 0
  const transport = createGithubPrTransport(async (args, input) => {
    calls++
    expect(args).toEqual(['--method', 'POST', 'graphql', '--input', '-'])
    const { query, variables } = JSON.parse(input!)
    expect(variables).toEqual({ owner: 'owner', name: 'repo' })
    expect(query).toContain('pr42: pullRequest(number: 42)')
    expect(query).toContain('pr43: pullRequest(number: 43)')
    return response(200, {
      data: { repository: { pr42: graphPr, pr43: null } },
      errors: [{ type: 'NOT_FOUND', path: ['repository', 'pr43'] }],
    })
  })
  expect(await transport.hydrate('owner/repo', [42, 43, 42])).toEqual([{
    number: 42, state: 'OPEN', title: 'Update', author: 'gary', isDraft: true, headSha: sha,
    updatedAt: Date.parse(updatedAt),
  }])
  await expect(transport.hydrate('owner/repo', Array.from({ length: GITHUB_PR_BATCH_SIZE + 1 }, (_, i) => i + 1))).rejects.toThrow('Invalid GitHub PR batch')
  expect(calls).toBe(1)
})

test('loads at most 20 checks directly by SHA and maps both context formats', async () => {
  const transport = createGithubPrTransport(async (_args, input) => {
    const { query, variables } = JSON.parse(input!)
    expect(query).toContain('contexts(first: 20)')
    expect(variables.oid).toBe(sha)
    return response(200, { data: { repository: { object: { statusCheckRollup: { contexts: { nodes: [
      { name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS', detailsUrl: '/build' },
      { context: 'legacy', state: 'PENDING', targetUrl: '/legacy' },
    ] } } } } } })
  })
  expect(await transport.checks('owner/repo', 42, sha)).toEqual([
    { name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS', link: '/build' },
    { name: 'legacy', status: 'IN_PROGRESS', conclusion: null, link: '/legacy' },
  ])
})

test('honors separate primary budgets, then applies Retry-After to both', async () => {
  let now = 1_000_000
  let calls = 0
  const transport = createGithubPrTransport(async () => {
    calls++
    if (calls === 1) return response(200, [], { 'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset': '1100' })
    if (calls === 2) return response(429, { message: 'Secondary rate limit' }, { 'Retry-After': '120' })
    return response(200, [])
  }, () => now)
  await transport.list('owner/repo', null, null)
  await expect(transport.list('owner/repo', null, null)).rejects.toMatchObject({ retryAt: 1_100_000 })
  await expect(transport.hydrate('owner/repo', [42])).rejects.toBeInstanceOf(GithubPrCooldownError)
  await expect(transport.list('owner/repo', null, null)).rejects.toMatchObject({ retryAt: 1_120_000 })
  expect(calls).toBe(2)
  now = 1_120_000
  await transport.list('owner/repo', null, null)
  expect(calls).toBe(3)
})

test('honors GitHub GraphQL HTTP 200 rate-limit errors without blocking REST', async () => {
  const errors = [
    { type: 'RATE_LIMIT', code: 'graphql_rate_limit' },
    { extensions: { code: 'RATE_LIMITED' } },
  ]
  for (const error of errors) {
    let now = 1_000_000
    let graphqlCalls = 0
    const transport = createGithubPrTransport(async args => {
      if (args.includes('graphql')) {
        graphqlCalls++
        return response(200, { errors: [error] })
      }
      return response(200, [])
    }, () => now)
    await expect(transport.hydrate('owner/repo', [42])).rejects.toMatchObject({
      retryAt: 1_060_000, bucket: 'graphql',
    })
    await expect(transport.checks('owner/repo', 42, sha)).rejects.toBeInstanceOf(GithubPrCooldownError)
    expect((await transport.list('owner/repo', null, null)).items).toEqual([])
    expect(graphqlCalls).toBe(1)
    now = 1_060_000
    await expect(transport.hydrate('owner/repo', [42])).rejects.toMatchObject({ retryAt: 1_120_000 })
    expect(graphqlCalls).toBe(2)
  }
})

test('bounds admission and does not run queued calls during a cooldown', async () => {
  const gate = Promise.withResolvers<void>()
  let calls = 0
  const transport = createGithubPrTransport(async () => {
    calls++
    await gate.promise
    return response(429, {}, { 'Retry-After': '60' })
  })
  const pending = Array.from({ length: 128 }, () => transport.list('owner/repo', null, null))
  const settled = Promise.allSettled(pending)
  expect(calls).toBe(4)
  await expect(transport.list('owner/repo', null, null)).rejects.toThrow('queue is full')
  gate.resolve()
  const results = await settled
  expect(results.every(result => result.status === 'rejected' && result.reason instanceof GithubPrCooldownError)).toBe(true)
  expect(calls).toBe(4)
})
