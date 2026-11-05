// shims.ts - Fake executables on the isolated instance's PATH.
//
// - claude / codex: run the fixture TUI (agent-tui.ts). The pane's start
//   command still begins with the agent's name, so Agentboard detects the
//   agent type exactly as it does for the real CLIs.
// - gh: answers `gh pr view N --repo R --json fields` from the scenes' PR
//   data. Agentboard's real PR pipeline (prInfo.ts) calls it unchanged.
// - ssh: stands in for the transport to the "build-box" remote host. It runs
//   the remote command locally against a second private tmux server, so the
//   real remote-polling code (remoteSessions.ts) sees real tmux output.

import { chmodSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { paths, REPO } from './instance'
import { ALL_SCENES, DORMANT, type PullRequest } from './scenes'

function executable(name: string, body: string): void {
  const file = join(paths.bin, name)
  writeFileSync(file, body)
  chmodSync(file, 0o755)
}

function ghRecord(pr: PullRequest): Record<string, unknown> {
  return {
    state: pr.state,
    isDraft: pr.isDraft === true,
    title: pr.title,
    author: { login: 'dev' },
    statusCheckRollup: pr.checks.map(([name, conclusion]) => ({
      __typename: 'CheckRun',
      name,
      status: conclusion === 'PENDING' ? 'IN_PROGRESS' : 'COMPLETED',
      conclusion: conclusion === 'PENDING' ? null : conclusion,
      detailsUrl: `https://github.com/${pr.repo}/actions`,
    })),
  }
}

export function writeShims(): void {
  const tui = join(REPO, 'scripts', 'readme-shots', 'agent-tui.ts')
  for (const agent of ['claude', 'codex']) {
    executable(agent, `#!/bin/sh\nexec "${process.execPath}" "${tui}" ${agent} "$1" "${paths.state}"\n`)
  }

  const prs: Record<string, Record<string, unknown>> = {}
  for (const pr of [...ALL_SCENES, ...DORMANT].flatMap((s) => s.prs ?? [])) {
    prs[`${pr.repo}#${pr.number}`] = ghRecord(pr)
  }
  const prFile = join(paths.state, 'prs.json')
  writeFileSync(prFile, JSON.stringify(prs, null, 2))
  executable('gh', `#!${process.execPath}
// Fake gh: only \`gh pr view <n> --repo <owner/name> --json <fields>\`.
const args = process.argv.slice(2)
const prs = JSON.parse(require('node:fs').readFileSync(${JSON.stringify(prFile)}, 'utf-8'))
const repo = args[args.indexOf('--repo') + 1]
const fields = (args[args.indexOf('--json') + 1] || '').split(',')
const pr = args[0] === 'pr' && args[1] === 'view' ? prs[repo + '#' + args[2]] : undefined
if (!pr) { console.error('not found'); process.exit(1) }
console.log(JSON.stringify(Object.fromEntries(fields.filter((f) => f in pr).map((f) => [f, pr[f]]))))
`)

  executable('ssh', `#!/bin/sh
# Fake ssh: drop options, then run the remote command on the private
# "remote" tmux server instead of connecting anywhere.
while [ $# -gt 0 ]; do
  case "$1" in
    -o|-p|-i|-l|-F|-S|-E|-J) shift 2 ;;
    -*) shift ;;
    *) break ;;
  esac
done
shift
exec env -u TMUX -u TMUX_PANE TMUX_TMPDIR="${paths.remoteTmux}" /bin/sh -c "$*"
`)
}
