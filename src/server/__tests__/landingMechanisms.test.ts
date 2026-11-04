// integration-candidates D1 (lead condition 1): the landing-mechanism seam
// over plan-execution's direct landing, which changes no behavior. These
// tests pin:
// - direct.startBase returns the execution's Start-time base commit, the
//   value the planner records in the provision command, exactly as before;
// - the provision starts the worktree from the mechanism's resolved base;
// - under direct, a change provisioned after its dependencies landed in its
//   execution starts from the newest of those landings — never from another
//   execution's, nor from a landing it does not depend on;
// - direct owns only the update-branch and merge effects;
// - the registry carries only the registered modes, and an unregistered
//   mode is a programming error naming it.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { cleanGitEnv } from '../git/gitCommand'
import { DIRECT_MECHANISMS, directMechanism } from '../plans/landing/directMechanism'
import { mechanismFor, REGISTERED_LANDING_MODES, type LandingMechanism } from '../plans/landing/landingMechanisms'
import { landingAdapters } from '../plans/execution/executionLanding'
import { provisionAdapter } from '../plans/execution/executionProvision'
import { lsRemoteHead } from '../plans/landing/gitRemote'
import type { EffectRow, ExecutionRow } from '../plans/execution/executionRows'
import type { ExecutionStore } from '../plans/execution/executionStore'

function git(args: string[], cwd: string) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: cleanGitEnv() })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`)
  return result.stdout.trim()
}

let root: string
let main: string
let first: string
let second: string
beforeAll(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-landing-mechanisms-')))
  const origin = path.join(root, 'origin.git')
  main = path.join(root, 'main')
  git(['init', '-q', '--bare', '-b', 'master', origin], root)
  git(['clone', '-q', origin, main], root)
  const commit = (file: string) => {
    fs.writeFileSync(path.join(main, file), `${file}\n`)
    git(['add', file], main)
    git(['-c', 'user.email=t@e', '-c', 'user.name=T', 'commit', '-q', '-m', file], main)
    return git(['rev-parse', 'HEAD'], main)
  }
  first = commit('a.txt')
  second = commit('b.txt')
  git(['push', '-q', 'origin', 'master'], main)
})
afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

const execution = (baseCommit: string) => ({ id: 'exec-1', planId: 'plan-1', landingMode: 'direct', baseBranch: 'master', baseCommit }) as unknown as ExecutionRow
const fakeStore = (row: ExecutionRow, landings: Array<{ executionId: string; change: string; mergeSha: string }> = []) =>
  ({ execution: () => row, doneProvisions: () => [], landings: () => landings }) as unknown as ExecutionStore
const provisionEffect = (change: string, base: string, dependsOn: string[] = []) => ({
  id: `effect-${change}`, executionId: 'exec-1', change, roundId: null, kind: 'provision', effectKey: `exec-1:${change}:provision:1:0`,
  command: { repo: main, path: path.join(main, '.worktrees', change), branch: change, base, baseBranch: 'master', planId: 'plan-1', dependsOn },
}) as unknown as EffectRow

describe('the direct landing mechanism', () => {
  test("startBase returns the execution's Start-time base commit, as the provision command records it", async () => {
    const row = execution(first)
    expect(await directMechanism.startBase({ execution: row, recorded: row.baseCommit, repo: main, lsRemoteHead })).toEqual({ ok: true, sha: first })
  })

  test('the provision starts the worktree from the direct base, not from the moved origin head', async () => {
    const result = await provisionAdapter(fakeStore(execution(first))).call(provisionEffect('alpha', first))
    expect(result).toMatchObject({ ok: true })
    expect(git(['rev-parse', 'HEAD'], path.join(main, '.worktrees', 'alpha'))).toBe(first)
    expect(git(['rev-parse', 'origin/master'], main)).toBe(second)
  })

  test("the provision starts from the mechanism's resolved base", async () => {
    const resolving: LandingMechanism = { ...directMechanism, startBase: async () => ({ ok: true, sha: second }) }
    const result = await provisionAdapter(fakeStore(execution(first)), undefined, new Map([['direct', resolving]])).call(provisionEffect('beta', first))
    expect(result).toMatchObject({ ok: true, outcome: { baseline: second } })
    expect(git(['rev-parse', 'HEAD'], path.join(main, '.worktrees', 'beta'))).toBe(second)
  })

  test("a change provisioned after its dependencies landed starts from their newest landing", async () => {
    const landings = [{ executionId: 'exec-1', change: 'alpha', mergeSha: first }, { executionId: 'exec-1', change: 'beta', mergeSha: second }]
    const result = await provisionAdapter(fakeStore(execution(first), landings)).call(provisionEffect('gamma', first, ['alpha', 'beta']))
    expect(result).toMatchObject({ ok: true, outcome: { baseline: second } })
    expect(git(['rev-parse', 'HEAD'], path.join(main, '.worktrees', 'gamma'))).toBe(second)
  })

  test("another execution's landing does not move the start commit", async () => {
    const result = await provisionAdapter(fakeStore(execution(first), [{ executionId: 'exec-0', change: 'alpha', mergeSha: second }])).call(provisionEffect('delta', first, ['alpha']))
    expect(result).toMatchObject({ ok: true, outcome: { baseline: first } })
    expect(git(['rev-parse', 'HEAD'], path.join(main, '.worktrees', 'delta'))).toBe(first)
  })

  test('a landing the change does not depend on does not move the start commit', async () => {
    const result = await provisionAdapter(fakeStore(execution(first), [{ executionId: 'exec-1', change: 'alpha', mergeSha: second }])).call(provisionEffect('epsilon', first))
    expect(result).toMatchObject({ ok: true, outcome: { baseline: first } })
    expect(git(['rev-parse', 'HEAD'], path.join(main, '.worktrees', 'epsilon'))).toBe(first)
  })

  test('direct owns the update-branch and merge effects only', () => {
    expect(directMechanism.effectAdapter('update-branch', landingAdapters)).toBeDefined()
    expect(directMechanism.effectAdapter('merge', landingAdapters)).toBeDefined()
    for (const kind of ['push', 'open-pr', 'rerun', 'provision', 'remove-worktree'] as const) {
      expect(directMechanism.effectAdapter(kind, landingAdapters)).toBeUndefined()
    }
  })

  test('the registry holds the registered modes; an unregistered mode is named', () => {
    expect([...DIRECT_MECHANISMS.keys()]).toEqual([...REGISTERED_LANDING_MODES])
    expect(mechanismFor(DIRECT_MECHANISMS, 'direct')).toBe(directMechanism)
    expect(() => mechanismFor(DIRECT_MECHANISMS, 'integration-branch')).toThrow('integration-branch')
  })
})
