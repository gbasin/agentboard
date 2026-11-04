// The provision effect adapter (plan-execution D6): fetch the base ref,
// check the change's name against worktrees, local branches, and origin —
// a name that exists is accepted only when a done provision of an execution
// of the same plan created it — then add the worktree from the main
// checkout at the base sha the execution's landing mechanism resolves
// (direct: the execution's newest landing, else the Start-time base commit, so a
// change gets what landed before it), never with --force, reusing the worktree
// or branch an earlier execution of the plan left behind. The main
// checkout's HEAD, index, and files are never touched; fetching updates
// only remote-tracking refs. Git comes in as the gitRemote functions, so
// tests stub them and production passes the real ones.
import fs from 'node:fs'
import type { EffectAdapter, EffectCallResult } from './effects'
import type { EffectRow } from './executionRows'
import type { ExecutionStore } from './executionStore'
import { runGitAsync } from '../../git/gitCommand'
import { gitFetch, lsRemoteHead, worktreeAdd } from '../landing/gitRemote'
import type { GitRemoteError } from '../landing/gitRemote'
import { mechanismFor, type LandingMechanisms } from '../landing/landingMechanisms'
import { DIRECT_MECHANISMS } from '../landing/directMechanism'

export interface ProvisionGit {
  fetch: typeof gitFetch
  lsRemoteHead: typeof lsRemoteHead
  worktreeAdd: typeof worktreeAdd
}

/** A permanent failure carrying D6's stop reason (name-taken). */
export class NameTaken extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NameTaken'
  }
}

const failure = (argv: string[], stderr: string): GitRemoteError => ({ argv, exitCode: 1, stderr })

/** The D6 provision, as one effect call. */
export function provisionAdapter(store: ExecutionStore, git: ProvisionGit = { fetch: gitFetch, lsRemoteHead, worktreeAdd }, mechanisms: LandingMechanisms = DIRECT_MECHANISMS): EffectAdapter {
  return {
    async call(effect: EffectRow): Promise<EffectCallResult> {
      const command = effect.command
      const repo = String(command.repo ?? '')
      const path = String(command.path ?? '')
      const branch = String(command.branch ?? '')
      const recorded = String(command.base ?? '')
      const baseBranch = String(command.baseBranch ?? 'master')
      const planId = String(command.planId ?? '')
      try {
        // 1. Fetch the base ref (remote-tracking refs only).
        const fetched = await git.fetch(repo, 'origin', baseBranch)
        if (!fetched.ok) return { ok: false, error: fetched.error }
        // The start commit, resolved now by the execution's mechanism (integration-candidates D1).
        const execution = store.execution(effect.executionId)
        // A landing's merge is on the base branch fetched above and contains the
        // execution's earlier landings, so a dependent change starts with them.
        const landed = execution === null ? undefined
          : store.landings(execution.planId).filter(landing => landing.executionId === execution.id).at(-1)
        const started = execution === null ? { ok: true as const, sha: recorded }
          : await mechanismFor(mechanisms, execution.landingMode).startBase({ execution, recorded: landed?.mergeSha ?? recorded, repo, lsRemoteHead: git.lsRemoteHead })
        if (!started.ok) return { ok: false, error: started.error }
        const base = started.sha

        // 2. The name check (D6): worktree, local branch, origin branch.
        const worktrees = await runGitAsync(['worktree', 'list', '--porcelain'], { cwd: repo })
        if (!worktrees.ok) return { ok: false, error: failure(['git', 'worktree', 'list'], worktrees.stderr) }
        const worktreeTaken = worktrees.stdout.split('\n').some(line => line.startsWith('worktree ') && line.slice('worktree '.length) === path)
        // --quiet: a missing branch exits 1 without a fatal; other exits are errors.
        const local = await runGitAsync(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: repo })
        if (!local.ok && local.exitCode !== 1) return { ok: false, error: failure(['git', 'rev-parse', '--verify', `refs/heads/${branch}`], local.stderr) }
        const remote = await git.lsRemoteHead(repo, `refs/heads/${branch}`)
        if (!remote.ok) return { ok: false, error: remote.error }
        const taken = worktreeTaken || local.ok || remote.sha !== null
        if (taken) {
          // Accepted only when a done provision of this plan created the name.
          const ours = store.doneProvisions(branch).some(provision => provision.command.planId === planId)
          if (!ours) {
            return { ok: false, error: failure(['provision', 'name-check'], `The name "${branch}" is already taken by work not of this plan; the change stops as name-taken.`) }
          }
        }

        // 3-4. Add or reuse, never forced.
        if (fs.existsSync(path)) {
          // The worktree from an earlier execution still stands on its branch.
          const head = await runGitAsync(['rev-parse', 'HEAD'], { cwd: path })
          if (!head.ok) return { ok: false, error: failure(['git', 'rev-parse', 'HEAD'], head.stderr) }
          return { ok: true, outcome: { path, branch, baseline: base, head: head.stdout.trim() } }
        }
        if (local.ok) {
          // Only the branch remains: check it out as the worktree (D6 step 4).
          const added = await worktreeAdd({ repo, path, branch })
          if (!added.ok) return { ok: false, error: added.error }
        } else {
          const added = await worktreeAdd({ repo, path, branch, start: base })
          if (!added.ok) return { ok: false, error: added.error }
        }
        const head = await runGitAsync(['rev-parse', 'HEAD'], { cwd: path })
        if (!head.ok) return { ok: false, error: failure(['git', 'rev-parse', 'HEAD'], head.stderr) }
        return { ok: true, outcome: { path, branch, baseline: base, head: head.stdout.trim() } }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return { ok: false, error: failure(['provision'], message) }
      }
    },
  }
}
