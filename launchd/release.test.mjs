import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { prepareRelease, validatePackage } from './release-store.mjs'
import { activate, restore, lock } from './release-transaction.mjs'
import { LaunchdService, renderService, validateEnvironment, readPlist } from './release-service.mjs'

function temporary(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-release-test-'))
  t.after(() => fs.rmSync(base, { recursive: true, force: true }))
  return base
}
function fixture(root, name = '@gbasin/agentboard-darwin-arm64', version = '0.31.0') {
  fs.mkdirSync(path.join(root, 'bin'), { recursive: true })
  fs.mkdirSync(path.join(root, 'dist/client/assets'), { recursive: true })
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name, version }))
  fs.writeFileSync(path.join(root, 'bin/agentboard'), '#!/bin/sh\nexit 0\n', { mode: 0o700 })
  fs.writeFileSync(path.join(root, 'dist/client/index.html'), '<html><script src="/assets/main.js"></script><link href="/assets/main.css"></html>')
  for (const file of ['main.js', 'main.css']) fs.writeFileSync(path.join(root, 'dist/client/assets', file), 'fixture')
}
function fakeService(base, { loaded = true, fail = false, rollbackFail = false, healthy = true, disabled = false } = {}) {
  const plist = path.join(base, 'service.plist')
  if (loaded) fs.writeFileSync(plist, 'old')
  const calls = []
  return {
    plist, calls, loaded: () => loaded,
    assertManaged: () => {}, wasHealthy: async () => healthy,
    disabled: () => disabled, setDisabled: value => { disabled = value },
    stop: async () => { calls.push('stop'); loaded = false },
    assertPortFree: async () => { calls.push('port-free') },
    start: async () => { calls.push(`start:${fs.readFileSync(plist, 'utf8')}`); loaded = true },
    check: async () => { calls.push('check'); if (fail) throw new Error('candidate unhealthy') },
    checkPrevious: async () => { calls.push('check-old'); if (rollbackFail) throw new Error('old unhealthy') },
  }
}

test('an unavailable required platform package leaves the running service untouched', t => {
  const base = temporary(t)
  const service = fakeService(base)
  const run = (file, args) => {
    assert.equal(file, 'npm')
    if (args[0] === 'view') return '"0.31.0"'
    assert.equal(args.at(-1), '@gbasin/agentboard-darwin-arm64@0.31.0')
    assert.ok(args.includes('--ignore-scripts'))
    throw new Error('404 platform package not published')
  }
  assert.throws(() => prepareRelease(base, 'latest', run, 'arm64'), /404/)
  assert.equal(fs.readFileSync(service.plist, 'utf8'), 'old')
  assert.deepEqual(service.calls, [])
  assert.deepEqual(fs.readdirSync(path.join(base, 'releases')), [])
})

test('latest resolves once; the required platform version is exact', t => {
  const base = temporary(t)
  const calls = []
  const result = prepareRelease(base, 'latest', (file, args) => {
    calls.push(args)
    if (args[0] === 'view') return '"0.31.0"'
    const stage = args[args.indexOf('--prefix') + 1]
    fixture(path.join(stage, 'node_modules/@gbasin/agentboard-darwin-arm64'))
    return ''
  }, 'arm64')
  assert.equal(result.version, '0.31.0')
  assert.equal(calls.length, 2)
  assert.deepEqual(result.assets, ['/assets/main.js', '/assets/main.css'])
})

test('rejects ambiguous selectors before calling npm', t => {
  assert.throws(() => prepareRelease(temporary(t), '^0.31', () => assert.fail('npm invoked')), /exact/)
})

for (const missing of ['bin/agentboard', 'dist/client/index.html', 'dist/client/assets/main.js', 'dist/client/assets/main.css']) {
  test(`rejects incomplete release: ${missing}`, t => {
    const root = temporary(t)
    fixture(root)
    fs.unlinkSync(path.join(root, missing))
    assert.throws(() => validatePackage(root, '@gbasin/agentboard-darwin-arm64', '0.31.0'))
  })
}

test('rejects a mismatched package version', t => {
  const root = temporary(t)
  fixture(root)
  assert.throws(() => validatePackage(root, '@gbasin/agentboard-darwin-arm64', '0.32.0'), /identity/)
})

test('successful replacement stops, switches, starts and checks before committing', async t => {
  const base = temporary(t)
  const service = fakeService(base)
  await activate(base, service, 'new', {})
  assert.deepEqual(service.calls, ['stop', 'port-free', 'start:new', 'check'])
  assert.equal(fs.readFileSync(service.plist, 'utf8'), 'new')
  assert.equal(fs.existsSync(path.join(base, 'release-pending.json')), false)
})

test('unhealthy candidate restores and checks the previous service', async t => {
  const base = temporary(t)
  const service = fakeService(base, { fail: true })
  await assert.rejects(activate(base, service, 'new', {}), /previous service configuration restored/)
  assert.equal(fs.readFileSync(service.plist, 'utf8'), 'old')
  assert.deepEqual(service.calls.slice(-3), ['stop', 'start:old', 'check-old'])
  assert.equal(fs.existsSync(path.join(base, 'release-pending.json')), false)
})

test('failed first installation removes the candidate service configuration', async t => {
  const base = temporary(t)
  const service = fakeService(base, { loaded: false, fail: true })
  await assert.rejects(activate(base, service, 'new', {}))
  assert.equal(fs.existsSync(service.plist), false)
  assert.equal(service.loaded(), false)
})

test('preserves a previously unloaded service without starting it on rollback', async t => {
  const base = temporary(t)
  const service = fakeService(base, { loaded: false, fail: true })
  fs.writeFileSync(service.plist, 'disabled-old')
  await assert.rejects(activate(base, service, 'new', {}))
  assert.equal(fs.readFileSync(service.plist, 'utf8'), 'disabled-old')
  assert.equal(service.loaded(), false)
})

test('failed rollback retains the recovery journal', async t => {
  const base = temporary(t)
  const service = fakeService(base, { fail: true, rollbackFail: true })
  await assert.rejects(activate(base, service, 'new', {}), /Recovery also failed/)
  assert.equal(JSON.parse(fs.readFileSync(path.join(base, 'release-pending.json'))).plist, 'old')
})

test('recovers an interruption after the new plist was written without npm', async t => {
  const base = temporary(t)
  const service = fakeService(base)
  fs.writeFileSync(path.join(base, 'release-pending.json'), JSON.stringify({ plist: 'old', loaded: true, healthy: true, disabled: false }))
  fs.writeFileSync(service.plist, 'new')
  assert.equal(await restore(base, service), true)
  assert.equal(fs.readFileSync(service.plist, 'utf8'), 'old')
  assert.equal(await restore(base, service), false)
})

test('rollback to an already broken launcher clears the journal so repair can continue', async t => {
  const base = temporary(t)
  const service = fakeService(base, { healthy: false, fail: true, rollbackFail: true })
  await assert.rejects(activate(base, service, 'new', {}), /previous service configuration restored/)
  assert.ok(!service.calls.includes('check-old'))
  assert.equal(fs.existsSync(path.join(base, 'release-pending.json')), false)
})

test('rollback preserves a disabled service override', async t => {
  const base = temporary(t)
  const service = fakeService(base, { loaded: false, disabled: true, fail: true })
  await assert.rejects(activate(base, service, 'new', {}))
  assert.equal(service.disabled(), true)
})

test('refuses to overwrite an unfinished transaction', async t => {
  const base = temporary(t)
  const service = fakeService(base)
  fs.writeFileSync(path.join(base, 'release-pending.json'), '{}')
  await assert.rejects(activate(base, service, 'new', {}), /interrupted/)
  assert.deepEqual(service.calls, [])
})

test('serializes installers and releases the lock', t => {
  const base = temporary(t)
  const unlock = lock(base)
  assert.throws(() => lock(base), /Another installer/)
  unlock()
  lock(base)()
})

test('rejects unsupported health configurations before stopping the old service', () => {
  for (const env of [{ PORT: 'garbage' }, { PORT: '65536' }, { TLS_CERT: 'cert' }, { HOSTNAME: '192.0.2.1' }, { PORT: 4040 }]) {
    assert.throws(() => validateEnvironment(env))
  }
  assert.equal(validateEnvironment({ PORT: '4141' }), 4141)
})

test('launcher uses a pinned binary and escapes shell and XML paths', t => {
  const base = temporary(t)
  const stage = path.join(base, "quote' & space")
  fs.mkdirSync(stage)
  const release = { stage, root: stage }
  const plist = renderService(base, base, release, { PATH: '/usr/bin:/bin', TMUX: 'live', CUSTOM: '<value>&' })
  const launcher = fs.readFileSync(path.join(stage, 'run.sh'), 'utf8')
  assert.ok(launcher.includes("'\\''"))
  assert.ok(!/npm|npx|latest/.test(launcher))
  assert.ok(plist.includes('&lt;value&gt;&amp;'))
  assert.ok(!plist.includes('<key>TMUX</key>'))
  assert.ok(plist.includes('AGENTBOARD_STATIC_DIR'))
  assert.ok(plist.includes('production'))
})

test('real isolated launchd service: healthy install and failed-upgrade rollback', {
  skip: process.platform !== 'darwin' || process.env.RUN_LAUNCHD_INTEGRATION !== '1', timeout: 90_000,
}, async t => {
  const base = temporary(t)
  const probe = net.createServer()
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve))
  const port = probe.address().port
  await new Promise(resolve => probe.close(resolve))
  const label = `com.agentboard.release-test.${process.pid}`
  const service = new LaunchdService(path.join(base, 'service.plist'), port, { label, timeout: 15000 })
  t.after(async () => { await service.stop() })
  const good = path.join(base, 'good')
  const bad = path.join(base, 'bad')
  fixture(good)
  fixture(bad)
  const server = path.join(base, 'server.cjs')
  fs.writeFileSync(server, `require('node:http').createServer((req,res)=>{res.end(req.url==='/api/health' ? '{"ok":true}' : '<html>ok</html>')}).listen(${port},'127.0.0.1')`)
  fs.writeFileSync(path.join(good, 'bin/agentboard'), `#!/bin/bash\nexec '${process.execPath}' '${server}'\n`, { mode: 0o700 })
  const release = { stage: good, root: good, assets: ['/assets/main.js', '/assets/main.css'] }
  const plist = renderService(base, base, release, { PORT: String(port), PATH: '/usr/bin:/bin' }, label)
  try {
    await activate(base, service, plist, release)
  } catch (error) {
    for (const file of ['launchd.out.log', 'launchd.err.log']) {
      if (fs.existsSync(path.join(base, file))) console.error(file, fs.readFileSync(path.join(base, file), 'utf8'))
    }
    throw error
  }
  assert.equal(readPlist(service.plist).Label, label)
  const failed = { stage: bad, root: bad, assets: [] }
  await assert.rejects(activate(base, service, renderService(base, base, failed, { PORT: String(port) }, label), failed), /restored/)
  assert.equal(fs.readFileSync(service.plist, 'utf8'), plist)
  await service.check(release)
})

test('missing version metadata has a useful error', t => {
  assert.throws(() => prepareRelease(temporary(t), '0.99.0', () => ''), /published version for 0.99.0/)
})

test('rejects frontend asset traversal', t => {
  const root = temporary(t)
  fixture(root)
  fs.writeFileSync(path.join(root, 'dist/client/index.html'), '<script src="../outside.js"></script><link href="/assets/main.css">')
  assert.throws(() => validatePackage(root, '@gbasin/agentboard-darwin-arm64', '0.31.0'), /Invalid frontend asset/)
})

test('refuses to replace a loaded job from a different plist', t => {
  const base = temporary(t)
  const current = path.join(base, 'current.plist')
  const other = path.join(base, 'other.plist')
  fs.writeFileSync(current, 'current')
  fs.writeFileSync(other, 'other')
  const service = new LaunchdService(current, 4040, { run: () => `path = ${other}\n` })
  assert.throws(() => service.assertManaged(), /different plist/)
})

test('enables a disabled launchd label before bootstrapping it', () => {
  let disabled = true
  const calls = []
  const service = new LaunchdService('/tmp/test.plist', 4040, { run: (_file, args) => {
    calls.push(args[0])
    if (args[0] === 'print-disabled') return `disabled services = { "com.agentboard" => ${disabled} }`
    if (args[0] === 'enable') disabled = false
    return ''
  } })
  return service.start().then(() => {
    assert.deepEqual(calls, ['print-disabled', 'enable', 'bootstrap'])
    assert.equal(disabled, false)
  })
})

test('lsof absence is distinct from a failed inspection', () => {
  const service = new LaunchdService('/tmp/test.plist', 4040, { run: () => { throw { status: 1, stdout: '', stderr: '' } } })
  assert.deepEqual(service.listeners(), [])
  service.run = () => { throw { status: 1, stdout: '', stderr: 'permission denied' } }
  assert.throws(() => service.listeners())
})
