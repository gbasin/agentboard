// The D14 failure classification as a table over both adapters' error
// shapes: a null exit without the typed marker (a timeout, a killed
// process) is transient; a typed gh spawn failure is permanent with its
// diagnostic retained; git network wording is transient while a rejected
// push is permanent; 5xx, 429, and rate-limit 403s are transient while a
// refused merge's 403, a 422, and a plain 4xx are permanent.
import { describe, expect, test } from 'bun:test'
import { classifyEffectFailure } from '../plans/landing/effectOutcome'
import type { GithubError } from '../plans/landing/github'
import type { GitRemoteError } from '../plans/landing/gitRemote'

const git = (stderr: string, exitCode: number | null = 128): GitRemoteError => ({ argv: ['git', 'push'], exitCode, stderr })
const gh = (message: string, httpStatus: number | null = null, exitCode: number | null = 1): GithubError => ({ argv: ['gh', 'api', 'x'], exitCode, httpStatus, message })

describe('classifyEffectFailure', () => {
  test('a null exit without the typed marker is transient for both adapters', () => {
    expect(classifyEffectFailure(git('', null))).toBe('transient')
    expect(classifyEffectFailure(gh('', null, null))).toBe('transient')
    // No inference from wording: spawn-sounding text on an unknown null
    // exit stays the timeout shape (D14's null-exit row).
    expect(classifyEffectFailure(gh('Executable not found in $PATH: "gh"', null, null))).toBe('transient')
  })

  test('a typed gh spawn failure is permanent, whatever the exit code', () => {
    const spawn: GithubError = { argv: ['gh', 'auth', 'status'], exitCode: null, httpStatus: null, message: 'gh could not be started: Executable not found in $PATH: "gh"', spawnFailure: true }
    expect(classifyEffectFailure(spawn)).toBe('permanent')
    expect(classifyEffectFailure(git('', null))).toBe('transient')
  })

  test('git network wording is transient; refusals are permanent', () => {
    expect(classifyEffectFailure(git('fatal: could not resolve host origin'))).toBe('transient')
    expect(classifyEffectFailure(git('fatal: unable to access: Connection timed out'))).toBe('transient')
    expect(classifyEffectFailure(git('fatal: the remote end hung up unexpectedly (Connection reset)'))).toBe('transient')
    expect(classifyEffectFailure(git('To origin.git\n ! [rejected]  aaa -> kawai/api (non-fast-forward)\nerror: failed to push some refs'))).toBe('permanent')
    expect(classifyEffectFailure(git("fatal: 'kawai/api' is not a valid branch name"))).toBe('permanent')
    expect(classifyEffectFailure(git('fatal: refusing to fetch into branch refs/heads/master'))).toBe('permanent')
  })

  test('GitHub 5xx, 429, and rate limits are transient; other statuses are permanent', () => {
    expect(classifyEffectFailure(gh('gh: Server Error (HTTP 502)', 502))).toBe('transient')
    expect(classifyEffectFailure(gh('gh: Service Unavailable (HTTP 503)', 503))).toBe('transient')
    expect(classifyEffectFailure(gh('gh: Too Many Requests (HTTP 429)', 429))).toBe('transient')
    expect(classifyEffectFailure(gh('You have exceeded a secondary rate limit and need to wait', 403))).toBe('transient')
    expect(classifyEffectFailure(gh('API rate limit exceeded (HTTP 403)', 403))).toBe('transient')
    expect(classifyEffectFailure(gh('Branch protection requires a human review (HTTP 403)', 403))).toBe('permanent')
    expect(classifyEffectFailure(gh('The head sha is not the latest (HTTP 422)', 422))).toBe('permanent')
    expect(classifyEffectFailure(gh('gh: Not Found (HTTP 404)', 404))).toBe('permanent')
    expect(classifyEffectFailure(gh('gh exited without a message', null))).toBe('permanent')
  })
})
