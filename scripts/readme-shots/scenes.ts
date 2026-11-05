// scenes.ts - The invented sessions shown in the README visuals.
//
// Every string here is fiction: project names, prompts, PRs, hosts. Nothing
// is read from the machine running the script. A scene drives three things:
// the fixture TUI in its tmux pane (agent-tui.ts), the transcript the server
// matches to that pane (transcripts.ts), and the PR data the fake `gh`
// returns (shims.ts).

export type AgentKind = 'claude' | 'codex'
export type PaneMode = 'working' | 'waiting' | 'permission'

export type Block =
  | { t: 'user'; text: string }
  | { t: 'say'; text: string }
  | { t: 'tool'; name: string; arg: string; out: string[] }
  | { t: 'diff'; file: string; summary: string; lines: [number, ' ' | '+' | '-', string][] }
  | { t: 'todo'; items: [boolean, string][] }

export interface PullRequest {
  repo: string
  number: number
  title: string
  state: 'OPEN' | 'MERGED' | 'CLOSED'
  isDraft?: boolean
  checks: [name: string, conclusion: 'SUCCESS' | 'FAILURE' | 'PENDING' | 'SKIPPED'][]
}

export interface Scene {
  /** tmux window name, shown as the session name. */
  id: string
  agent: AgentKind
  /** Directory name under the fake HOME. */
  project: string
  host: 'local' | 'remote'
  /** Initial pane mode once matching is done. */
  mode: PaneMode
  /** Spinner caption while working. */
  activity?: string
  /** Seconds already elapsed on the spinner. */
  elapsed?: number
  permission?: { title: string; command: string; description: string; always: string }
  /** Visible transcript; the last `user` block is the session's last prompt. */
  blocks: Block[]
  prs?: PullRequest[]
  /** Generated attachments (media rail). */
  media?: boolean
  /** Minutes ago of the transcript's first and last entries. */
  startedMinutesAgo: number
}

export const ROUTER: Scene = {
  id: 'router-refactor',
  agent: 'claude',
  project: 'acme-api',
  host: 'local',
  mode: 'working',
  activity: 'Migrating route handlers',
  elapsed: 94,
  startedMinutesAgo: 38,
  prs: [{
    repo: 'acme/api', number: 482, title: 'Typed route params for the v2 router', state: 'OPEN',
    checks: [['build', 'SUCCESS'], ['unit tests', 'SUCCESS'], ['integration', 'SUCCESS'], ['lint', 'SUCCESS']],
  }],
  blocks: [
    { t: 'user', text: 'the router still uses the legacy middleware chain, can you look at what depends on it?' },
    { t: 'say', text: 'Three handlers read `req.params` through the legacy chain: users, orgs and invoices. Everything else already goes through `createRouter`.' },
    { t: 'user', text: 'refactor the router to typed route params and drop the legacy middleware chain' },
    { t: 'say', text: "I'll move each handler onto `createRouter` with a typed params schema, then delete `legacyChain` once nothing imports it." },
    { t: 'todo', items: [[true, 'Add a params schema to createRouter'], [true, 'Migrate users handlers'], [false, 'Migrate orgs and invoices handlers'], [false, 'Delete src/middleware/legacyChain.ts'], [false, 'Run the router test suite']] },
    { t: 'tool', name: 'Read', arg: 'src/router/index.ts', out: ['Read 182 lines'] },
    {
      t: 'diff', file: 'src/router/users.ts', summary: 'Updated src/router/users.ts with 9 additions and 7 removals',
      lines: [
        [12, ' ', "import { createRouter, z } from './createRouter'"],
        [13, '-', "import { legacyChain } from '../middleware/legacyChain'"],
        [14, ' ', ''],
        [15, '-', "app.get('/users/:id', legacyChain(auth, loadUser), (req, res) => {"],
        [16, '-', '  const id = Number(req.params.id)'],
        [15, '+', 'export const users = createRouter({ prefix: \'/users\', use: [auth] })'],
        [16, '+', ''],
        [17, '+', "users.get('/:id', { params: z.object({ id: z.coerce.number() }) }, async ({ params }) => {"],
        [18, '+', '  const user = await db.users.find(params.id)'],
        [19, ' ', '  if (!user) throw notFound()'],
        [20, ' ', '  return serialize(user)'],
        [21, ' ', '})'],
      ],
    },
    { t: 'tool', name: 'Bash', arg: 'bun test src/router/users', out: ['14 pass, 0 fail  ·  412ms'] },
    { t: 'say', text: 'Users is done and its tests pass. Moving on to orgs and invoices, which share the `withOrg` loader.' },
    {
      t: 'diff', file: 'src/router/orgs.ts', summary: 'Updated src/router/orgs.ts with 6 additions and 5 removals',
      lines: [
        [8, '-', "app.get('/orgs/:orgId/members', legacyChain(auth, withOrg), (req, res) => {"],
        [8, '+', "orgs.get('/:orgId/members', { params: OrgParams }, async ({ params, org }) => {"],
        [9, ' ', '  const members = await db.members.list(org.id, { limit: 100 })'],
        [10, ' ', '  return members.map(serializeMember)'],
        [11, ' ', '})'],
      ],
    },
  ],
}

export const MIGRATION: Scene = {
  id: 'orders-migration',
  agent: 'claude',
  project: 'acme-api',
  host: 'local',
  mode: 'permission',
  activity: 'Writing migration',
  elapsed: 41,
  startedMinutesAgo: 12,
  permission: {
    title: 'Bash command',
    command: 'bun run db:migrate --env staging',
    description: 'Apply 0042_backfill_order_currency to the staging database',
    always: 'bun run db:migrate',
  },
  prs: [{
    repo: 'acme/api', number: 489, title: 'Backfill orders.currency from accounts', state: 'OPEN', isDraft: true,
    checks: [['build', 'SUCCESS'], ['unit tests', 'PENDING']],
  }],
  blocks: [
    { t: 'user', text: 'write a migration that backfills orders.currency from the accounts table' },
    { t: 'tool', name: 'Read', arg: 'db/schema/orders.sql', out: ['Read 64 lines'] },
    { t: 'say', text: 'Orders created before March have a null currency. I\'ll copy it from the owning account in batches of 5,000 so the table is never locked for long.' },
    {
      t: 'diff', file: 'db/migrations/0042_backfill_order_currency.ts', summary: 'Wrote 23 lines to db/migrations/0042_backfill_order_currency.ts',
      lines: [
        [1, '+', "import { batched } from '../lib/batched'"],
        [2, '+', ''],
        [3, '+', 'export async function up(db) {'],
        [4, '+', "  await batched(db, 'orders', { where: 'currency IS NULL', size: 5_000 }, (ids) =>"],
        [5, '+', '    db.query(`UPDATE orders o SET currency = a.currency'],
        [6, '+', '              FROM accounts a WHERE a.id = o.account_id AND o.id = ANY($1)`, [ids]))'],
        [7, '+', '}'],
      ],
    },
    { t: 'tool', name: 'Bash', arg: 'bun run db:migrate --env local', out: ['0042_backfill_order_currency  ✓  18,204 rows  ·  2.1s'] },
    { t: 'say', text: 'The local run backfilled 18,204 rows and the row counts match. Next I need to run it against staging.' },
  ],
}

export const CHECKOUT: Scene = {
  id: 'flaky-checkout-test',
  agent: 'codex',
  project: 'storefront',
  host: 'local',
  mode: 'waiting',
  startedMinutesAgo: 64,
  prs: [{
    repo: 'acme/storefront', number: 1193, title: 'Wait for the cart total before asserting checkout', state: 'OPEN',
    checks: [['build', 'SUCCESS'], ['unit', 'SUCCESS'], ['e2e (chromium)', 'FAILURE'], ['e2e (webkit)', 'SUCCESS']],
  }],
  blocks: [
    { t: 'user', text: 'fix the flaky checkout test, it times out about one run in twenty' },
    { t: 'tool', name: 'Ran', arg: 'bun test e2e/checkout.spec.ts --repeat 40', out: ['38 passed, 2 failed (timeout in waitForCartTotal)'] },
    { t: 'say', text: 'The test asserts the total before the cart request settles. It passes when the mock responds within the 100 ms poll.' },
    {
      t: 'diff', file: 'e2e/checkout.spec.ts', summary: 'Edited e2e/checkout.spec.ts (+3 -2)',
      lines: [
        [41, '-', '  await page.waitForTimeout(100)'],
        [41, '+', "  await page.waitForResponse((r) => r.url().endsWith('/api/cart'))"],
        [42, ' ', "  await expect(page.getByTestId('cart-total')).toHaveText('$48.00')"],
      ],
    },
    { t: 'tool', name: 'Ran', arg: 'bun test e2e/checkout.spec.ts --repeat 200', out: ['200 passed'] },
    { t: 'tool', name: 'Ran', arg: 'gh pr create --fill', out: ['https://github.com/acme/storefront/pull/1193'] },
    { t: 'say', text: 'Opened #1193. CI shows one e2e failure on chromium in an unrelated spec (search suggestions); I left the PR open for review.' },
  ],
}

export const REVIEW: Scene = {
  id: 'review-pr-1187',
  agent: 'claude',
  project: 'storefront',
  host: 'local',
  mode: 'waiting',
  startedMinutesAgo: 95,
  blocks: [
    { t: 'user', text: 'review PR #1187 and flag anything risky before I merge it' },
    { t: 'tool', name: 'Bash', arg: 'gh pr diff 1187', out: ['+312 −88 across 11 files'] },
    { t: 'say', text: 'Two things worth a look before merging:\n1. `applyCoupon` now runs before tax, so stacked coupons can drop the total below zero.\n2. The new `promo_codes` index is not created concurrently and will lock the table during deploy.\nThe rest is a straightforward rename.' },
  ],
}

export const LATENCY: Scene = {
  id: 'latency-report',
  agent: 'claude',
  project: 'metrics',
  host: 'local',
  mode: 'waiting',
  media: true,
  startedMinutesAgo: 140,
  blocks: [
    { t: 'user', text: "pull last week's p95 latency for every endpoint from the metrics store" },
    { t: 'tool', name: 'Bash', arg: 'bun run metrics:export --since 7d --metric http_p95', out: ['exported 2,114,880 samples for 31 endpoints'] },
    { t: 'say', text: 'Only `GET /search` moved noticeably; everything else is within 5% of the week before.' },
    { t: 'user', text: 'chart p95 latency per endpoint for last week and write up what regressed' },
    { t: 'tool', name: 'Bash', arg: 'bun run report:latency --since 7d --out charts/', out: ['wrote charts/p95-by-endpoint.png, charts/p95-trend.png'] },
    { t: 'tool', name: 'Read', arg: 'charts/p95-by-endpoint.png', out: ['Read image (1200×720)'] },
    { t: 'tool', name: 'Read', arg: 'charts/p95-trend.png', out: ['Read image (1200×720)'] },
    { t: 'say', text: 'The jump starts Tuesday at 14:05, which matches the ranking v3 deploy. Profiling a `/search` request to see where the time goes.' },
    { t: 'tool', name: 'Bash', arg: 'bun run profile:search --duration 30s --out charts/search-profile.png', out: ['1,204 samples · 72% in rankResults → loadVectors'] },
    { t: 'tool', name: 'Read', arg: 'charts/search-profile.png', out: ['Read image (1200×720)'] },
    { t: 'tool', name: 'Read', arg: 'reports/latency-week-44.pdf', out: ['Read PDF (2 pages)'] },
    { t: 'say', text: '`GET /search` regressed from 180 ms to 410 ms p95 because ranking v3 parses every candidate vector from JSON on each request. Caching the decoded vectors per index version should bring it back. The write-up is in reports/latency-week-44.pdf and the dashboard is at https://grafana.example.com/d/api-latency.' },
  ],
}

export const NIGHTLY: Scene = {
  id: 'nightly-e2e',
  agent: 'codex',
  project: 'payments',
  host: 'remote',
  mode: 'working',
  activity: 'Bisecting',
  elapsed: 312,
  startedMinutesAgo: 20,
  blocks: [
    { t: 'user', text: 'bisect the nightly e2e failure in the payments suite' },
    { t: 'tool', name: 'Ran', arg: 'git bisect start main v2.14.0', out: ['Bisecting: 37 revisions left to test after this (roughly 5 steps)'] },
    { t: 'tool', name: 'Ran', arg: 'bun test e2e/payments --bail', out: ['refund.spec.ts  ✗  expected status 200, received 409'] },
  ],
}

export const BENCH: Scene = {
  id: 'resize-worker-bench',
  agent: 'claude',
  project: 'media-worker',
  host: 'remote',
  mode: 'waiting',
  startedMinutesAgo: 50,
  blocks: [
    { t: 'user', text: 'profile the image resize worker under load' },
    { t: 'tool', name: 'Bash', arg: 'bun run bench:resize --concurrency 32', out: ['1,840 img/s  ·  p99 74 ms  ·  RSS 612 MB'] },
    { t: 'say', text: 'Throughput is CPU-bound in the JPEG decoder; memory is stable.' },
  ],
}

/** Live sessions, in creation order (oldest first). */
export const ACTIVE: Scene[] = [LATENCY, REVIEW, CHECKOUT, ROUTER, MIGRATION]
export const REMOTE: Scene[] = [BENCH, NIGHTLY]

/** Dormant sessions: transcripts with no pane. */
export interface Dormant {
  id: string
  agent: AgentKind
  project: string
  /** Earlier exchanges, oldest first, before the final prompt/reply. */
  earlier?: [prompt: string, reply: string][]
  prompt: string
  reply: string
  minutesAgo: number
  hibernate: boolean
  prs?: PullRequest[]
}

export const DORMANT: Dormant[] = [
  {
    id: 'token-rotation', agent: 'claude', project: 'acme-api', minutesAgo: 180, hibernate: true,
    prompt: 'rotate the signing keys without logging anyone out',
    reply: 'Both keys are now accepted for 24 hours; the old key is removed by the cron job in `ops/rotate.ts`.',
  },
  {
    id: 'pricing-a11y', agent: 'codex', project: 'storefront', minutesAgo: 300, hibernate: true,
    prompt: 'fix the keyboard focus order on the pricing page',
    reply: 'Focus now moves plan by plan and the toggle is reachable with Tab.',
  },
  {
    id: 'react-19', agent: 'claude', project: 'admin', minutesAgo: 60 * 7, hibernate: false,
    earlier: [['which dependencies block a React 19 upgrade in the admin app?', 'Only `react-table` v7, which still reads `defaultProps`. Everything else already supports 19.']],
    prompt: 'upgrade the admin app to React 19 and fix the type errors',
    reply: 'The upgrade is done. I replaced the three `forwardRef` wrappers and removed `defaultProps` from the table components. Type check and tests pass.',
  },
  {
    id: 'queue-leak', agent: 'codex', project: 'acme-api', minutesAgo: 60 * 15, hibernate: false,
    earlier: [['the queue worker restarts every few hours with OOM, can you reproduce it?', 'Yes: RSS grows by about 2 MB per 100 retried jobs and never drops back.']],
    prompt: 'find the memory leak in the queue worker',
    reply: 'Each retry added a listener to the shared emitter and never removed it. The worker now holds steady at 140 MB over 10,000 jobs.',
  },
  {
    id: 'rate-limit', agent: 'claude', project: 'acme-api', minutesAgo: 60 * 21, hibernate: false,
    earlier: [['what do we do today when one API key floods us?', 'Nothing per key: the only limit is the global nginx connection cap.']],
    prompt: 'add rate limiting to the public API',
    reply: 'Requests are limited per API key with a sliding window in Redis: 600 per minute by default, configurable per plan.',
    prs: [{ repo: 'acme/api', number: 455, title: 'Rate limit the public API per key', state: 'MERGED', checks: [['build', 'SUCCESS'], ['unit tests', 'SUCCESS']] }],
  },
]

export const ALL_SCENES: Scene[] = [...ACTIVE, ...REMOTE]

export function sceneById(id: string): Scene {
  const scene = ALL_SCENES.find((s) => s.id === id)
  if (!scene) throw new Error(`unknown scene ${id}`)
  return scene
}

/** A scene for any pane, including a dormant session's short-lived window. */
export function fixtureScene(id: string): Scene {
  const scene = ALL_SCENES.find((s) => s.id === id)
  if (scene) return scene
  const dormant = DORMANT.find((d) => d.id === id)
  if (!dormant) throw new Error(`unknown scene ${id}`)
  return {
    id, agent: dormant.agent, project: dormant.project, host: 'local', mode: 'waiting',
    startedMinutesAgo: dormant.minutesAgo,
    blocks: [
      ...(dormant.earlier ?? []).flatMap(([prompt, reply]): Block[] => [{ t: 'user', text: prompt }, { t: 'say', text: reply }]),
      { t: 'user', text: dormant.prompt },
      { t: 'say', text: dormant.reply },
    ],
  }
}

/** The last prompt of a scene (what the sidebar shows). */
export function lastPrompt(scene: Scene): string {
  const users = scene.blocks.filter((b): b is Extract<Block, { t: 'user' }> => b.t === 'user')
  return users[users.length - 1]!.text
}
