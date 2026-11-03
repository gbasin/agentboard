// landingProbe.ts - The plan-landing probe and the changes-on-base
// comparison (plan-execution D4, D13): read-only checks over the main
// checkout, `origin`, and `gh` that back Start's `landing-ready` and
// `changes-on-base` entries. The probe writes nothing — no fetch, no ref
// touch, no worktree change; origin's base head comes from ls-remote and
// its tree from gh's API, so remote-tracking refs never move. A change
// name already carried by a worktree, a local branch, or an origin branch
// is a finding unless an execution of this plan provisioned it.
import type { FloorMap } from '../../../shared/planExecution'
import fs from 'node:fs'
import path from 'node:path'
import { runGitAsync } from '../../git/gitCommand'
import { parseWorktreePorcelain } from '../../git/worktreeList'
import { ghAuthStatus, ghCommitTree, ghRepo } from './github'
import { lsRemoteHead } from './gitRemote'
import type { GhCommandOptions } from './ghCommand'

export type ProbeFindingCode = 'git' | 'origin' | 'gh-auth' | 'write-permission' | 'base-branch' | 'floor-map' | 'name-taken' | 'integration-branch'

export interface ProbeFinding {
  code: ProbeFindingCode
  message: string
}

/** What Start snapshots: origin's base branch, its head, and its tree (D4). */
export interface ProbeBase {
  branch: string
  head: string
  tree: string
}

export interface ProbeResult {
  findings: ProbeFinding[]
  /** origin as owner/repo when it parses as GitHub; what the tree reads use. */
  repo: string | null
  /** Set whenever the base branch, head, and tree could be read, whatever else failed. */
  base: ProbeBase | null
  /**
   * An integration plan's facts (integration-candidates D2): the base above
   * is the integration branch, and the target is the default branch. When
   * the branch is still missing, the base head is the default head the
   * branch will be created from.
   */
  integration?: { branch: string; target: string; exists: boolean }
}

export interface ProbeInput {
  /** The team's main checkout. */
  main: string
  /** The settings snapshot's floor map (D16); null when the team configured none. */
  floorChecks: FloorMap | null
  /** The plan's changes, in content order. */
  changes: string[]
  /** Change names an earlier execution of this plan provisioned (name-taken's exception). */
  provisioned: ReadonlySet<string>
}

/** owner/repo of a GitHub remote URL (https or ssh); null for anything else. */
export function githubRepoOf(remoteUrl: string): string | null {
  const https = /^https:\/\/([^/]+)\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(remoteUrl.trim())
  const ssh = /^git@([^:]+):([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(remoteUrl.trim())
  const matched = https ?? ssh
  if (!matched) return null
  const [, host, owner, repo] = matched
  return host === 'github.com' ? `${owner}/${repo}` : null
}

/** The probe (D13's `direct.probe`): findings, plus the base head and tree when readable. */
export async function probeLanding(input: ProbeInput, options: GhCommandOptions = {}): Promise<ProbeResult> {
  const findings: ProbeFinding[] = []
  const git = (args: string[]) => runGitAsync(args, { cwd: input.main, ...options })

  // git itself, then origin's identity.
  const commonDir = await git(['rev-parse', '--git-common-dir'])
  if (!commonDir.ok) findings.push({ code: 'git', message: 'git does not run in the main checkout.' })
  const remoteUrl = await git(['config', '--get', 'remote.origin.url'])
  const repo = remoteUrl.ok ? githubRepoOf(remoteUrl.stdout) : null
  if (!remoteUrl.ok || repo === null) {
    findings.push({
      code: 'origin',
      message: `origin is not a GitHub repository (${remoteUrl.ok ? remoteUrl.stdout.trim() : 'no remote.origin.url'}); execution needs one to land on.`,
    })
  }

  // gh: authentication, then the repository read for write permission and the default branch.
  let defaultBranch: string | null = null
  if (repo !== null) {
    const auth = await ghAuthStatus(options)
    if (!auth.ok && auth.error.spawnFailure === true) {
      // gh itself is missing or cannot be started (D14's gh-spawn row): say
      // that, with the actionable redacted cause — never the auth refusal.
      findings.push({ code: 'gh-auth', message: `gh is missing or cannot be started: ${auth.error.message}` })
    } else if (!auth.ok) findings.push({ code: 'gh-auth', message: 'gh is not authenticated; run gh auth status on the host.' })
    else {
      const repository = await ghRepo(repo, options)
      if (!repository.ok) findings.push({ code: 'gh-auth', message: `gh could not read ${repo}: ${repository.error.message}` })
      else {
        if (!repository.data.canPush) findings.push({ code: 'write-permission', message: `The authenticated viewer cannot push to ${repo}.` })
        defaultBranch = repository.data.defaultBranch
      }
    }
  }

  // The base branch on origin, and its tree.
  let base: ProbeBase | null = null
  if (defaultBranch !== null) {
    const head = await lsRemoteHead(input.main, `refs/heads/${defaultBranch}`)
    if (!head.ok || head.sha === null) {
      findings.push({ code: 'base-branch', message: `The base branch refs/heads/${defaultBranch} does not exist on origin.` })
    } else {
      const tree = repo === null ? null : await ghCommitTree(repo, head.sha, options)
      if (tree !== null && tree.ok) {
        base = { branch: defaultBranch, head: head.sha, tree: tree.data }
      } else {
        findings.push({ code: 'base-branch', message: `The base branch's tree could not be read${tree !== null && !tree.ok ? `: ${tree.error.message}` : '.'}` })
      }
    }
  } else if (repo !== null && !findings.some(finding => finding.code === 'gh-auth')) {
    findings.push({ code: 'base-branch', message: 'The repository names no default branch.' })
  }

  // The floor map.
  if (input.floorChecks === null) {
    findings.push({ code: 'floor-map', message: 'No floor map is configured for this team (teams.json planExecution.floorChecks); Start cannot gate on CI without one.' })
  }

  // Names taken, unless this plan's earlier executions provisioned them.
  for (const change of input.changes) {
    if (input.provisioned.has(change)) continue
    const taken = await nameTaken(input.main, change)
    if (taken !== null) findings.push({ code: 'name-taken', message: taken })
  }

  return { findings, repo, base }
}

/**
 * A change's validated files and the base specs its deltas touch (D4's
 * changes-on-base input): everything under `openspec/changes/<change>/`,
 * plus `openspec/specs/<capability>/spec.md` for each capability the change
 * carries a spec delta for (kept only while it exists locally — a delta for
 * a new capability has no base spec to compare).
 */
export function validatedFilesOf(main: string, change: string): string[] {
  const changeDir = path.join(main, 'openspec', 'changes', change)
  if (!fs.existsSync(changeDir)) return []
  const files: string[] = []
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile()) files.push(path.relative(main, full).split(path.sep).join('/'))
    }
  }
  walk(changeDir)
  const specs = path.join(changeDir, 'specs')
  if (fs.existsSync(specs)) {
    for (const capability of fs.readdirSync(specs, { withFileTypes: true })) {
      if (!capability.isDirectory()) continue
      const baseSpec = path.join(main, 'openspec', 'specs', capability.name, 'spec.md')
      if (fs.existsSync(baseSpec)) files.push(path.relative(main, baseSpec).split(path.sep).join('/'))
    }
  }
  return files.sort()
}

/** Where a change's name already exists: a worktree, a local branch, or an origin branch (D6's checks, read-only). */
async function nameTaken(main: string, change: string): Promise<string | null> {
  const worktrees = await runGitAsync(['worktree', 'list', '--porcelain'], { cwd: main })
  if (worktrees.ok) {
    const hit = parseWorktreePorcelain(worktrees.stdout).find(
      worktree => worktree.branch === change || worktree.path.split('/').pop() === change,
    )
    if (hit) return `A worktree already carries the name "${change}" (${hit.path}).`
  }
  const local = await runGitAsync(['rev-parse', '--verify', `refs/heads/${change}`], { cwd: main })
  if (local.ok) return `A local branch already carries the name "${change}".`
  const remote = await lsRemoteHead(main, `refs/heads/${change}`)
  if (remote.ok && remote.sha !== null) return `An origin branch already carries the name "${change}".`
  if (!remote.ok && !worktrees.ok) return `The name check for "${change}" could not run: ${remote.error.stderr.trim() || 'git failed'}`
  return null
}

// --- The changes-on-base comparison (D4) ---

export interface BaseCompareChange {
  change: string
  /** The change's validated files and the base specs its deltas touch, repo-relative. */
  files: string[]
}

/** One change's differing files: local blob id against origin's tree entry; a path origin lacks differs (D4). */
export async function compareWithOriginTree(
  main: string,
  originTree: ReadonlyMap<string, string>,
  perChange: ReadonlyArray<BaseCompareChange>,
): Promise<Array<{ change: string; files: string[] }>> {
  const files = perChange.flatMap(entry => entry.files)
  if (files.length === 0) return []
  // No -w: the ids are computed, nothing enters the object database.
  const hashes = await runGitAsync(['hash-object', ...files], { cwd: main })
  if (!hashes.ok) throw new Error(`git hash-object failed: ${hashes.stderr.trim()}`)
  const blobIds = hashes.stdout.trim().split('\n')
  const perFile = new Map<string, boolean>()
  files.forEach((file, index) => {
    perFile.set(file, originTree.get(file) !== blobIds[index])
  })
  return perChange
    .map(entry => ({ change: entry.change, files: entry.files.filter(file => perFile.get(file) === true) }))
    .filter(entry => entry.files.length > 0)
}
