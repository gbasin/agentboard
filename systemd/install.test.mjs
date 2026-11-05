// Tests for systemd/install.sh: prerequisite checks and the generated unit.
// The script runs from a copy inside a temp checkout with a temp HOME and
// stub bun/tmux/systemctl, so no real user manager is touched.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const source = path.join(path.dirname(fileURLToPath(import.meta.url)), 'install.sh')
const TOOLS = ['bash', 'sh', 'dirname', 'cat', 'mkdir', 'ln']

function checkout(t, { bun = true, tmux = true, built = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-systemd-install-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const repo = path.join(root, 'repo')
  const home = path.join(root, 'home')
  const sys = path.join(root, 'sys')
  const stubs = path.join(root, 'stubs')
  const calls = path.join(root, 'calls.log')
  for (const dir of [path.join(repo, 'systemd'), home, sys, stubs]) fs.mkdirSync(dir, { recursive: true })
  fs.copyFileSync(source, path.join(repo, 'systemd/install.sh'))
  if (built) {
    fs.mkdirSync(path.join(repo, 'dist/client'), { recursive: true })
    fs.writeFileSync(path.join(repo, 'dist/client/index.html'), '<html></html>')
  }
  for (const tool of TOOLS) {
    const found = ['/bin', '/usr/bin'].map(d => path.join(d, tool)).find(p => fs.existsSync(p))
    if (found) fs.symlinkSync(found, path.join(sys, tool))
  }
  const stub = name => fs.writeFileSync(path.join(stubs, name), `#!/bin/sh\necho "${name} $*" >> '${calls}'\n`, { mode: 0o755 })
  stub('systemctl')
  if (bun) stub('bun')
  if (tmux) stub('tmux')
  const result = spawnSync(path.join(sys, 'bash'), [path.join(repo, 'systemd/install.sh')], {
    encoding: 'utf8', env: { HOME: home, PATH: `${stubs}:${sys}` },
  })
  const unit = path.join(repo, 'systemd/agentboard.service')
  return {
    ...result, repo, home, stubs,
    unit: fs.existsSync(unit) ? fs.readFileSync(unit, 'utf8') : null,
    calls: fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n') : [],
  }
}

test('reports a missing bun instead of exiting silently', t => {
  const r = checkout(t, { bun: false })
  assert.equal(r.status, 1)
  assert.match(r.stderr, /bun not found/)
  assert.equal(r.unit, null)
})

test('requires tmux', t => {
  const r = checkout(t, { tmux: false })
  assert.equal(r.status, 1)
  assert.match(r.stderr, /tmux not found/)
  assert.equal(r.unit, null)
})

test('refuses to install without a built frontend', t => {
  const r = checkout(t, { built: false })
  assert.equal(r.status, 1)
  assert.match(r.stderr, /dist\/client\/index\.html not found/)
  assert.match(r.stderr, /bun run build/)
  assert.equal(r.unit, null)
  assert.deepEqual(r.calls, [])
})

test('generates a unit that leaves tmux alive on restart and stop', t => {
  const r = checkout(t)
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.unit, /^KillMode=process$/m)
  // The main PID must be the server itself: with KillMode=process only it gets signalled.
  assert.match(r.unit, new RegExp(`^ExecStart="${r.stubs}/bun" src/server/index\\.ts$`, 'm'))
  assert.match(r.unit, new RegExp(`^WorkingDirectory=${r.repo}$`, 'm'))
  assert.match(r.unit, new RegExp(`^Environment="PATH=${r.stubs}:${r.stubs}:`, 'm'))
  const link = path.join(r.home, '.config/systemd/user/agentboard.service')
  assert.equal(fs.readlinkSync(link), path.join(r.repo, 'systemd/agentboard.service'))
  assert.deepEqual(r.calls, [
    'systemctl --user daemon-reload',
    'systemctl --user enable agentboard.service',
    'systemctl --user start agentboard.service',
  ])
})
