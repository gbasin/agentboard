import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { userInfo } from 'node:os'
import { testProcessEnv } from './test-process-env'

test('removes inherited pane identity and replaces the socket directory without mutating the parent', () => {
  const parent = { TMUX: '/parent/socket,123,0', TMUX_PANE: '%12', TMUX_TMPDIR: '/parent', KEEP: 'yes' }
  expect(testProcessEnv(parent, '/private-test')).toEqual({ TMUX_TMPDIR: '/private-test', KEEP: 'yes' })
  expect(parent.TMUX).toBe('/parent/socket,123,0')
})

// Both servers below are disposable: the simulated parent is never the user's server.
const tmuxTest = Bun.which('tmux') ? test : test.skip
tmuxTest('unmocked child and Worker spawns cannot retag the parent server', () => {
  const outer = mkdtempSync('/tmp/ab-env-parent-')
  const inner = mkdtempSync('/tmp/ab-env-child-')
  const socket = (root: string) => join(root, `tmux-${userInfo().uid}`, 'default')
  mkdirSync(join(outer, `tmux-${userInfo().uid}`), { mode: 0o700 })
  const clean = testProcessEnv(process.env, outer)
  const tmux = (root: string, ...args: string[]) => Bun.spawnSync(['tmux', '-f', '/dev/null', '-S', socket(root), ...args], { env: clean, stdout: 'pipe', stderr: 'pipe' })
  try {
    expect(tmux(outer, 'new-session', '-d', '-s', 'agentboard', 'sleep 60').exitCode).toBe(0)
    const tagged = tmux(outer, 'set-option', '-w', '-t', 'agentboard', '@isolation-sentinel', 'original')
    expect(tagged.stderr.toString()).toBe('')
    expect(tagged.exitCode).toBe(0)
    writeFileSync(join(inner, 'worker.ts'), `
      const r = Bun.spawnSync(['tmux', 'set-option', '-w', '-t', 'agentboard', '@isolation-sentinel', 'worker']);
      postMessage(r.exitCode); self.close();
    `)
    writeFileSync(join(inner, 'child.ts'), `
      Bun.spawnSync(['tmux', '-f', '/dev/null', 'new-session', '-d', '-s', 'agentboard', 'sleep 60']);
      const direct = Bun.spawnSync(['tmux', 'set-option', '-w', '-t', 'agentboard', '@isolation-sentinel', 'child']).exitCode;
      const worker = new Worker(new URL('./worker.ts', import.meta.url).href);
      const code = await new Promise((resolve, reject) => { worker.onmessage = e => resolve(e.data); worker.onerror = reject; });
      console.log(JSON.stringify({ direct, worker: code, inherited: process.env.TMUX ?? null }));
    `)
    const env = testProcessEnv({ ...process.env, TMUX: `${socket(outer)},123,0`, TMUX_PANE: '%0', TMUX_TMPDIR: outer }, inner)
    const child = Bun.spawnSync([process.execPath, join(inner, 'child.ts')], { env, stdout: 'pipe', stderr: 'pipe', timeout: 10000 })
    expect(child.exitCode).toBe(0)
    expect(tmux(outer, 'show-option', '-wqv', '-t', 'agentboard', '@isolation-sentinel').stdout.toString().trim()).toBe('original')
    expect(JSON.parse(child.stdout.toString())).toEqual({ direct: 0, worker: 0, inherited: null })
    expect(tmux(inner, 'show-option', '-wqv', '-t', 'agentboard', '@isolation-sentinel').stdout.toString().trim()).toBe('worker')
  } finally {
    for (const root of [inner, outer]) {
      const windows = tmux(root, 'list-windows', '-a', '-F', '#{window_id}')
      if (windows.exitCode === 0) for (const id of new Set(windows.stdout.toString().trim().split('\n').filter(Boolean))) tmux(root, 'kill-window', '-t', id)
      rmSync(root, { recursive: true, force: true })
    }
  }
}, 20000)
