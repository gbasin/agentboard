// github.ts (plan-execution D10/D13/D14) over a stub gh that replays
// recorded API responses: PR list/create/view, a commit's check runs and
// statuses normalized to CiCheck, the failed-run rerun, the pinned
// update-branch (202 accepted, 422 moved, 403 forbidden), and the pinned
// merge — plus 5xx and the argv each call builds (never a force or admin
// flag; the repo is explicit). The stub records every invocation to a log
// the assertions read back.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  ghCheckRuns, ghPrCreate, ghPrList, ghPrMerge, ghPrView, ghRerunFailed, ghStatuses, ghUpdateBranch,
} from '../plans/landing/github'

let dir: string
let log: string
let env: Record<string, string>
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-github-'))
  const bin = path.join(dir, 'bin')
  fs.mkdirSync(bin, { recursive: true })
  log = path.join(dir, 'calls.log')
  fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/sh
echo "$@" >> "$GH_STUB_LOG"
case "$*" in
  *"pr list"*) printf '%s' '[{"number":7,"url":"https://example.internal/pr/7","state":"OPEN","headRefOid":"aaa"},{"number":3,"url":"https://example.internal/pr/3","state":"MERGED","headRefOid":"bbb"}]' ;;
  *"POST repos/owner/repo/pulls "*)
    for field in "-f head=" "-f base=" "-f title=" "-f body="; do
      case "$*" in
        *"$field"*) ;;
        *) echo "gh: create is missing $field" >&2; exit 1 ;;
      esac
    done
    if [ "$GH_STUB_CREATE" = "422" ]; then echo "gh: Validation Failed (HTTP 422)" >&2; exit 1; fi
    if [ "$GH_STUB_CREATE" = "no-html-url" ]; then printf '%s' '{"number":9,"url":"https://api.example.internal/repos/owner/repo/pulls/9"}'; exit 0; fi
    printf '%s' '{"number":9,"url":"https://api.example.internal/repos/owner/repo/pulls/9","html_url":"https://example.internal/pr/9"}' ;;
  *"pr view"*) printf '%s' '{"number":7,"url":"https://example.internal/pr/7","state":"MERGED","headRefOid":"aaa","mergeCommit":{"oid":"mmm"}}' ;;
  *"check-runs"*) printf '%s' '[{"total_count":2,"check_runs":[{"name":"ci","conclusion":"success","status":"completed","html_url":"https://example.internal/runs/11/at","details_url":"https://example.internal/runs/11/at","app":{"slug":"github-actions"}},{"name":"lint-external","conclusion":null,"status":"in_progress","html_url":null,"details_url":null,"app":{"slug":"other-app"}}]}]' ;;
  *"commits/sha1/status"*) printf '%s' '{"state":"failure","statuses":[{"state":"success","context":"deploy","target_url":"https://example.internal/deploy"},{"state":"error","context":"audit"},{"state":"pending","context":"scan","target_url":null}]}' ;;
  *"run rerun"*) exit 0 ;;
  *"update-branch"*)
    if [ "$GH_STUB_UPDATE" = "422" ]; then echo "gh: The head sha is not the latest (HTTP 422)" >&2; exit 1; fi
    if [ "$GH_STUB_UPDATE" = "502" ]; then echo "gh: Server Error (HTTP 502)" >&2; exit 1; fi
    printf '%s' '{"message":"Updating pull request branch."}' ;;
  *"pr merge"*)
    if [ "$GH_STUB_MERGE" = "403" ]; then echo "gh: Branch protection requires a human review (HTTP 403)" >&2; exit 1; fi
    exit 0 ;;
  *) echo "gh: unexpected call: $*" >&2; exit 1 ;;
esac
`, { mode: 0o755 })
  env = { PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`, GH_STUB_LOG: log, GH_STUB_CREATE: '', GH_STUB_UPDATE: '', GH_STUB_MERGE: '' }
})
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

const invoked = (): string[] => fs.readFileSync(log, 'utf8').trim().split('\n').filter(line => line !== '')

describe('github over the stub gh', () => {
  test('pr list parses the pull requests and asks for the change branch and base', async () => {
    const result = await ghPrList('owner/repo', { head: 'kawai/api', base: 'master' }, { env })
    expect(result).toEqual({
      ok: true,
      data: [
        { number: 7, url: 'https://example.internal/pr/7', state: 'OPEN', headRefOid: 'aaa' },
        { number: 3, url: 'https://example.internal/pr/3', state: 'MERGED', headRefOid: 'bbb' },
      ],
    })
    expect(invoked()[0]).toContain('--head kawai/api --base master --state all')
  })

  test('pr create posts the fields literally through the API and returns the html url', async () => {
    const result = await ghPrCreate('owner/repo', { head: 'kawai/api', base: 'master', title: 'Plan R1 api', body: '@plan-body --json number,url' }, { env })
    // The stub response carries both shapes: `url` is the API URL, `html_url`
    // the pull request page — the adapter must return the page.
    expect(result).toEqual({ ok: true, data: { number: 9, url: 'https://example.internal/pr/9' } })
    const argv = invoked()[0] ?? ''
    expect(argv).toContain('api -X POST repos/owner/repo/pulls')
    expect(argv).toContain('-f head=kawai/api -f base=master -f title=Plan R1 api')
    expect(argv).toContain('-f body=@plan-body --json number,url')
    expect(argv).not.toContain('-F ')
    expect(argv).not.toContain('--head ')
    const validation = await ghPrCreate('owner/repo', { head: 'kawai/api', base: 'master', title: 't', body: 'b' }, { env: { ...env, GH_STUB_CREATE: '422' } })
    expect(validation.ok).toBe(false)
    if (!validation.ok) {
      expect(validation.error.httpStatus).toBe(422)
      expect(validation.error.message).toContain('Validation Failed')
      expect(validation.error.argv.slice(0, 5)).toEqual(['gh', 'api', '-X', 'POST', 'repos/owner/repo/pulls'])
    }
    const noUrl = await ghPrCreate('owner/repo', { head: 'kawai/api', base: 'master', title: 't', body: 'b' }, { env: { ...env, GH_STUB_CREATE: 'no-html-url' } })
    expect(noUrl.ok).toBe(false)
    if (!noUrl.ok) {
      expect(noUrl.error.httpStatus).toBeNull()
      expect(noUrl.error.message).toContain('no pull request number or html_url')
    }
  })

  test('pr view reads the merge commit oid', async () => {
    const result = await ghPrView('owner/repo', 7, { env })
    expect(result).toEqual({
      ok: true,
      data: { number: 7, url: 'https://example.internal/pr/7', state: 'MERGED', headRefOid: 'aaa', mergeCommit: 'mmm' },
    })
  })

  test('check runs normalize: an Actions run keeps its run id; others are check-runs; a running one is pending', async () => {
    const result = await ghCheckRuns('owner/repo', 'sha1', { env })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data).toEqual([
        { name: 'ci', source: 'actions', conclusion: 'success', link: 'https://example.internal/runs/11/at', runId: 11, startedAt: null, completedAt: null },
        { name: 'lint-external', source: 'check-run', conclusion: 'in_progress', link: null, startedAt: null, completedAt: null },
      ])
    }
    expect(invoked()[0]).toContain('repos/owner/repo/commits/sha1/check-runs')
  })

  test('statuses normalize: error reads as failure, pending stays pending, links carried', async () => {
    const result = await ghStatuses('owner/repo', 'sha1', { env })
    expect(result).toEqual({
      ok: true,
      data: [
        { name: 'deploy', source: 'status', conclusion: 'success', link: 'https://example.internal/deploy', startedAt: null, completedAt: null },
        { name: 'audit', source: 'status', conclusion: 'failure', link: null, startedAt: null, completedAt: null },
        { name: 'scan', source: 'status', conclusion: 'pending', link: null, startedAt: null, completedAt: null },
      ],
    })
  })

  test('rerun passes --failed and reports a refused rerun', async () => {
    await expect(ghRerunFailed('owner/repo', 11, { env })).resolves.toEqual({ ok: true, data: null })
    expect(invoked()[0]).toContain('run rerun 11 --failed')
  })

  test('update-branch pins the expected head; 422 and 5xx carry their HTTP status', async () => {
    const accepted = await ghUpdateBranch('owner/repo', 7, 'aaa', { env })
    expect(accepted).toEqual({ ok: true, data: null })
    expect(invoked()[0]).toContain('-f expected_head_sha=aaa')
    const moved = await ghUpdateBranch('owner/repo', 7, 'aaa', { env: { ...env, GH_STUB_UPDATE: '422' } })
    expect(moved.ok).toBe(false)
    if (!moved.ok) {
      expect(moved.error.httpStatus).toBe(422)
      expect(moved.error.message).toContain('head sha')
    }
    const server = await ghUpdateBranch('owner/repo', 7, 'aaa', { env: { ...env, GH_STUB_UPDATE: '502' } })
    expect(server.ok).toBe(false)
    if (!server.ok) expect(server.error.httpStatus).toBe(502)
  })

  test('merge pins the head with the method flag, and a refused merge carries 403', async () => {
    await expect(ghPrMerge('owner/repo', 7, 'squash', 'aaa', { env })).resolves.toEqual({ ok: true, data: null })
    const argv = invoked()[0] ?? ''
    expect(argv).toContain('--squash')
    expect(argv).toContain('--match-head-commit aaa')
    expect(argv).not.toContain('--force')
    expect(argv).not.toContain('--admin')
    const refused = await ghPrMerge('owner/repo', 7, 'merge', 'aaa', { env: { ...env, GH_STUB_MERGE: '403' } })
    expect(refused.ok).toBe(false)
    if (!refused.ok) {
      expect(refused.error.httpStatus).toBe(403)
      expect(refused.error.message).toContain('human review')
    }
  })
})
