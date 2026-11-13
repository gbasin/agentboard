import { expect, test } from 'bun:test'
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { e2eFixtures } from './e2e-fixtures'
import { ciSimulator } from './ci-simulator'

test('CI discovery selects only the available iPhone 17 on iOS 27.2', () => {
  const phone = (name: string, udid: string, isAvailable = true) => ({ name, udid, isAvailable })
  const runtime = 'com.apple.CoreSimulator.SimRuntime.iOS-27-2'
  const devices = {
    'com.apple.CoreSimulator.SimRuntime.iOS-26-4': [phone('iPhone 17', 'old')],
    'com.apple.CoreSimulator.SimRuntime.iOS-27-20': [phone('iPhone 17', 'prefix')],
    [runtime]: [phone('iPhone Duo', 'duo'), phone('iPhone 17 Pro', 'pro'), phone('iPhone 17', 'unavailable', false), phone('iPhone 17', 'selected')],
  }
  expect(ciSimulator({ devices })).toBe('selected')
  expect(() => ciSimulator({ devices: { ...devices, [runtime]: [phone('iPhone 17', 'unavailable', false)] } })).toThrow('No available iPhone 17 Simulator for ' + runtime)
  expect(() => ciSimulator({ devices: { ...devices, [runtime]: [] } })).toThrow(runtime)
})

for (const scenario of [
  ...['terminal', 'catalog', 'lifecycle', 'media', 'settings'].map(shard => ({ shard, archiveFailure: false, testStatus: 37 })),
  { shard: 'media', archiveFailure: false, testStatus: 0 },
  { shard: 'media', archiveFailure: false, testStatus: 0, exportFailure: true },
  { shard: 'catalog', archiveFailure: true, testStatus: 37 },
  { shard: 'catalog', archiveFailure: true, testStatus: 0 },
  { shard: 'terminal', archiveFailure: false, testStatus: 0, cacheFailure: true },
  { shard: 'catalog', archiveFailure: false, testStatus: 0, udidOverride: 'local-simulator' },
]) {
  const { shard, archiveFailure, testStatus } = scenario
  const exportFailure = 'exportFailure' in scenario && scenario.exportFailure
  const cacheFailure = 'cacheFailure' in scenario && scenario.cacheFailure
  const udidOverride = 'udidOverride' in scenario ? scenario.udidOverride : ''
  test(`CI orchestration ${shard}, tests=${testStatus}, archiveFailure=${archiveFailure}, cacheFailure=${cacheFailure}, exportFailure=${exportFailure}`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'ios-ci-orchestration-'))
    try {
      const scripts = join(root, 'ios/scripts'), bin = join(root, 'bin'), log = join(root, 'calls')
      mkdirSync(scripts, { recursive: true }); mkdirSync(bin)
      // Copy orchestration only; every external command is stubbed. This must
      // never touch the fixed private fixture path or the host Simulator/tmux.
      const source = readFileSync(new URL('./ci-e2e.sh', import.meta.url), 'utf8')
        .replaceAll('/tmp/ab-ios-parity', join(root, 'fixtures'))
        .replaceAll('/tmp/ab-ios-fixture-logs', join(root, 'archive'))
      writeFileSync(join(scripts, 'ci-e2e.sh'), source)
      writeFileSync(join(scripts, 'seed-file.sh'), readFileSync(new URL('./seed-file.sh', import.meta.url), 'utf8'))
      writeFileSync(join(scripts, 'verify-file-export.sh'), readFileSync(new URL('./verify-file-export.sh', import.meta.url), 'utf8'))
      mkdirSync(join(root, 'app'))
      writeFileSync(join(scripts, 'ci-readiness.sh'), readFileSync(new URL('./ci-readiness.sh', import.meta.url), 'utf8'))
      writeFileSync(join(scripts, 'ci-diagnostics.sh'), 'ci_diagnostics_start() { :; }; ci_diagnostics_stop() { echo stopped >> "$CALL_LOG"; }; ci_phase() { echo "phase $1" >> "$CALL_LOG"; shift; "$@"; }\n')
      writeFileSync(join(scripts, 'test-e2e.sh'), '#!/bin/bash\necho tests >> "$CALL_LOG"\nif [ -f "$TMUX_TMPDIR/export-expected.pdf" ] && [ -d "$APP_DATA/File Provider Storage/Agentboard E2E Exports" ]; then cp "$TMUX_TMPDIR/export-expected.pdf" "$APP_DATA/File Provider Storage/Agentboard E2E Exports/Document.pdf"; fi\n' + (exportFailure ? 'printf corrupt > "$APP_DATA/File Provider Storage/Agentboard E2E Exports/Document.pdf"\n' : '') + 'exit ' + testStatus + '\n', { mode: 0o755 })
      const stub = (name: string, body: string) => writeFileSync(join(bin, name), '#!/bin/bash\necho "' + name + ' $*" >> "$CALL_LOG"\n' + body, { mode: 0o755 })
      stub('bun', `case "$1" in
        ios/scripts/e2e-fixtures.ts) printf '%s\\n' "$FIXTURES" ;;
        ios/scripts/ci-simulator.ts) cat >/dev/null; echo mock-udid ;;
        ios/scripts/seed-parity.ts) touch "$TMUX_TMPDIR/photo.png" "$TMUX_TMPDIR/upload.txt" "$TMUX_TMPDIR/export-expected.pdf" ;;
        ios/scripts/seed-live.ts|ios/scripts/warm-parity.ts|ios/scripts/parity-media-ready.ts|ios/scripts/tmux-ready.ts) ;;
        *) trap 'exit 0' TERM; while :; do /bin/sleep 0.05; done ;;
      esac\n`)
      stub('xcrun', (cacheFailure ? 'if [[ "$*" == *dyld_shared_cache* ]]; then exit 75; fi\n' : '') + 'if [[ "$*" == *get_app_container* ]]; then printf "group.com.apple.FileProvider.LocalStorage\\t%s\\n" "$APP_DATA"; fi\n')
      if (archiveFailure) stub('mv', 'exit 74\n')
      stub('curl', 'exit 0\n'); stub('tmux', 'exit 0\n')
      const proc = Bun.spawn(['/bin/bash', join(scripts, 'ci-e2e.sh')], {
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CALL_LOG: log, APP_DATA: join(root, 'app'), IOS_SIMULATOR_UDID: udidOverride, IOS_TEST_PRODUCTS_DIR: join(root, 'products'), IOS_E2E_MODE: 'light', IOS_E2E_SHARD: shard, FIXTURES: e2eFixtures('light', shard).join('\n') }, stdout: 'pipe', stderr: 'pipe',
      })
      expect(await proc.exited).toBe(cacheFailure ? 75 : testStatus || (exportFailure ? 1 : archiveFailure ? 74 : 0))
      const calls = readFileSync(log, 'utf8')
      if (cacheFailure) {
        expect(calls).not.toContain('xcrun simctl boot ')
        expect(calls).not.toContain('bun src/server/index.ts')
        expect(calls).not.toContain('tests\n')
        expect(calls).toContain('stopped\n')
        return
      }
      const plan = e2eFixtures('light', shard)
      expect(calls).toContain(`xcrun simctl boot ${udidOverride || 'mock-udid'}`)
      if (udidOverride) expect(calls).not.toContain('xcrun simctl list devices')
      else expect(calls).toContain('bun ios/scripts/ci-simulator.ts')
      for (const [fixture, command] of Object.entries({ backend: 'bun src/server/index.ts', live: 'bun ios/scripts/seed-live.ts', parity: 'bun ios/scripts/seed-parity.ts', warm: 'bun ios/scripts/warm-parity.ts', 'shell-server': 'bun ios/scripts/shell-server.ts', 'pr-fixture': 'bun ios/scripts/pr-fixture.ts', 'parity-gap-fixture': 'bun ios/scripts/parity-gap-fixture.ts', 'media-activity-fixture': 'bun ios/scripts/media-activity-fixture.ts', photos: 'xcrun simctl addmedia', files: 'xcrun simctl get_app_container' })) {
        expect(calls.includes(command)).toBe(plan.includes(fixture as typeof plan[number]))
      }
      if (plan.includes('files')) expect(existsSync(join(root, 'app/File Provider Storage/parity-upload.txt'))).toBe(true)
      expect(calls.includes('phase parity-media-ready')).toBe(plan.includes('warm'))
      if (plan.includes('warm')) {
        expect(calls.indexOf('phase parity-media-ready')).toBeGreaterThan(calls.indexOf('bun ios/scripts/warm-parity.ts'))
        expect(calls.indexOf('phase parity-media-ready')).toBeLessThan(calls.indexOf('xcrun simctl install '))
      }
      const cache = calls.indexOf('xcrun simctl runtime dyld_shared_cache update --all')
      expect(cache).toBeGreaterThanOrEqual(0)
      expect(cache).toBeLessThan(calls.indexOf('xcrun simctl boot '))
      if (plan.includes('backend')) {
        expect(cache).toBeLessThan(calls.indexOf('bun src/server/index.ts'))
        expect(calls.indexOf('phase tmux-ready')).toBeLessThan(calls.indexOf('bun src/server/index.ts'))
        expect(calls.indexOf('phase backend-pre-tests')).toBeGreaterThan(calls.indexOf('xcrun simctl install '))
        expect(calls.indexOf('phase backend-pre-tests')).toBeLessThan(calls.indexOf('\ntests\n'))
      } else {
        expect(calls).not.toContain('curl ')
        expect(calls).not.toContain('phase backend-pre-tests')
      }
      expect(calls.includes('phase files-export-verify')).toBe(plan.includes('files') && testStatus === 0)
      expect(calls).toContain('\ntests\n'); expect(calls).toContain('stopped\n')
      expect(calls).toContain(`tmux -S ${root}/fixtures/tmux-`)
      expect(readdirSync(join(root, 'archive'))).toHaveLength(archiveFailure ? 0 : 1)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
}

for (const scenario of ['transient', 'timeout', 'dead', 'dies-during-probe'] as const) {
  test(`post-install backend readiness: ${scenario}`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'ios-ci-readiness-'))
    try {
      const bin = join(root, 'bin'), log = join(root, 'calls')
      mkdirSync(bin)
      writeFileSync(join(bin, 'curl'), `#!/bin/bash
echo "$*" >> "$CALL_LOG"
case "$SCENARIO" in
  transient) if [ ! -f "$CALL_LOG.once" ]; then touch "$CALL_LOG.once"; exit 28; fi; exit 0 ;;
  timeout) /bin/sleep "$2"; exit 28 ;;
  dies-during-probe) kill "$BACKEND_PID"; /bin/sleep 0.1; exit 28 ;;
esac
`, { mode: 0o755 })
      const proc = Bun.spawn(['/bin/bash', '-c', `set -euo pipefail
source "$HELPER"
/bin/sleep 60 & backend_pid=$!
export BACKEND_PID=$backend_pid
trap 'kill "$backend_pid" 2>/dev/null || true; wait "$backend_pid" 2>/dev/null || true' EXIT
if [ "$SCENARIO" = dead ]; then kill "$backend_pid"; wait "$backend_pid" 2>/dev/null || true; fi
wait_backend_ready "$backend_pid" "$BUDGET"
echo tests >> "$CALL_LOG"
`], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, HELPER: new URL('./ci-readiness.sh', import.meta.url).pathname, SCENARIO: scenario, BUDGET: scenario === 'timeout' ? '1' : '5', CALL_LOG: log }, stdout: 'pipe', stderr: 'pipe' })
      const started = Date.now()
      const status = await proc.exited
      const calls = existsSync(log) ? readFileSync(log, 'utf8') : ''
      expect(status).toBe(scenario === 'transient' ? 0 : scenario === 'timeout' ? 28 : 1)
      expect(calls.split('\n').filter(line => line === 'tests')).toHaveLength(scenario === 'transient' ? 1 : 0)
      if (scenario === 'dead') expect(calls).toBe('')
      if (scenario === 'transient') expect(calls.split('\n').filter(line => line.startsWith('--max-time'))).toHaveLength(2)
      if (scenario === 'timeout') { expect(calls).toContain('--max-time 1 '); expect(Date.now() - started).toBeLessThan(4000) }
      if (scenario === 'dies-during-probe') expect(calls.split('\n').filter(line => line.startsWith('--max-time'))).toHaveLength(1)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
}

for (const available of [true, false]) {
  test(`file fixture requires Files local storage: available=${available}`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'ios-file-fixture-'))
    try {
      const bin = join(root, 'bin'), storage = join(root, 'local storage'), source = join(root, 'upload.txt')
      mkdirSync(bin); mkdirSync(storage)
      writeFileSync(source, 'fixture payload\n')
      const exportDirectory = join(storage, 'File Provider Storage/Agentboard E2E Exports')
      mkdirSync(exportDirectory, { recursive: true })
      writeFileSync(join(exportDirectory, 'Document.pdf'), 'stale output')
      writeFileSync(join(exportDirectory, 'unrelated.pdf'), 'preserve')
      writeFileSync(join(bin, 'xcrun'), '#!/bin/bash\nprintf "group.com.apple.Other\\t/unused\\n"\nif [ "$AVAILABLE" = true ]; then printf "group.com.apple.FileProvider.LocalStorage\\t%s\\n" "$STORAGE"; fi\n', { mode: 0o755 })
      const proc = Bun.spawn(['/bin/bash', new URL('./seed-file.sh', import.meta.url).pathname, 'test-device', source], {
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, AVAILABLE: String(available), STORAGE: storage }, stdout: 'pipe', stderr: 'pipe',
      })
      expect(await proc.exited).toBe(available ? 0 : 1)
      const destination = join(storage, 'File Provider Storage/parity-upload.txt')
      if (available) {
        expect(readFileSync(destination, 'utf8')).toBe('fixture payload\n')
        expect(existsSync(join(exportDirectory, 'Document.pdf'))).toBe(false)
        expect(readFileSync(join(exportDirectory, 'unrelated.pdf'), 'utf8')).toBe('preserve')
      }
      else {
        expect(existsSync(destination)).toBe(false)
        expect(await new Response(proc.stderr).text()).toContain('Files local storage is unavailable')
      }
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
}

for (const output of ['correct', 'corrupt', 'missing'] as const) {
  test(`export verification rejects absent or different bytes: ${output}`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'ios-export-verification-'))
    try {
      const bin = join(root, 'bin'), storage = join(root, 'files'), expected = join(root, 'expected.pdf')
      const destination = join(storage, 'File Provider Storage/Agentboard E2E Exports/Document.pdf')
      mkdirSync(bin); mkdirSync(join(destination, '..'), { recursive: true })
      writeFileSync(expected, '%PDF-fixture-bytes')
      if (output !== 'missing') writeFileSync(destination, output === 'correct' ? '%PDF-fixture-bytes' : '%PDF-other-document')
      writeFileSync(join(bin, 'xcrun'), '#!/bin/bash\nprintf "group.com.apple.FileProvider.LocalStorage\\t%s\\n" "$STORAGE"\n', { mode: 0o755 })
      const proc = Bun.spawn(['/bin/bash', new URL('./verify-file-export.sh', import.meta.url).pathname, 'test-device', expected], {
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, STORAGE: storage }, stdout: 'pipe', stderr: 'pipe',
      })
      expect(await proc.exited).toBe(output === 'correct' ? 0 : output === 'missing' ? 2 : 1)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
}
