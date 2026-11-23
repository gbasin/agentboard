// shims.ts - Fake executables on the isolated instance's PATH.
//
// - claude / codex: run the fixture TUI (agent-tui.ts). The pane's start
//   command still begins with the agent's name, so Agentboard detects the
//   agent type exactly as it does for the real CLIs.
// - gh: serves REST PR lists and GraphQL PR/check queries from scene data.
//   Agentboard calls the shim through its production GitHub transport.
// - ssh: stands in for the transport to the "build-box" remote host. It runs
//   the remote command locally against a second private tmux server (via the
//   tmux wrapper and AB_TMUX_SOCKET), so the real remote-polling code
//   (remoteSessions.ts) sees real tmux output.
// The Bun shims run with --no-env-file so no .env file can add variables.

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
    repo: pr.repo,
    number: pr.number,
    state: pr.state,
    headRefOid: pr.number.toString(16).padStart(40, '0'),
    updatedAt: '2026-01-01T00:00:00Z',
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
    executable(agent, `#!/bin/sh\nexec "${process.execPath}" --no-env-file "${tui}" ${agent} "$1" "${paths.state}"\n`)
  }

  const prs: Record<string, Record<string, unknown>> = {}
  for (const pr of [...ALL_SCENES, ...DORMANT].flatMap((s) => s.prs ?? [])) {
    prs[`${pr.repo}#${pr.number}`] = ghRecord(pr)
  }
  const prFile = join(paths.state, 'prs.json')
  writeFileSync(prFile, JSON.stringify(prs, null, 2))
  executable('gh', `#!${process.execPath} --no-env-file
const fs = require('node:fs')
const args = process.argv.slice(2)
const prs = JSON.parse(fs.readFileSync(${JSON.stringify(prFile)}, 'utf-8'))
const method = args[args.indexOf('--method') + 1]
const endpoint = args[args.indexOf('--method') + 2]
let body
const headers = ['Content-Type: application/json']
if (args[0] !== 'api' || !args.includes('--include')) process.exit(1)
if (method === 'GET' && endpoint.startsWith('repos/')) {
  const etag = '"readme-prs"'
  headers.push('ETag: ' + etag)
  if (args.includes('If-None-Match: ' + etag)) {
    console.log(['HTTP/2.0 304', ...headers, '', ''].join('\\n'))
    process.exit(1)
  }
  const url = new URL(endpoint, 'https://api.github.com/')
  const repo = url.pathname.split('/').slice(2, 4).join('/')
  body = Object.values(prs).filter(pr => pr.repo === repo).map(pr => ({
    number: pr.number, title: pr.title, user: pr.author, draft: pr.isDraft,
    state: pr.state === 'OPEN' ? 'open' : 'closed',
    merged_at: pr.state === 'MERGED' ? pr.updatedAt : null,
    updated_at: pr.updatedAt, head: { sha: pr.headRefOid },
  }))
} else if (method === 'POST' && endpoint === 'graphql') {
  const { query, variables: { owner, name, oid } } = JSON.parse(fs.readFileSync(0, 'utf-8'))
  const repo = owner + '/' + name
  const repository = {}
  if (oid) {
    const pr = Object.values(prs).find(pr => pr.repo === repo && pr.headRefOid === oid)
    repository.object = pr ? { statusCheckRollup: { contexts: { nodes: pr.statusCheckRollup.slice(0, 20) } } } : null
  } else {
    for (const [, number] of query.matchAll(/pr(\\d+): pullRequest/g)) {
      repository['pr' + number] = prs[repo + '#' + number] ?? null
    }
  }
  body = { data: { repository } }
} else process.exit(1)
console.log(['HTTP/2.0 200', ...headers, '', JSON.stringify(body)].join('\\n'))
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
# AB_TMUX_SOCKET makes the tmux wrapper (first on PATH) use the remote socket.
exec env -u TMUX -u TMUX_PANE TMUX_TMPDIR="${paths.remoteTmux}" AB_TMUX_SOCKET="${paths.remoteSocket}" /bin/sh -c "$*"
`)
}
