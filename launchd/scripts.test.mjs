// Shell-script tests for launchd/: log-rotate path resolution and the tmux watchdog.
// Every script runs in a temp HOME with a PATH of stubs and symlinked system
// tools only, so no real tmux or launchctl is reachable.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const darwinOnly = { skip: process.platform !== 'darwin' && 'needs macOS plutil/stat' }
const TOOLS = ['bash', 'sh', 'id', 'dirname', 'basename', 'ps', 'mkdir', 'mv', 'sleep', 'cat', 'rm', 'cp',
  'seq', 'stat', 'gzip', 'awk', 'sed', 'install', 'chmod', 'plutil', 'grep', 'mktemp']

function sandbox(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-launchd-scripts-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const home = path.join(root, 'home')
  const sys = path.join(root, 'sys')
  const stubs = path.join(root, 'stubs')
  const calls = path.join(root, 'calls.log')
  for (const dir of [home, sys, stubs]) fs.mkdirSync(dir, { recursive: true })
  for (const tool of TOOLS) {
    const found = ['/bin', '/usr/bin', '/usr/sbin', '/sbin'].map(d => path.join(d, tool)).find(p => fs.existsSync(p))
    if (found) fs.symlinkSync(found, path.join(sys, tool))
  }
  const stub = (dir, name, body = 'exit 0') => {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, name), `#!/bin/sh\necho "${name} $*" >> '${calls}'\n${body}\n`, { mode: 0o755 })
  }
  stub(stubs, 'launchctl')
  const run = (script, args = [], env = {}) => {
    const result = spawnSync(path.join(sys, 'bash'), [script, ...args], {
      cwd: root, encoding: 'utf8',
      env: { HOME: home, PATH: `${stubs}:${sys}`, AGENTBOARD_TMUX_FALLBACK_PATH: '', ...env },
    })
    return { ...result, calls: fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n') : [] }
  }
  return { root, home, sys, stubs, stub, run }
}

function servicePlist(home, { env = {}, extra = '' } = {}) {
  const file = path.join(home, 'Library/LaunchAgents/com.agentboard.plist')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const entries = Object.entries(env).map(([k, v]) => `<key>${k}</key><string>${v}</string>`).join('')
  fs.writeFileSync(file, `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict><key>Label</key><string>com.agentboard</string>
<key>EnvironmentVariables</key><dict>${entries}</dict>${extra}</dict></plist>\n`)
  return file
}

const rotate = path.join(here, 'agentboard-log-rotate.sh')
const paths = (s, env) => s.run(rotate, ['--print-paths'], env).stdout.trim().split('\n')

test('log rotation defaults to ~/.agentboard without a service plist', darwinOnly, t => {
  const s = sandbox(t)
  const dir = path.join(s.home, '.agentboard')
  assert.deepEqual(paths(s), [`${dir}/agentboard.log`, `${dir}/launchd.out.log`, `${dir}/launchd.err.log`])
})

test('log rotation follows LOG_FILE, then AGENTBOARD_DATA_DIR, from the service plist', darwinOnly, t => {
  const s = sandbox(t)
  servicePlist(s.home, { env: { LOG_FILE: '/var/tmp/custom.log', AGENTBOARD_DATA_DIR: '/ignored' },
    extra: '<key>StandardOutPath</key><string>/x/out.log</string><key>StandardErrorPath</key><string>/x/err.log</string>' })
  assert.deepEqual(paths(s), ['/var/tmp/custom.log', '/x/out.log', '/x/err.log'])

  servicePlist(s.home, { env: { LOG_FILE: '~/logs/a.log' } })
  assert.equal(paths(s)[0], `${s.home}/logs/a.log`)

  servicePlist(s.home, { env: { LOG_FILE: 'rel.log' }, extra: '<key>WorkingDirectory</key><string>/repo</string>' })
  assert.equal(paths(s)[0], '/repo/rel.log')

  servicePlist(s.home, { env: { AGENTBOARD_DATA_DIR: ' /data ' } })
  assert.equal(paths(s)[0], '/data/agentboard.log')

  servicePlist(s.home, { env: { AGENTBOARD_DATA_DIR: '  ' } })
  assert.equal(paths(s)[0], `${s.home}/.agentboard/agentboard.log`)

  // The server expands ~/ in LOG_FILE but not in AGENTBOARD_DATA_DIR, where
  // "~/data" is a relative path under the service's working directory.
  servicePlist(s.home, { env: { AGENTBOARD_DATA_DIR: '~/data' }, extra: '<key>WorkingDirectory</key><string>/repo</string>' })
  assert.equal(paths(s)[0], '/repo/~/data/agentboard.log')
})

test('an empty LOG_FILE leaves only the launchd capture logs', darwinOnly, t => {
  const s = sandbox(t)
  servicePlist(s.home, { env: { LOG_FILE: '' } })
  assert.deepEqual(paths(s), [`${s.home}/.agentboard/launchd.out.log`, `${s.home}/.agentboard/launchd.err.log`])
})

test('log rotation copies, truncates and compresses only oversized files', darwinOnly, t => {
  const s = sandbox(t)
  const big = path.join(s.root, 'custom/app.log')
  const small = path.join(s.home, '.agentboard/launchd.out.log')
  fs.mkdirSync(path.dirname(big), { recursive: true })
  fs.mkdirSync(path.dirname(small), { recursive: true })
  fs.writeFileSync(big, '')
  fs.truncateSync(big, 51 * 1024 * 1024) // sparse: cheap to create
  fs.writeFileSync(path.join(path.dirname(big), 'app.log.1.gz'), 'older')
  fs.writeFileSync(small, 'keep')
  servicePlist(s.home, { env: { LOG_FILE: big } })
  const result = s.run(rotate)
  assert.equal(result.status, 0, result.stderr)
  assert.equal(fs.statSync(big).size, 0)
  assert.ok(fs.existsSync(`${big}.1.gz`))
  assert.equal(fs.readFileSync(`${big}.2.gz`, 'utf8'), 'older')
  assert.equal(fs.readFileSync(small, 'utf8'), 'keep')
})

test('install-logrotate installs the rotate script and a plist without LOG_DIR', darwinOnly, t => {
  const s = sandbox(t)
  const result = s.run(path.join(here, 'install-logrotate.sh'))
  assert.equal(result.status, 0, result.stderr)
  const installed = path.join(s.home, '.agentboard/bin/agentboard-log-rotate.sh')
  assert.equal(fs.readFileSync(installed, 'utf8'), fs.readFileSync(rotate, 'utf8'))
  const plist = fs.readFileSync(path.join(s.home, 'Library/LaunchAgents/com.agentboard.logrotate.plist'), 'utf8')
  assert.doesNotMatch(plist, /LOG_DIR/)
  assert.ok(result.calls.some(c => c.startsWith('launchctl load -w')))
})

// --- Watchdog

const watchdog = path.join(here, 'tmux-watchdog.sh')

test('watchdog finds Homebrew tmux under launchd\'s bare PATH and does not restart a healthy board', t => {
  const s = sandbox(t)
  const brew = path.join(s.root, 'opt-homebrew-bin')
  s.stub(brew, 'tmux', '[ "$1" = display-message ] && echo 4242; exit 0')
  const result = s.run(watchdog, [], { AGENTBOARD_TMUX_FALLBACK_PATH: brew })
  assert.equal(result.status, 0, result.stderr)
  assert.ok(result.calls.includes('tmux has-session -t =agentboard'))
  assert.ok(!result.calls.some(c => c.startsWith('launchctl')))
  assert.equal(fs.readFileSync(path.join(s.home, '.agentboard/tmux-server.pid'), 'utf8'), '4242\n')
})

test('watchdog without tmux fails loudly and never kickstarts Agentboard', t => {
  const s = sandbox(t)
  const result = s.run(watchdog)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /tmux not found/)
  assert.deepEqual(result.calls, [])
})

test('watchdog restarts Agentboard when only the base session is missing', t => {
  const s = sandbox(t)
  s.stub(s.stubs, 'tmux', '[ "$1" = has-session ] && exit 1; exit 0')
  const result = s.run(watchdog, [], { TMUX_SESSION: 'work', AGENTBOARD_DATA_DIR: path.join(s.root, 'data') })
  assert.equal(result.status, 0, result.stderr)
  assert.ok(result.calls.includes('tmux has-session -t =work'))
  assert.ok(result.calls.includes(`launchctl kickstart -k gui/${process.getuid()}/com.agentboard`))
})

test('watchdog reads TMUX_SESSION, data dir and TMUX_TMPDIR from the service plist', darwinOnly, t => {
  const s = sandbox(t)
  const data = path.join(s.root, 'data')
  const sock = path.join(s.root, 'sock')
  servicePlist(s.home, { env: { TMUX_SESSION: 'board', AGENTBOARD_DATA_DIR: data, TMUX_TMPDIR: sock } })
  s.stub(s.stubs, 'tmux', 'echo "TMUX_TMPDIR=$TMUX_TMPDIR TMUX=${TMUX:-}" >> "$HOME/env.log"; [ "$1" = display-message ] && echo 77; exit 0')
  const result = s.run(watchdog, [], { TMUX: '/live/socket,1,0' })
  assert.equal(result.status, 0, result.stderr)
  assert.ok(result.calls.includes('tmux has-session -t =board'))
  assert.equal(fs.readFileSync(path.join(data, 'tmux-server.pid'), 'utf8'), '77\n')
  assert.ok(fs.readFileSync(path.join(s.home, 'env.log'), 'utf8').split('\n').includes(`TMUX_TMPDIR=${sock} TMUX=`))
  // tmux falls back to the default socket (another server) when TMUX_TMPDIR
  // is missing, so the watchdog must create it before the first probe.
  assert.ok(fs.statSync(sock).isDirectory())
})

test('watchdog refuses to probe when it cannot create TMUX_TMPDIR', darwinOnly, t => {
  const s = sandbox(t)
  const blocker = path.join(s.root, 'blocker')
  fs.writeFileSync(blocker, '')
  servicePlist(s.home, { env: { TMUX_TMPDIR: path.join(blocker, 'sock') } })
  s.stub(s.stubs, 'tmux', 'exit 0')
  const result = s.run(watchdog, [])
  assert.equal(result.status, 1)
  assert.match(result.stderr, /Cannot create TMUX_TMPDIR/)
  assert.deepEqual(result.calls.filter(c => c.startsWith('tmux') || c.startsWith('launchctl')), [])
})

test('watchdog refuses a relative TMUX_TMPDIR without probing or restarting', t => {
  const s = sandbox(t)
  s.stub(s.stubs, 'tmux', 'exit 1')
  const result = s.run(watchdog, [], { TMUX_TMPDIR: 'sock' })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /TMUX_TMPDIR must be an absolute path/)
  assert.deepEqual(result.calls, [])
  assert.ok(!fs.existsSync(path.join(s.root, 'sock')))
})

test('watchdog resolves a relative data dir and PID file against the service working directory', darwinOnly, t => {
  const s = sandbox(t)
  const repo = path.join(s.root, 'repo')
  s.stub(s.stubs, 'tmux', '[ "$1" = display-message ] && echo 55; exit 0')
  servicePlist(s.home, { env: { AGENTBOARD_DATA_DIR: 'data' }, extra: `<key>WorkingDirectory</key><string>${repo}</string>` })
  assert.equal(s.run(watchdog).status, 0)
  assert.equal(fs.readFileSync(path.join(repo, 'data/tmux-server.pid'), 'utf8'), '55\n')

  servicePlist(s.home, { env: { AGENTBOARD_TMUX_PID_FILE: 'run/tmux.pid' }, extra: `<key>WorkingDirectory</key><string>${repo}</string>` })
  assert.equal(s.run(watchdog).status, 0)
  assert.equal(fs.readFileSync(path.join(repo, 'run/tmux.pid'), 'utf8'), '55\n')
})

// A recorded PID that is alive and named tmux, with the socket unreachable.
// `sleep` stands in for the tmux server: SIGUSR1 ends it, so the test can see
// whether the watchdog signaled it.
async function stalePid(t, lsofBody) {
  const s = sandbox(t)
  const sock = path.join(s.root, 'sock')
  const data = path.join(s.root, 'data')
  fs.mkdirSync(sock)
  fs.mkdirSync(data)
  const victim = spawn(path.join(s.sys, 'sleep'), ['60'], { stdio: 'ignore' })
  t.after(() => victim.kill('SIGKILL'))
  await once(victim, 'spawn')
  fs.writeFileSync(path.join(data, 'tmux-server.pid'), `${victim.pid}\n`)
  s.stub(s.stubs, 'tmux', 'exit 1')
  s.stub(s.stubs, 'ps', 'echo tmux')
  const socket = `${fs.realpathSync(sock)}/tmux-${process.getuid()}/default`
  s.stub(s.stubs, 'lsof', lsofBody.replace('SOCKET', socket))
  const result = s.run(watchdog, [], { TMUX_TMPDIR: sock, AGENTBOARD_DATA_DIR: data })
  return { result, victim }
}
const kickstarted = result => result.calls.some(c => c.startsWith('launchctl kickstart'))

test('watchdog signals the recorded tmux server only when it holds the service socket', async t => {
  const { result, victim } = await stalePid(t, 'printf "p1\\nf6\\nnSOCKET\\n"')
  const [, signal] = victim.signalCode ? [null, victim.signalCode] : await once(victim, 'exit')
  assert.equal(signal, 'SIGUSR1')
  assert.equal(result.status, 1)
  assert.match(result.stderr, /did not recreate its socket; refusing to replace it/)
  assert.ok(!kickstarted(result))
})

test('watchdog does not signal a reused PID that is another tmux process', async t => {
  const { result, victim } = await stalePid(t, 'printf "p1\\nf6\\nn/elsewhere/tmux-0/default\\nf7\\nn->0xabc\\n"')
  await delay(200)
  assert.equal(victim.signalCode, null)
  assert.equal(victim.exitCode, null)
  assert.match(result.stderr, /does not hold this service's socket; not signaling it/)
  assert.equal(result.status, 0, result.stderr)
  assert.ok(kickstarted(result))
})

test('watchdog neither signals nor restarts when lsof cannot identify the tmux process', async t => {
  const { result, victim } = await stalePid(t, 'exit 1')
  await delay(200)
  assert.equal(victim.signalCode, null)
  assert.equal(victim.exitCode, null)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /Cannot tell whether tmux process/)
  assert.ok(!kickstarted(result))
})

test('install-watchdog records the tmux directory in the job PATH', darwinOnly, t => {
  const s = sandbox(t)
  const brew = path.join(s.root, 'opt-homebrew-bin')
  s.stub(brew, 'tmux')
  const result = s.run(path.join(here, 'install-watchdog.sh'), [], { PATH: `${s.stubs}:${brew}:${s.sys}` })
  assert.equal(result.status, 0, result.stderr)
  const plist = path.join(s.home, 'Library/LaunchAgents/com.agentboard.tmux-watchdog.plist')
  const env = JSON.parse(spawnSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plist], { encoding: 'utf8' }).stdout)
    .EnvironmentVariables
  assert.equal(env.PATH.split(':')[0], brew)
  assert.equal(env.HOME, s.home)
  assert.equal(fs.readFileSync(path.join(s.home, '.agentboard/bin/tmux-agentboard-watchdog.sh'), 'utf8'),
    fs.readFileSync(watchdog, 'utf8'))
  assert.ok(result.calls.some(c => c.startsWith('launchctl load -w')))
})

test('install-watchdog leaves an existing installation untouched when the plist fails validation', darwinOnly, t => {
  const s = sandbox(t)
  const brew = path.join(s.root, 'opt-homebrew-bin')
  s.stub(brew, 'tmux')
  const installed = path.join(s.home, '.agentboard/bin/tmux-agentboard-watchdog.sh')
  const plist = path.join(s.home, 'Library/LaunchAgents/com.agentboard.tmux-watchdog.plist')
  fs.mkdirSync(path.dirname(installed), { recursive: true })
  fs.mkdirSync(path.dirname(plist), { recursive: true })
  fs.writeFileSync(installed, 'previous script')
  fs.writeFileSync(plist, 'previous plist')
  s.stub(s.stubs, 'plutil', 'exit 1')
  const result = s.run(path.join(here, 'install-watchdog.sh'), [], { PATH: `${s.stubs}:${brew}:${s.sys}` })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /Nothing was installed or changed/)
  assert.equal(fs.readFileSync(installed, 'utf8'), 'previous script')
  assert.equal(fs.readFileSync(plist, 'utf8'), 'previous plist')
  assert.ok(!result.calls.some(c => c.startsWith('launchctl')))
  // No staged files are left behind.
  assert.deepEqual(fs.readdirSync(path.dirname(installed)), ['tmux-agentboard-watchdog.sh'])
  assert.deepEqual(fs.readdirSync(path.dirname(plist)), ['com.agentboard.tmux-watchdog.plist'])
})

for (const [name, script, plistName] of [
  ['install-watchdog', 'install-watchdog.sh', 'com.agentboard.tmux-watchdog.plist'],
  ['install-logrotate', 'install-logrotate.sh', 'com.agentboard.logrotate.plist'],
]) {
  test(`${name} reports the state it left when launchctl cannot load the job`, darwinOnly, t => {
    const s = sandbox(t)
    const brew = path.join(s.root, 'opt-homebrew-bin')
    s.stub(brew, 'tmux')
    s.stub(s.stubs, 'launchctl', '[ "$1" = load ] && exit 5; exit 0')
    const result = s.run(path.join(here, script), [], { PATH: `${s.stubs}:${brew}:${s.sys}` })
    assert.equal(result.status, 1)
    assert.match(result.stderr, /script and plist are installed, but the job is not loaded/)
    assert.match(result.stderr, /launchctl load -w/)
    const plist = path.join(s.home, 'Library/LaunchAgents', plistName)
    assert.equal(spawnSync('/usr/bin/plutil', ['-lint', plist]).status, 0)
  })
}
