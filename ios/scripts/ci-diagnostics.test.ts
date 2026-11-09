import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

function run(command: string) {
  const directory = mkdtempSync(join(tmpdir(), 'ios-ci-diagnostics-'));
  const result = Bun.spawnSync(['/bin/bash', '-c', `set -euo pipefail
source "$HELPER"
ci_diagnostics_start test
trap ci_diagnostics_stop EXIT
${command}`], {
    env: { ...process.env, HELPER: resolve(import.meta.dir, 'ci-diagnostics.sh'), IOS_CI_DIAGNOSTICS_DIR: directory },
  });
  const logs = Bun.spawnSync(['find', directory, '-name', 'phases.tsv']).stdout.toString().trim();
  const phases = readFileSync(logs, 'utf8');
  const resources = readFileSync(join(logs, '..', 'resources.log'), 'utf8');
  rmSync(directory, { recursive: true });
  return { result, phases, resources };
}

test('phase timing preserves stdout and stops resource sampling', () => {
  const { result, phases, resources } = run('sampler=$CI_DIAGNOSTICS_PID; value=$(ci_phase output printf hello); ci_diagnostics_stop; if kill -0 "$sampler" 2>/dev/null; then exit 99; fi; printf "%s" "$value"');
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  expect(result.stdout.toString()).toBe('hello');
  expect(phases).toMatch(/output\t[^\t]+\t\d+\t0/);
  expect(resources).toContain('phase=stop');
});

test('failed phases preserve status and stop compound functions at failure', () => {
  const { result, phases, resources } = run('fail() { return 37; echo must-not-run; }; ci_phase failure fail; echo must-not-run');
  expect(result.exitCode, result.stderr.toString()).toBe(37);
  expect(result.stdout.toString()).toBe('');
  expect(phases).toMatch(/failure\t[^\t]+\t\d+\t37/);
  expect(resources).toContain('phase=stop');
});


test('captured phases retain strict failure handling', () => {
  const { result, phases } = run('fail() { return 23; echo must-not-run; }; value=$(ci_phase captured fail); echo must-not-run');
  expect(result.exitCode, result.stderr.toString()).toBe(23);
  expect(result.stdout.toString()).toBe('');
  expect(phases).toMatch(/captured\t[^\t]+\t\d+\t23/);
});

test('phase boundaries write markers without running resource probes', () => {
  const { result, phases, resources } = run(`ci_snapshot() {
  case "$1" in *:start|*:end) echo unexpected-phase-probe >&2; return 91 ;; esac
}
value=$(ci_phase output printf hello)
printf '%s' "$value"
ci_phase failure /bin/bash -c 'exit 37'`);
  expect(result.exitCode, result.stderr.toString()).toBe(37);
  expect(result.stdout.toString()).toBe('hello');
  expect(result.stderr.toString()).not.toContain('unexpected-phase-probe');
  expect(phases).toMatch(/failure\t[^\t]+\t\d+\t37/);
  for (const marker of ['output:start', 'output:end', 'failure:start', 'failure:end']) {
    expect(resources).toContain(`phase=${marker}`);
  }
});
