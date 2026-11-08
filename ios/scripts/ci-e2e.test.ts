import { expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { e2eFixtures } from './e2e-fixtures'

for (const scenario of [
  ...['terminal', 'catalog', 'lifecycle', 'media', 'settings'].map(shard => ({ shard, archiveFailure: false, testStatus: 37 })),
  { shard: 'catalog', archiveFailure: true, testStatus: 37 },
  { shard: 'catalog', archiveFailure: true, testStatus: 0 },
]) {
  const { shard, archiveFailure, testStatus } = scenario
  test(`CI orchestration ${shard}, tests=${testStatus}, archiveFailure=${archiveFailure}`, async () => {
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
      writeFileSync(join(scripts, 'ci-diagnostics.sh'), 'ci_diagnostics_start() { :; }; ci_diagnostics_stop() { echo stopped >> "$CALL_LOG"; }; ci_phase() { shift; "$@"; }\n')
      writeFileSync(join(scripts, 'test-e2e.sh'), '#!/bin/bash\necho tests >> "$CALL_LOG"\nexit ' + testStatus + '\n', { mode: 0o755 })
      const stub = (name: string, body: string) => writeFileSync(join(bin, name), '#!/bin/bash\necho "' + name + ' $*" >> "$CALL_LOG"\n' + body, { mode: 0o755 })
      stub('bun', `case "$1" in
        ios/scripts/e2e-fixtures.ts) printf '%s\\n' "$FIXTURES" ;;
        -e) cat >/dev/null; echo mock-udid ;;
        ios/scripts/seed-parity.ts) touch "$TMUX_TMPDIR/photo.png" "$TMUX_TMPDIR/upload.txt" ;;
        ios/scripts/seed-live.ts|ios/scripts/warm-parity.ts) ;;
        *) trap 'exit 0' TERM; while :; do /bin/sleep 0.05; done ;;
      esac\n`)
      stub('xcrun', 'if [[ "$*" == *get_app_container* ]]; then echo "$APP_DATA"; fi\n')
      if (archiveFailure) stub('mv', 'exit 74\n')
      stub('curl', 'exit 0\n'); stub('tmux', 'exit 0\n')
      const proc = Bun.spawn(['/bin/bash', join(scripts, 'ci-e2e.sh')], {
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CALL_LOG: log, APP_DATA: join(root, 'app'), IOS_TEST_PRODUCTS_DIR: join(root, 'products'), IOS_E2E_MODE: 'light', IOS_E2E_SHARD: shard, FIXTURES: e2eFixtures('light', shard).join('\n') }, stdout: 'pipe', stderr: 'pipe',
      })
      expect(await proc.exited).toBe(testStatus || (archiveFailure ? 74 : 0))
      const calls = readFileSync(log, 'utf8')
      const plan = e2eFixtures('light', shard)
      for (const [fixture, command] of Object.entries({ backend: 'bun src/server/index.ts', live: 'bun ios/scripts/seed-live.ts', parity: 'bun ios/scripts/seed-parity.ts', warm: 'bun ios/scripts/warm-parity.ts', 'shell-server': 'bun ios/scripts/shell-server.ts', 'pr-fixture': 'bun ios/scripts/pr-fixture.ts', 'parity-gap-fixture': 'bun ios/scripts/parity-gap-fixture.ts', 'media-activity-fixture': 'bun ios/scripts/media-activity-fixture.ts', photos: 'xcrun simctl addmedia', files: 'xcrun simctl get_app_container' })) {
        expect(calls.includes(command)).toBe(plan.includes(fixture as typeof plan[number]))
      }
      expect(calls).toContain('tests\n'); expect(calls).toContain('stopped\n')
      expect(calls).toContain(`tmux -S ${root}/fixtures/tmux-`)
      expect(readdirSync(join(root, 'archive'))).toHaveLength(archiveFailure ? 0 : 1)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
}
