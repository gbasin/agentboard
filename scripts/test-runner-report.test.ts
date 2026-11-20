import { expect, test } from 'bun:test'
import {
  abbreviate,
  type CommandResult,
  commandFailed,
  formatRunSummary,
  OutputScanner,
  stripAnsi,
} from './test-runner-report'

function result(overrides: Partial<CommandResult>): CommandResult {
  return {
    label: 'main batch',
    cmd: ['bun', 'test', 'a.test.ts'],
    exitCode: 0,
    signal: null,
    durationMs: 1500,
    failedTests: [],
    errorLines: [],
    tail: [],
    ...overrides,
  }
}

test('attributes bun (fail) lines to the file header that precedes them, across split chunks', () => {
  const scanner = new OutputScanner()
  scanner.push('stderr', 'src/server/__tests__/a.test.ts:\n(pass) ok [1ms]\n(fa')
  scanner.push('stdout', 'unrelated stdout line\n')
  scanner.push('stderr', 'il) suite > \x1b[1mbroken\x1b[0m [5.00ms]\n')
  scanner.push('stderr', '(fail) suite > broken [5.00ms]\n')
  scanner.finish()
  expect(scanner.failedTests).toEqual(['src/server/__tests__/a.test.ts > suite > broken [5.00ms]'])
  expect(scanner.tail).toContain('unrelated stdout line')
})

test('records node test failures, unhandled errors and crashes, and flushes the last partial line', () => {
  const scanner = new OutputScanner()
  scanner.push('stdout', '✖ failing tests:\n✖ release script rejects bad tags (3.2ms)\nnot ok 4 - install unit\n')
  scanner.push('stderr', '# Unhandled error between tests\n 2 errors\n 4 pass\n 0 fail\n 2 errors\n 0 errors\nRan 4 tests across 1 file.\n 3 errors\n')
  scanner.push('stderr', 'panic(main thread): Segmentation fault')
  scanner.finish()
  expect(scanner.failedTests).toEqual(['release script rejects bad tags (3.2ms)', 'install unit'])
  expect(scanner.errorLines).toEqual([
    '# Unhandled error between tests',
    '2 errors',
    'panic(main thread): Segmentation fault',
  ])
  expect(scanner.tail.at(-1)).toBe('panic(main thread): Segmentation fault')
})

test('keeps only a bounded tail', () => {
  const scanner = new OutputScanner()
  scanner.push('stdout', Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n') + '\n')
  expect(scanner.tail).toHaveLength(40)
  expect(scanner.tail[0]).toBe('line 60')
})

test('a clean run summarises as passed', () => {
  const results = [result({}), result({ label: 'isolated x' })]
  expect(results.some(commandFailed)).toBe(false)
  expect(formatRunSummary(results)).toContain('All 2 test commands passed.')
})

test('the summary names failing tests, signals, silent non-zero exits, and spawn errors', () => {
  const summary = formatRunSummary(
    [
      result({ exitCode: 1, failedTests: ['a.test.ts > broken'] }),
      result({ label: 'isolated crash', exitCode: null, signal: 'SIGSEGV', tail: ['last words'] }),
      result({ label: 'isolated silent', exitCode: 1, errorLines: ['1 error'], tail: ['Ran 3 tests'] }),
      result({ label: 'node', exitCode: null, spawnError: 'ENOENT: node' }),
      result({ label: 'fine' }),
    ],
    { loadAverage: 40, cpus: 10 }
  )
  expect(summary).toContain('4 of 5 test commands failed:')
  expect(summary).toContain('FAILED main batch (exit code 1 after 1.5s)')
  expect(summary).toContain('    - a.test.ts > broken')
  expect(summary).toContain('FAILED isolated crash (killed by SIGSEGV after 1.5s)')
  expect(summary).toContain('    | last words')
  expect(summary).toContain('  errors outside tests:\n    - 1 error')
  expect(summary).toContain('  no failing test was reported; last output lines:\n    | Ran 3 tests')
  expect(summary).toContain('FAILED node (could not start: ENOENT: node)')
  expect(summary).not.toContain('FAILED fine')
  expect(summary).toContain('oversubscribed')
  expect(formatRunSummary([result({ exitCode: 2 })], { loadAverage: 1, cpus: 10 })).not.toContain('oversubscribed')
})

test('long commands are abbreviated', () => {
  expect(abbreviate(['bun', 'test', 'a'])).toBe('bun test a')
  expect(abbreviate(['bun', 'test', ...Array.from({ length: 20 }, (_, i) => `f${i}`)], 3)).toBe('bun test f0 … (+19 more args)')
  expect(stripAnsi('\x1b[31mred\x1b[0m')).toBe('red')
})

test('ignores error-like text in test names and logs', () => {
  const scanner = new OutputScanner()
  scanner.push('stderr', '(pass) reports Unhandled error between tests [1ms]\n(skip) panic( handling\n    message: "Unhandled rejection"\n 1 error\n')
  scanner.finish()
  expect(scanner.errorLines).toEqual([])
})

test('the summary reports stream errors and truncated output', () => {
  const summary = formatRunSummary([
    result({ label: 'leaky', outputTruncated: true }),
    result({ label: 'epipe', exitCode: null, signal: 'SIGTERM', streamError: 'EPIPE', failedTests: ['x'] }),
    result({ label: 'leaky fail', exitCode: 1, outputTruncated: true, failedTests: ['y'] }),
  ])
  expect(summary).toContain('NOTE leaky: output truncated')
  expect(summary).toContain('reading output failed (EPIPE); the child was killed')
  expect(summary).toMatch(/FAILED leaky fail[^\n]*\n[^\n]*\n  output truncated/)
  expect(commandFailed(result({ streamError: 'EPIPE' }))).toBe(true)
})
