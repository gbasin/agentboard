// githubContract.test.ts - Offline contract between github.ts and the real
// `gh` executable (plan-execution D10/D13/D14): every argv builder the
// adapter exports is exercised against a recording stub, then each option
// token it passes must be one `gh <cmd> [subcmd] --help` documents. Help is
// printed locally, so the contract never touches the API, a pull request,
// auth, or the network; it skips when no real gh is on PATH. The permissive
// adapter stub cannot catch this class — it hid `gh pr create --json`,
// which that subcommand does not document — and the payload values here
// carry option-looking text, so a boundary bug that turns payload text into
// argv options fails the same contract.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  ghAuthStatus, ghCheckRuns, ghCommitTree, ghCreateRef, ghFastForwardRef, ghPrClose, ghPrCreate,
  ghPrList, ghPrMerge, ghPrView, ghRepo, ghRerunFailed, ghRunAttempt, ghStatuses, ghTreeEntries, ghUpdateBranch,
} from '../plans/landing/github'
import { MERGE_METHODS } from '../../shared/planExecution'

// The real executable, resolved from the process PATH before any stub PATH
// is built, and spawned by absolute path so the stub can never shadow it.
const REAL_GH = Bun.which('gh')
const CALL_END = '-- gh call end --'
const ROOTS_WITH_SUBCOMMAND = ['pr', 'run', 'auth']
const ROOTS = [...ROOTS_WITH_SUBCOMMAND, 'api']

let dir: string
let log: string
let env: Record<string, string>
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-gh-contract-'))
  const bin = path.join(dir, 'bin')
  fs.mkdirSync(bin, { recursive: true })
  log = path.join(dir, 'argv.log')
  // One argv element per line, so element boundaries survive the log and a
  // payload that leaked out of its `-f field=value` element shows up as the
  // option or positional it would have become.
  fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/sh
for arg in "$@"; do
  printf '%s\\n' "$arg" >> "$GH_STUB_LOG"
done
printf '%s\\n' '${CALL_END}' >> "$GH_STUB_LOG"
`, { mode: 0o755 })
  env = { PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`, GH_STUB_LOG: log }
})
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

const groups = (): string[][] => {
  const out: string[][] = []
  let current: string[] = []
  for (const line of fs.readFileSync(log, 'utf8').split('\n')) {
    if (line === CALL_END) { out.push(current); current = [] }
    else if (line !== '') current.push(line)
  }
  return out
}

const joined = (group: string[]): string => group.join(' ')

/**
 * Exercise every exported builder once (the merge once per method) and
 * return the recorded argv groups in call order — 18 groups, one per argv
 * shape github.ts builds. Outcomes are irrelevant here (the recording stub
 * prints nothing to parse); the recorded argv is the artifact the contract
 * reads. Free-text payloads carry option-looking text, so payload that
 * leaked out of its field element fails as an undocumented option below.
 */
async function exerciseAll(): Promise<string[][]> {
  await ghPrList('owner/repo', { head: 'kawai/api', base: 'master' }, { env })
  await ghPrCreate('owner/repo', { head: 'kawai/api', base: 'master', title: 'Plan R1 --draft', body: '@plan-body --json number,url' }, { env })
  await ghPrView('owner/repo', 7, { env })
  await ghRerunFailed('owner/repo', 11, { env })
  await ghRunAttempt('owner/repo', 22, { env })
  await ghUpdateBranch('owner/repo', 7, 'sha-aaa', { env })
  for (const method of MERGE_METHODS) await ghPrMerge('owner/repo', 7, method, 'sha-aaa', { env })
  await ghPrClose('owner/repo', 7, 'closing: --admin --force', { env })
  await ghCreateRef('owner/repo', 'kawai/branch', 'sha-bbb', { env })
  await ghFastForwardRef('owner/repo', 'kawai/branch', 'sha-ccc', { env })
  await ghAuthStatus({ env })
  await ghRepo('owner/repo', { env })
  await ghCommitTree('owner/repo', 'sha-ddd', { env })
  await ghTreeEntries('owner/repo', 'tree-eee', { env })
  await ghCheckRuns('owner/repo', 'sha-fff', { env })
  await ghStatuses('owner/repo', 'sha-fff', { env })
  return groups()
}

// gh's cobra-style flag lines: `  -R, --repo [HOST/]OWNER/REPO   Select …`,
// `      --json fields       Output …`, `      --failed       Rerun …`. A
// value flag's placeholder abuts the flag name with a single space; a
// boolean's description starts after the column gap, so the first character
// after the name tells the two apart.
const FLAG_LINE = /^\s+(?:-[A-Za-z], )?(--[A-Za-z][\w-]*)(.*)$/

function flagContract(help: string): Map<string, boolean> {
  const flags = new Map<string, boolean>()
  for (const line of help.split('\n')) {
    const found = FLAG_LINE.exec(line)
    if (found) flags.set(found[1], /^ [^ ]/.test(found[2]))
  }
  return flags
}

const documentsShort = (help: string, flag: string): boolean => new RegExp(`^\\s+-${flag}, `, 'm').test(help)

const helpCache = new Map<string, string>()

/** `gh <cmd> [subcmd] --help` — printed locally, never a network call. */
function helpFor(root: string, sub: string | null): string {
  const key = sub === null ? root : `${root} ${sub}`
  const cached = helpCache.get(key)
  if (cached !== undefined) return cached
  const run = Bun.spawnSync([REAL_GH as string, root, ...(sub === null ? [] : [sub]), '--help'], { stdin: 'ignore' })
  const text = `${run.stdout.toString()}\n${run.stderr.toString()}`
  helpCache.set(key, text)
  return text
}

describe('github.ts argv against the real gh', () => {
  test.skipIf(!REAL_GH)('every exported builder is exercised and lands its argv in the call log', async () => {
    const recorded = await exerciseAll()
    expect(recorded).toHaveLength(18)
    const lines = recorded.map(joined)
    const signatures = [
      'pr list -R owner/repo',
      'api -X POST repos/owner/repo/pulls -f head=kawai/api',
      'pr view 7 -R owner/repo',
      'run rerun 11 --failed -R owner/repo',
      'api repos/owner/repo/actions/runs/22',
      'api -X PUT repos/owner/repo/pulls/7/update-branch',
      'pr merge 7 -R owner/repo --merge --match-head-commit sha-aaa',
      'pr merge 7 -R owner/repo --squash --match-head-commit sha-aaa',
      'pr merge 7 -R owner/repo --rebase --match-head-commit sha-aaa',
      'pr close 7 -R owner/repo',
      'api -X POST repos/owner/repo/git/refs',
      'api -X PATCH repos/owner/repo/git/refs/heads/kawai/branch',
      'auth status',
      'api repos/owner/repo',
      'api repos/owner/repo/git/commits/sha-ddd',
      'api repos/owner/repo/git/trees/tree-eee?recursive=1',
      'api --paginate --slurp repos/owner/repo/commits/sha-fff/check-runs',
      'api repos/owner/repo/commits/sha-fff/status',
    ]
    const missing = signatures.filter(signature => !lines.some(line => line.startsWith(signature)))
    expect(missing).toEqual([])
  })

  test.skipIf(!REAL_GH)('every option token is documented by real gh help, and payload text never becomes an option', async () => {
    const problems: string[] = []
    for (const group of await exerciseAll()) {
      const [root] = group
      const label = ROOTS.includes(root) ? (ROOTS_WITH_SUBCOMMAND.includes(root) ? `${root} ${group[1]}` : root) : joined(group)
      if (!ROOTS.includes(root)) { problems.push(`unexpected root command: ${label}`); continue }
      const sub = ROOTS_WITH_SUBCOMMAND.includes(root) ? group[1] : null
      const help = helpFor(root, sub)
      const flags = flagContract(help)
      let positionals = 0
      for (let index = sub === null ? 1 : 2; index < group.length; index++) {
        const element = group[index]
        if (element.startsWith('--')) {
          const name = element.split('=')[0]
          const takes = flags.get(name)
          if (takes === undefined) problems.push(`gh ${label} does not document ${name}: ${joined(group)}`)
          else if (takes && !element.includes('=')) index += 1
        } else if (/^-[A-Za-z]$/.test(element)) {
          if (!documentsShort(help, element.slice(1))) problems.push(`gh ${label} does not document ${element}: ${joined(group)}`)
          const value = group[index + 1]
          if (value === undefined || value.startsWith('-')) problems.push(`${element} is not followed by a plain value: ${joined(group)}`)
          else if ((element === '-f' || element === '-F') && !/^[A-Za-z_][\w-]*=/.test(value)) problems.push(`${element} value is not a literal field=...: ${joined(group)}`)
          index += 1
        } else {
          positionals += 1
          if (root === 'api' && !element.startsWith('repos/')) problems.push(`api positional is not a repos/ path: ${joined(group)}`)
          if (root !== 'api' && !/^\d+$/.test(element)) problems.push(`payload text became a ${root} positional argument: ${joined(group)}`)
        }
      }
      if (root === 'api' && positionals !== 1) problems.push(`api call carries ${positionals} path positionals: ${joined(group)}`)
    }
    expect(problems).toEqual([])
  })
})
