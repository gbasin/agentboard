// The landing probe and the changes-on-base comparison (plan-execution D4,
// plan-landing "landing probe") over a local bare `origin` reached through
// a github-shaped remote URL rewritten with `url.<path>.insteadOf` (so git
// stays local while remote.origin.url parses as GitHub) and a stub gh. Each
// finding has a test; the probe writes nothing — refs and the worktree
// list are unchanged after it runs.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { cleanGitEnv } from '../git/gitCommand'
import { compareWithOriginTree, githubRepoOf, probeLanding, type ProbeInput } from '../plans/landing/landingProbe'

const GITHUB_URL = 'https://github.com/acme/app.git'
const FLOOR = { lint: ['ci'], typecheck: ['ci'], 'unit-tests': ['ci'], 'ci-e2e': ['e2e'] }

function git(args: string[], cwd: string) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: cleanGitEnv() })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`)
  return result.stdout
}
const commitAll = (cwd: string, message: string) => {
  git(['add', '-A'], cwd)
  git(['-c', 'user.email=t@e', '-c', 'user.name=T', 'commit', '-q', '-m', message], cwd)
}

let root: string
let origin: string
let main: string
let env: Record<string, string>
beforeAll(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-probe-')))
  origin = path.join(root, 'origin.git')
  main = path.join(root, 'main')
  git(['init', '-q', '--bare', '-b', 'master', origin], root)
  git(['clone', '-q', origin, main], root)
  fs.writeFileSync(path.join(main, 'seed.txt'), 'seed\n')
  commitAll(main, 'seed')
  git(['push', '-q', 'origin', 'master'], main)
  git(['remote', 'set-url', 'origin', GITHUB_URL], main)
  git(['config', `url.${origin}.insteadOf`, GITHUB_URL], main)

  const bin = path.join(root, 'bin')
  fs.mkdirSync(bin, { recursive: true })
  fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/sh
case "$*" in
  *"auth status"*)
    [ "$GH_STUB_AUTH" = "fail" ] && exit 1
    exit 0 ;;
  *"git/commits/"*) printf '%s' '{"tree":{"sha":"ttt-0000"}}' ;;
  *"repos/acme/app"*)
    [ "$GH_STUB_PUSH" = "none" ] && printf '%s' '{"default_branch":"master","permissions":{"push":false}}' && exit 0
    [ "$GH_STUB_DEFAULT" = "missing" ] && printf '%s' '{"default_branch":"develop","permissions":{"push":true}}' && exit 0
    printf '%s' '{"default_branch":"master","permissions":{"push":true}}' ;;
  *) echo "gh: unexpected call: $*" >&2; exit 1 ;;
esac
`, { mode: 0o755 })
  env = { PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`, GH_STUB_AUTH: '', GH_STUB_PUSH: '', GH_STUB_DEFAULT: '' }
})
afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

const probe = (input: Partial<ProbeInput>, overrides: Record<string, string> = {}) =>
  probeLanding({ main, floorChecks: FLOOR, changes: [], provisioned: new Set(), ...input }, { env: { ...env, ...overrides } })
const codes = (result: Awaited<ReturnType<typeof probe>>) => result.findings.map(finding => finding.code)

describe('githubRepoOf', () => {
  test('parses https and ssh GitHub urls; anything else is not a GitHub repository', () => {
    expect(githubRepoOf('https://github.com/acme/app.git')).toBe('acme/app')
    expect(githubRepoOf('https://github.com/acme/app')).toBe('acme/app')
    expect(githubRepoOf('git@github.com:acme/app.git')).toBe('acme/app')
    expect(githubRepoOf('/home/coder/origin.git')).toBeNull()
    expect(githubRepoOf('https://gitlab.example.internal/acme/app.git')).toBeNull()
    expect(githubRepoOf('ssh://git@git.corp.example.internal:2222/acme/app')).toBeNull()
  })
})

describe('probeLanding', () => {
  test('a ready repository yields no findings and the base head and tree', async () => {
    const result = await probe({})
    expect(result.findings).toEqual([])
    const head = git(['rev-parse', 'master'], origin).trim()
    expect(result.base).toEqual({ branch: 'master', head, tree: 'ttt-0000' })
  })

  test('git does not run in a directory that is not a repository', async () => {
    const empty = path.join(root, 'empty')
    fs.mkdirSync(empty, { recursive: true })
    const result = await probeLanding({ main: empty, floorChecks: FLOOR, changes: [], provisioned: new Set() }, { env })
    expect(codes(result)).toEqual(['git', 'origin'])
  })

  test('an origin that is not a GitHub repository is named', async () => {
    const other = path.join(root, 'plain')
    git(['init', '-q', '-b', 'master', other], root)
    fs.writeFileSync(path.join(other, 'x.txt'), 'x\n')
    commitAll(other, 'x')
    git(['remote', 'add', 'origin', path.join(root, 'somewhere.git')], other)
    const result = await probeLanding({ main: other, floorChecks: FLOOR, changes: [], provisioned: new Set() }, { env })
    expect(codes(result)).toEqual(['origin'])
    expect(result.findings[0]!.message).toContain(path.join(root, 'somewhere.git'))
  })

  test('an unauthenticated gh is a finding, and the base is not read', async () => {
    const result = await probe({}, { GH_STUB_AUTH: 'fail' })
    expect(codes(result)).toEqual(['gh-auth'])
    expect(result.findings[0]!.message).toContain('not authenticated')
    expect(result.base).toBeNull()
  })

  test('a gh that cannot start is a cannot-start finding, never the auth refusal', async () => {
    // A PATH with git (a symlink to the real one) and no gh: the probe's git
    // reads still run while every gh call fails to spawn.
    const noGhBin = path.join(root, 'no-gh-bin')
    fs.mkdirSync(noGhBin, { recursive: true })
    const gitPath = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim()
    fs.symlinkSync(gitPath, path.join(noGhBin, 'git'))
    const result = await probeLanding({ main, floorChecks: FLOOR, changes: [], provisioned: new Set() }, { env: { PATH: noGhBin } })
    expect(codes(result)).toEqual(['gh-auth'])
    const finding = result.findings[0]!
    expect(finding.message).toContain('cannot be started')
    expect(finding.message).not.toContain('not authenticated')
    expect(result.base).toBeNull()
    fs.rmSync(noGhBin, { recursive: true, force: true })
  })

  test('a viewer without push permission is a finding; the base still reads', async () => {
    const result = await probe({}, { GH_STUB_PUSH: 'none' })
    expect(codes(result)).toEqual(['write-permission'])
    expect(result.base?.branch).toBe('master')
  })

  test('a default branch that does not exist on origin is a finding', async () => {
    const result = await probe({}, { GH_STUB_DEFAULT: 'missing' })
    expect(codes(result)).toEqual(['base-branch'])
    expect(result.base).toBeNull()
  })

  test('a missing floor map is a finding', async () => {
    const result = await probe({ floorChecks: null })
    expect(codes(result)).toEqual(['floor-map'])
  })

  test('names taken by a worktree, a local branch, or an origin branch; a plan-provisioned name is exempt', async () => {
    git(['worktree', 'add', '-q', '-b', 'other-name', path.join(main, '.worktrees', 'api')], main)
    git(['branch', 'ui'], main)
    git(['push', '-q', 'origin', 'other-name:refs/heads/web'], main)
    const taken = await probe({ changes: ['api', 'ui', 'web', 'fresh'] })
    expect(taken.findings.map(finding => finding.message)).toEqual([
      expect.stringContaining('worktree already carries the name "api"'),
      expect.stringContaining('local branch already carries the name "ui"'),
      expect.stringContaining('origin branch already carries the name "web"'),
    ])
    const exempt = await probe({ changes: ['api'], provisioned: new Set(['api']) })
    expect(exempt.findings).toEqual([])
    git(['worktree', 'remove', path.join(main, '.worktrees', 'api')], main)
  })

  test('the probe writes nothing: refs and the worktree list are unchanged', async () => {
    const refsBefore = git(['for-each-ref'], main)
    const worktreesBefore = git(['worktree', 'list', '--porcelain'], main)
    await probe({ changes: ['anything'] })
    expect(git(['for-each-ref'], main)).toBe(refsBefore)
    expect(git(['worktree', 'list', '--porcelain'], main)).toBe(worktreesBefore)
  })
})

describe('compareWithOriginTree', () => {
  test('a file only in the main checkout differs; an edited one differs; equal content does not', async () => {
    const scratch = path.join(root, 'scratch')
    git(['clone', '-q', origin, scratch], root)
    git(['remote', 'set-url', 'origin', GITHUB_URL], scratch)
    git(['config', `url.${origin}.insteadOf`, GITHUB_URL], scratch)
    // origin holds shared.md (same content as main) and design.md (different content from main); only-local.txt is main's alone.
    fs.writeFileSync(path.join(scratch, 'shared.md'), 'same\n')
    fs.writeFileSync(path.join(scratch, 'design.md'), 'origin version\n')
    commitAll(scratch, 'docs')
    git(['push', '-q', 'origin', 'master:refs/heads/docs'], scratch)
    const originHead = git(['rev-parse', 'master'], scratch).trim()
    const originTree = new Map<string, string>()
    for (const file of ['shared.md', 'design.md']) {
      originTree.set(file, git(['rev-parse', `${originHead}:${file}`], scratch).trim())
    }
    fs.writeFileSync(path.join(main, 'shared.md'), 'same\n')
    fs.writeFileSync(path.join(main, 'design.md'), 'local version\n')
    fs.writeFileSync(path.join(main, 'only-local.txt'), 'local\n')
    const result = await compareWithOriginTree(main, originTree, [
      { change: 'api', files: ['shared.md', 'only-local.txt'] },
      { change: 'web', files: ['design.md'] },
    ])
    expect(result).toEqual([
      { change: 'api', files: ['only-local.txt'] },
      { change: 'web', files: ['design.md'] },
    ])
  })
})
