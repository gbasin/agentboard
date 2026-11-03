// github.ts - The GitHub operations execution performs through `gh`
// (plan-execution D10, D13, D14): pull requests (list, create, view, merge
// with the reviewed head pinned), a commit's check runs and statuses
// normalized to `CiCheck`, the failed-run rerun, and the pinned
// update-branch. Every call goes through `runGh` (argument array, timeout,
// bounded redacted output) and carries the repo explicitly (`-R` / the api
// path), so nothing depends on the process's cwd resolving a repository.
// Failures keep gh's message plus the HTTP status when gh reports one — the
// error shape the classifier (D14) reads.
import type { CiCheck, MergeMethod } from '../../../shared/planExecution'
import { MERGE_METHODS } from '../../../shared/planExecution'
import { runGh, type GhCommandOptions } from './ghCommand'

/** One gh call's failure: argv, process exit (null = timeout/spawn), HTTP status when gh named one, and its message. */
export interface GithubError {
  argv: string[]
  exitCode: number | null
  httpStatus: number | null
  message: string
  /** True only when gh itself could not be started (a `runGh` spawn failure); the message carries the redacted cause. */
  spawnFailure?: true
}

export type GithubOutcome<T> = { ok: true; data: T } | { ok: false; error: GithubError }

export interface PrSummary {
  number: number
  url: string
  state: string
  headRefOid: string
}

export interface PrDetail extends PrSummary {
  mergeCommit: string | null
}

const HTTP_IN_STDERR = /HTTP (\d{3})/

type Call = { ok: true; stdout: string } | { ok: false; error: GithubError }

async function call(args: string[], options: GhCommandOptions = {}): Promise<Call> {
  const result = await runGh(args, options)
  if (result.ok) return { ok: true, stdout: result.stdout }
  // gh never ran: keep the spawn error as the message (D14's gh-spawn row),
  // typed so the classifier can call it permanent without guessing from an
  // unknown null exit, which stays the timeout shape below.
  if (result.spawnError !== undefined) {
    return {
      ok: false,
      error: { argv: ['gh', ...args], exitCode: null, httpStatus: null, message: `gh could not be started: ${result.spawnError}`, spawnFailure: true },
    }
  }
  const stderr = result.stderr.trim()
  const found = HTTP_IN_STDERR.exec(stderr)
  return {
    ok: false,
    error: { argv: ['gh', ...args], exitCode: result.exitCode, httpStatus: found ? Number(found[1]) : null, message: stderr || `gh exited ${result.exitCode ?? 'without an exit'}` },
  }
}

function json<T>(stdout: string): { ok: true; data: T } | { ok: false; error: string } {
  try {
    return { ok: true, data: JSON.parse(stdout) as T }
  } catch (error) {
    return { ok: false, error: `gh printed unparseable JSON: ${(error as Error).message}` }
  }
}

/** `gh pr list` for one change's branch; `state` defaults to all (D14's open-pr inspection). */
export async function ghPrList(repo: string, input: { head: string; base: string; state?: string }, options: GhCommandOptions = {}): Promise<GithubOutcome<PrSummary[]>> {
  const args = ['pr', 'list', '-R', repo, '--head', input.head, '--base', input.base, '--state', input.state ?? 'all', '--json', 'number,url,state,headRefOid']
  const result = await call(args, options)
  if (!result.ok) return result
  const parsed = json<PrSummary[]>(result.stdout)
  if (!parsed.ok) return { ok: false, error: { argv: ['gh', ...args], exitCode: 0, httpStatus: null, message: parsed.error } }
  return { ok: true, data: parsed.data }
}

/**
 * Open the change's one pull request, naming the plan, revision, change, and
 * task (plan-landing): `gh api -X POST repos/{repo}/pulls` — `gh pr create`
 * has no `--json` and exits 1 on it. The fields go as literal `-f` values,
 * never `-F`, whose `@<path>` form would read the body from a file, and the
 * REST response's `html_url` is the returned link (its `url` field is the
 * API URL, not the pull request page).
 */
export async function ghPrCreate(repo: string, input: { head: string; base: string; title: string; body: string }, options: GhCommandOptions = {}): Promise<GithubOutcome<{ number: number; url: string }>> {
  const args = ['api', '-X', 'POST', `repos/${repo}/pulls`, '-f', `head=${input.head}`, '-f', `base=${input.base}`, '-f', `title=${input.title}`, '-f', `body=${input.body}`]
  const result = await call(args, options)
  if (!result.ok) return result
  const parsed = json<{ number?: unknown; html_url?: unknown }>(result.stdout)
  if (!parsed.ok || typeof parsed.data.number !== 'number' || typeof parsed.data.html_url !== 'string' || parsed.data.html_url === '') {
    return { ok: false, error: { argv: ['gh', ...args], exitCode: 0, httpStatus: null, message: parsed.ok ? 'the create response carries no pull request number or html_url' : parsed.error } }
  }
  return { ok: true, data: { number: parsed.data.number, url: parsed.data.html_url } }
}

/** `gh pr view`: state, head, and the merge commit once merged (D13/D14). */
export async function ghPrView(repo: string, prNumber: number, options: GhCommandOptions = {}): Promise<GithubOutcome<PrDetail>> {
  const args = ['pr', 'view', String(prNumber), '-R', repo, '--json', 'number,url,state,headRefOid,mergeCommit']
  const result = await call(args, options)
  if (!result.ok) return result
  const parsed = json<{ number: number; url: string; state: string; headRefOid: string; mergeCommit?: { oid: string } | null }>(result.stdout)
  if (!parsed.ok) return { ok: false, error: { argv: ['gh', ...args], exitCode: 0, httpStatus: null, message: parsed.error } }
  return { ok: true, data: { ...parsed.data, mergeCommit: parsed.data.mergeCommit?.oid ?? null } }
}

/** Rerun the failed jobs of one Actions workflow run (D10). */
export async function ghRerunFailed(repo: string, runId: number, options: GhCommandOptions = {}): Promise<GithubOutcome<null>> {
  const result = await call(['run', 'rerun', String(runId), '--failed', '-R', repo], options)
  return result.ok ? { ok: true, data: null } : result
}

/** A workflow run's attempt number — above 1 once a rerun landed (D14's rerun inspection). */
export async function ghRunAttempt(repo: string, runId: number, options: GhCommandOptions = {}): Promise<GithubOutcome<number>> {
  const args = ['api', `repos/${repo}/actions/runs/${runId}`]
  const result = await call(args, options)
  if (!result.ok) return result
  const parsed = json<{ attempt?: unknown }>(result.stdout)
  if (!parsed.ok || typeof parsed.data.attempt !== 'number') {
    return { ok: false, error: { argv: ['gh', ...args], exitCode: 0, httpStatus: null, message: parsed.ok ? 'the run carries no attempt number' : parsed.error } }
  }
  return { ok: true, data: parsed.data.attempt }
}

/**
 * Update a pull request's branch from its base, pinned to the head whose
 * round passed (D13): `expected_head_sha` makes GitHub refuse the update
 * when the branch moved. A 202 with the update message is the success shape.
 */
export async function ghUpdateBranch(repo: string, prNumber: number, expectedHeadSha: string, options: GhCommandOptions = {}): Promise<GithubOutcome<null>> {
  const result = await call(['api', '-X', 'PUT', `repos/${repo}/pulls/${prNumber}/update-branch`, '-f', `expected_head_sha=${expectedHeadSha}`], options)
  return result.ok ? { ok: true, data: null } : result
}

/** Merge the pull request with the team's method, pinned to the reviewed head so GitHub refuses a moved branch (D13). */
export async function ghPrMerge(repo: string, prNumber: number, method: MergeMethod, headSha: string, options: GhCommandOptions = {}): Promise<GithubOutcome<null>> {
  if (!MERGE_METHODS.includes(method)) throw new Error(`Unknown merge method: ${method}`)
  const flag = method === 'squash' ? '--squash' : method === 'rebase' ? '--rebase' : '--merge'
  const result = await call(['pr', 'merge', String(prNumber), '-R', repo, flag, '--match-head-commit', headSha], options)
  return result.ok ? { ok: true, data: null } : result
}

/** Close a failed or cancelled promotion's pull request with its outcome as the comment (integration-candidates D10); nothing is deleted. */
export async function ghPrClose(repo: string, prNumber: number, comment: string, options: GhCommandOptions = {}): Promise<GithubOutcome<null>> {
  const result = await call(['pr', 'close', String(prNumber), '-R', repo, '--comment', comment], options)
  return result.ok ? { ok: true, data: null } : result
}

// --- Ref writes (integration-candidates D4, D5) ---

/** `POST repos/{repo}/git/refs`: the branch at `sha`; a 422 means the ref already exists. */
export async function ghCreateRef(repo: string, branch: string, sha: string, options: GhCommandOptions = {}): Promise<GithubOutcome<null>> {
  const result = await call(['api', '-X', 'POST', `repos/${repo}/git/refs`, '-f', `ref=refs/heads/${branch}`, '-f', `sha=${sha}`], options)
  return result.ok ? { ok: true, data: null } : result
}

/** `PATCH repos/{repo}/git/refs/heads/{branch}` with force=false: a 422 means the branch is not an ancestor of `sha`. */
export async function ghFastForwardRef(repo: string, branch: string, sha: string, options: GhCommandOptions = {}): Promise<GithubOutcome<null>> {
  const result = await call(['api', '-X', 'PATCH', `repos/${repo}/git/refs/heads/${branch}`, '-f', `sha=${sha}`, '-F', 'force=false'], options)
  return result.ok ? { ok: true, data: null } : result
}

// --- CI reads (D10) ---

/** `gh auth status`: exit 0 when the CLI is logged in (the probe's auth check). */
export async function ghAuthStatus(options: GhCommandOptions = {}): Promise<GithubOutcome<null>> {
  const result = await call(['auth', 'status'], options)
  return result.ok ? { ok: true, data: null } : result
}

/**
 * The repository as gh reads it: its default branch (the direct mechanism's
 * base), the viewer's write permission, and whether merge commits are allowed
 * (integration-candidates D9; null when GitHub did not report the setting).
 */
export async function ghRepo(repo: string, options: GhCommandOptions = {}): Promise<GithubOutcome<{ defaultBranch: string | null; canPush: boolean; allowMergeCommit: boolean | null }>> {
  const args = ['api', `repos/${repo}`]
  const result = await call(args, options)
  if (!result.ok) return result
  const parsed = json<{ default_branch?: unknown; permissions?: { push?: unknown }; allow_merge_commit?: unknown }>(result.stdout)
  if (!parsed.ok) return { ok: false, error: { argv: ['gh', ...args], exitCode: 0, httpStatus: null, message: parsed.error } }
  return {
    ok: true,
    data: {
      defaultBranch: typeof parsed.data.default_branch === 'string' && parsed.data.default_branch !== '' ? parsed.data.default_branch : null,
      canPush: parsed.data.permissions?.push === true,
      allowMergeCommit: typeof parsed.data.allow_merge_commit === 'boolean' ? parsed.data.allow_merge_commit : null,
    },
  }
}

/** A commit's tree sha — the probe's base tree, read without touching local refs. */
export async function ghCommitTree(repo: string, sha: string, options: GhCommandOptions = {}): Promise<GithubOutcome<string>> {
  const args = ['api', `repos/${repo}/git/commits/${sha}`]
  const result = await call(args, options)
  if (!result.ok) return result
  const parsed = json<{ tree?: { sha?: unknown } }>(result.stdout)
  if (!parsed.ok || typeof parsed.data.tree?.sha !== 'string') {
    return { ok: false, error: { argv: ['gh', ...args], exitCode: 0, httpStatus: null, message: parsed.ok ? 'the commit carries no tree' : parsed.error } }
  }
  return { ok: true, data: parsed.data.tree.sha }
}

/** A tree's blob entries, recursive: path → blob sha (the changes-on-base comparison's other side). */
export async function ghTreeEntries(repo: string, treeSha: string, options: GhCommandOptions = {}): Promise<GithubOutcome<Array<{ path: string; sha: string }>>> {
  const args = ['api', `repos/${repo}/git/trees/${treeSha}?recursive=1`]
  const result = await call(args, options)
  if (!result.ok) return result
  const parsed = json<{ tree?: unknown }>(result.stdout)
  if (!parsed.ok) return { ok: false, error: { argv: ['gh', ...args], exitCode: 0, httpStatus: null, message: parsed.error } }
  const entries = (Array.isArray(parsed.data.tree) ? parsed.data.tree : []).flatMap((entry) => {
    const typed = entry as { path?: unknown; sha?: unknown; type?: unknown }
    return typed.type === 'blob' && typeof typed.path === 'string' && typeof typed.sha === 'string' ? [{ path: typed.path, sha: typed.sha }] : []
  })
  return { ok: true, data: entries }
}

interface RawCheckRun {
  name?: unknown
  conclusion?: unknown
  status?: unknown
  html_url?: unknown
  details_url?: unknown
  app?: { slug?: unknown } | null
}

const asString = (value: unknown): string | null => typeof value === 'string' && value !== '' ? value : null

/** A check run from Actions is rerunnable: the app is github-actions and the details URL names its run (D10). */
function runIdOf(check: RawCheckRun): number | null {
  const url = asString(check.details_url) ?? asString(check.html_url)
  const found = url === null ? null : /\/runs\/(\d+)/.exec(url)
  return found ? Number(found[1]) : null
}

/** Pure: one page of `check-runs` bodies as `CiCheck`s (conclusion null keeps the run's status, so a running check reads pending). */
export function checkRunsToCi(pages: unknown): CiCheck[] {
  const bodies: unknown[] = Array.isArray(pages) ? pages : [pages]
  const checks: CiCheck[] = []
  for (const body of bodies) {
    const runs = (body as { check_runs?: unknown }).check_runs
    if (!Array.isArray(runs)) continue
    for (const run of runs as RawCheckRun[]) {
      const runId = runIdOf(run)
      const fromActions = run.app?.slug === 'github-actions' && runId !== null
      checks.push({
        name: asString(run.name) ?? '',
        source: fromActions ? 'actions' : 'check-run',
        conclusion: asString(run.conclusion) ?? asString(run.status) ?? 'pending',
        link: asString(run.html_url) ?? asString(run.details_url),
        ...(fromActions ? { runId: runId ?? undefined } : {}),
        startedAt: null,
        completedAt: null,
      })
    }
  }
  return checks
}

/** A commit's check runs, all pages (D10). */
export async function ghCheckRuns(repo: string, sha: string, options: GhCommandOptions = {}): Promise<GithubOutcome<CiCheck[]>> {
  const args = ['api', '--paginate', '--slurp', `repos/${repo}/commits/${sha}/check-runs`]
  const result = await call(args, options)
  if (!result.ok) return result
  const parsed = json<unknown>(result.stdout)
  if (!parsed.ok) return { ok: false, error: { argv: ['gh', ...args], exitCode: 0, httpStatus: null, message: parsed.error } }
  return { ok: true, data: checkRunsToCi(parsed.data) }
}

/** Pure: a combined status body as `CiCheck`s — a status's failure and error read as failure, its pending as pending (D10). */
export function statusesToCi(body: unknown): CiCheck[] {
  const statuses = (body as { statuses?: unknown }).statuses
  if (!Array.isArray(statuses)) return []
  return (statuses as Array<{ state?: unknown; context?: unknown; target_url?: unknown }>).map(status => ({
    name: asString(status.context) ?? '',
    source: 'status' as const,
    conclusion: status.state === 'success' ? 'success' : status.state === 'pending' ? 'pending' : 'failure',
    link: asString(status.target_url),
    startedAt: null,
    completedAt: null,
  }))
}

/** A commit's combined status (D10). */
export async function ghStatuses(repo: string, sha: string, options: GhCommandOptions = {}): Promise<GithubOutcome<CiCheck[]>> {
  const args = ['api', `repos/${repo}/commits/${sha}/status`]
  const result = await call(args, options)
  if (!result.ok) return result
  const parsed = json<unknown>(result.stdout)
  if (!parsed.ok) return { ok: false, error: { argv: ['gh', ...args], exitCode: 0, httpStatus: null, message: parsed.error } }
  return { ok: true, data: statusesToCi(parsed.data) }
}
