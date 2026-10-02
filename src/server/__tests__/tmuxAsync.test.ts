// runTmuxAsync must keep the sync runner's contract (stdout, Error(stderr),
// TmuxTimeoutError, sanitized env). A fake `tmux` on PATH stands in for the
// real binary so no test ever reaches a live tmux server.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { config } from '../config'
import { runTmuxAsync } from '../tmuxAsync'
import { TmuxTimeoutError } from '../tmuxTimeout'

const FAKE_TMUX = `#!/bin/sh
[ "$1" = -u ] && shift
case "$1" in
  ok) printf 'out:%s\\n' "$2" ;;
  fail) printf 'boom\\n' >&2; exit 1 ;;
  hang) exec sleep 5 ;;
  env) printf '%s|%s\\n' "\${NODE_ENV-unset}" "\${AB_TMUX_ASYNC_KEEP-unset}" ;;
esac
`

let dir = ''
const saved = {
  path: process.env.PATH,
  nodeEnv: process.env.NODE_ENV,
  timeout: config.tmuxTimeoutMs,
}

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-tmux-async-'))
  fs.writeFileSync(path.join(dir, 'tmux'), FAKE_TMUX, { mode: 0o755 })
  process.env.PATH = `${dir}:${saved.path ?? ''}`
})

afterAll(() => {
  process.env.PATH = saved.path
  if (saved.nodeEnv === undefined) delete process.env.NODE_ENV
  else process.env.NODE_ENV = saved.nodeEnv
  delete process.env.AB_TMUX_ASYNC_KEEP
  config.tmuxTimeoutMs = saved.timeout
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('runTmuxAsync', () => {
  test('returns stdout on success', async () => {
    expect(await runTmuxAsync(['ok', 'x'])).toBe('out:x\n')
  })

  test('throws the stderr text on a nonzero exit', async () => {
    await expect(runTmuxAsync(['fail'])).rejects.toThrow('boom')
  })

  test('throws TmuxTimeoutError when the call outlives tmuxTimeoutMs', async () => {
    config.tmuxTimeoutMs = 100
    try {
      const error = await runTmuxAsync(['-u', 'hang']).catch((e: unknown) => e)
      expect(error).toBeInstanceOf(TmuxTimeoutError)
      expect((error as Error).message).toBe('tmux hang timed out after 100ms')
    } finally {
      config.tmuxTimeoutMs = saved.timeout
    }
  })

  test('strips leaked launch env vars and keeps the rest', async () => {
    process.env.NODE_ENV = 'production'
    process.env.AB_TMUX_ASYNC_KEEP = 'kept'
    expect(await runTmuxAsync(['env'])).toBe('unset|kept\n')
  })
})
